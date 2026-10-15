/**
 * 任务的「当前状态」读取模型
 *
 * 界面上的「今天待执行 / 已成功 / 已失败 / 已错过 / 已停用」**不是存出来的**，
 * 而是由「计划（调度声明 + 覆盖层）+ 实际记录」推导出来的。
 *
 * 为什么不把状态存进库：状态是会过期的东西（过了今天就不是「待执行」了），
 * 存下来就必须有人负责刷新它，早晚会出现「库里写着待执行、其实早就过了窗口」。
 * 推导出来的状态永远自洽。
 *
 * API 与页面共用这里的函数，避免两边对「今天的口径」理解不一致。
 */
import { effectiveSchedule } from './schedule.mjs';
import { planTask } from './scheduler.mjs';
import { dateInTZ } from './util.mjs';

/** 调度声明的人话描述 */
export function describeSchedule(schedule) {
  if (!schedule) return '仅手动触发';
  if (schedule.kind === 'window') return `每天 ${schedule.window.start}–${schedule.window.end} 内随机`;
  if (schedule.kind === 'every') {
    const { minutes, jitterSec } = schedule.every;
    return `每 ${minutes} 分钟${jitterSec ? `（±${jitterSec}s）` : ''}`;
  }
  if (schedule.kind === 'once') return `仅在 ${schedule.once.atLabel} 执行一次`;
  return '未知调度';
}

/**
 * 单个任务的当前状态
 *
 * 传入的 `store` 必须是**用户视图**（`store.forUser(userId)` 的结果），
 * 这样「某人的任务状态」不会读到别人的记录——是本模块唯一的前提。
 *
 * @param {string} [accountKey] 多账号模板要按账号分别统计；单账号模板用 ''
 * @returns {object} 供 API 与页面直接使用
 */
export function summarizeTask({
  task,
  store,
  nowMs,
  random = Math.random,
  accountKey = '',
  accountLabel = '',
  accountCount = 1,
  accountEnabled = true,
}) {
  const override = store.getOverride(task.name);
  // 未订阅 = 不存在这个实例，界面上就是「未启用」（不再是旧的「默认启用」）
  // 多账号时每个账号还能单独停用
  const enabled = (override?.enabled ?? false) && accountEnabled;
  const { schedule, overrideInvalid } = effectiveSchedule(task, override);
  const effectiveTask = { ...task, schedule };

  const today = dateInTZ(new Date(nowMs));
  const hasSuccessToday = store.hasSuccessOn(task.name, today, accountKey);
  const plan = planTask({
    task: effectiveTask,
    state: store.stateOf(task.name, accountKey),
    nowMs,
    hasSuccessToday,
    hasScheduledRun: schedule?.kind === 'once' ? store.hasScheduledRun(task.name, accountKey) : false,
    random,
  });

  const [lastRun] = store.runsOfTask(task.name, { accountKey, limit: 1 });
  const lastSuccess = store.lastSuccess(task.name, accountKey);

  // 今日状态：先看记录，再看计划。记录优先，因为它是发生过的事实
  let todayStatus;
  if (!enabled) todayStatus = 'disabled';
  else if (hasSuccessToday) todayStatus = 'success';
  else if (lastRun && lastRun.date === today && lastRun.status !== 'skipped') todayStatus = lastRun.status;
  else if (plan.missed) todayStatus = 'missed';
  else if (!schedule) todayStatus = 'manual';
  else todayStatus = 'pending';

  return {
    name: task.name,
    displayName: task.displayName,
    accountKey,
    accountLabel,
    accountCount,
    description: task.description,
    group: task.group,
    tags: task.tags,
    requires: task.requires,
    accounts: task.accounts,
    timeoutMs: override?.timeoutMs ?? task.timeoutMs,
    view: task.view,
    file: task.file,
    enabled,
    subscribed: !!override,
    overrideInvalid,
    hasOverride: !!override,
    schedule,
    scheduleLabel: describeSchedule(schedule),
    today,
    todayStatus,
    todayTargetLabel:
      schedule?.kind === 'window' && plan.nextState.today_target_ts
        ? new Date(plan.nextState.today_target_ts).toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : null,
    planReason: plan.reason,
    lastRun: lastRun ?? null,
    lastSuccess: lastSuccess ?? null,
  };
}

/**
 * 全部模板的当前状态。
 *
 * 粒度是**账号**而不是模板：一个订阅下配了 3 个账号就产出 3 项，
 * 各自有自己的今日状态与历史。这样列表里「每个账号一行」不需要前端再拆，
 * 单账号的模板仍然只有一项，跟以前看到的一样。
 *
 * 未订阅的模板也产出一项（`subscribed: false`），供模板市场显示「启用」按钮。
 */
export function summarizeAll({ tasks, store, nowMs = Date.now(), random = Math.random }) {
  const items = [];
  for (const task of [...tasks.values()].sort((a, b) =>
    a.group.localeCompare(b.group, 'zh') || a.name.localeCompare(b.name),
  )) {
    const sub = store.getSubscription(task.name);
    if (!sub) {
      items.push(summarizeTask({ task, store, nowMs, random, accountKey: '' }));
      continue;
    }
    for (const acc of sub.accounts) {
      items.push(
        summarizeTask({
          task,
          store,
          nowMs,
          random,
          accountKey: acc.accountKey,
          accountLabel: acc.label,
          accountCount: sub.accounts.length,
          accountEnabled: acc.enabled,
        }),
      );
    }
  }

  const today = dateInTZ(new Date(nowMs));
  const byStatus = {
    success: 0,
    pending: 0,
    disabled: 0,
    manual: 0,
    missed: 0,
    failed: 0,
    blocked: 0,
  };
  // 没启用的模板不参与统计：多租户下「未订阅」也是 disabled，
  // 算进来的话新用户登录后首页会显示一堆他根本没启用的东西。
  const mine = items.filter((it) => it.subscribed);
  for (const it of mine) {
    if (it.todayStatus in byStatus) byStatus[it.todayStatus] += 1;
    else byStatus.failed += 1; // 其它非成功状态一律计入「需要注意」
  }

  // 「今天出事了」的清单：失败/被拦/已错过/停用，首页只关心这些
  const attention = mine.filter((it) =>
    ['failed', 'blocked', 'network-error', 'config-error', 'missed', 'disabled'].includes(it.todayStatus),
  );

  return { today, items, byStatus, attention, recent: store.recentRuns(20) };
}
