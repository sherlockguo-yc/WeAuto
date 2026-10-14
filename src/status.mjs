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
import { normalizeSchedule } from './task-contract.mjs';
import { planTask } from './scheduler.mjs';
import { dateInTZ } from './util.mjs';

/** 覆盖层里的调度声明如果坏了，退回代码文件的默认值，但**明确标出来** */
function effectiveSchedule(task, override) {
  if (!override?.schedule) return { schedule: task.schedule, overrideInvalid: false };
  try {
    return { schedule: normalizeSchedule(task.name, override.schedule), overrideInvalid: false };
  } catch {
    return { schedule: task.schedule, overrideInvalid: true };
  }
}

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
 * @returns {object} 供 API 与页面直接使用
 */
export function summarizeTask({ task, store, nowMs, random = Math.random }) {
  const override = store.getOverride(task.name);
  const enabled = override?.enabled ?? true;
  const { schedule, overrideInvalid } = effectiveSchedule(task, override);
  const effectiveTask = { ...task, schedule };

  const today = dateInTZ(new Date(nowMs));
  const hasSuccessToday = store.hasSuccessOn(task.name, today);
  const plan = planTask({
    task: effectiveTask,
    state: store.stateOf(task.name),
    nowMs,
    hasSuccessToday,
    hasScheduledRun: schedule?.kind === 'once' ? store.hasScheduledRun(task.name) : false,
    random,
  });

  const [lastRun] = store.runsOfTask(task.name, 1);
  const lastSuccess = store.lastSuccess(task.name);

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
    description: task.description,
    group: task.group,
    tags: task.tags,
    requires: task.requires,
    accounts: task.accounts,
    timeoutMs: override?.timeoutMs ?? task.timeoutMs,
    view: task.view,
    file: task.file,
    enabled,
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

export function summarizeAll({ tasks, store, nowMs = Date.now(), random = Math.random }) {
  const items = [...tasks.values()]
    .map((task) => summarizeTask({ task, store, nowMs, random }))
    .sort((a, b) => a.group.localeCompare(b.group, 'zh') || a.name.localeCompare(b.name));

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
  for (const it of items) {
    if (it.todayStatus in byStatus) byStatus[it.todayStatus] += 1;
    else byStatus.failed += 1; // 其它非成功状态一律计入「需要注意」
  }

  // 「今天出事了」的清单：失败/被拦/已错过/停用，首页只关心这些
  const attention = items.filter((it) =>
    ['failed', 'blocked', 'network-error', 'config-error', 'missed', 'disabled'].includes(it.todayStatus),
  );

  return { today, items, byStatus, attention, recent: store.recentRuns(20) };
}
