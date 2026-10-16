/**
 * 任务的「当前状态」读取模型
 *
 * 界面上的「今天待执行 / 已成功 / 已失败 / 已错过 / 已停止」**不是存出来的**，
 * 而是由「计划（任务自带的调度 + 我自己改过的）+ 实际记录」推导出来的。
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
  /** 任务的身份：id 用于链接与操作，accountKey 是执行侧的维度（凭据/状态/历史按它分） */
  id = null,
  accountKey = '',
  label = '',
  /** 我对这个任务设的启停 / 调度 / 超时。由调用方从任务行取好传进来 */
  config = null,
  /** 这个任务还缺哪些凭据字段。由调用方传入——本模块不碰凭据存储 */
  missingCredentials = [],
}) {
  const enabled = config?.enabled ?? false;
  const { schedule, overrideInvalid } = effectiveSchedule(task, config);
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
  // 状态 key 沿用 'disabled'（历史与测试都认它），界面上叫「已停止」
  let todayStatus;
  if (!enabled) todayStatus = 'disabled';
  else if (hasSuccessToday) todayStatus = 'success';
  else if (lastRun && lastRun.date === today && lastRun.status !== 'skipped') todayStatus = lastRun.status;
  else if (plan.missed) todayStatus = 'missed';
  else if (!schedule) todayStatus = 'manual';
  else todayStatus = 'pending';

  return {
    id,
    name: task.name,
    displayName: task.displayName,
    accountKey,
    /** 任务名：用户给这个任务起的名字，没起就用模板名 */
    label: label || task.displayName,
    description: task.description,
    group: task.group,
    tags: task.tags,
    requires: task.requires,
    accounts: task.accounts,
    timeoutMs: config?.timeoutMs ?? task.timeoutMs,
    view: task.view,
    file: task.file,
    enabled,
    /** 我有没有给这个任务配过东西（启动过 / 改过时间 / 填过账号） */
    configured: !!config,
    /**
     * 我**改过**调度没有。注意不能拿「有没有配置行」当这个信号——
     * 建任务就一定有一行，那个值恒为真。真正的信号是「这一行里存了自定义调度」：
     * 选「跟随模板默认」会把 schedule 存成 null，那时就该按「没改过」显示。
     */
    scheduleCustomized: !!config?.schedule,
    overrideInvalid,
    hasConfig: !!config,
    missingCredentials,
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
 * 我建的任务的当前状态。
 *
 * 粒度是**任务**：一个任务 = 一个账号，建了几个就产出几项。
 * 模板本身不产出项——模板回答的是「可以建什么」，在任务页顶部单独展示；
 * 没建过的模板不该混进「我的任务」里（以前那样做的结果是新用户一进来
 * 就看到一堆他根本没启动过的「已停止」行）。
 */
export function summarizeAll({
  tasks,
  store,
  nowMs = Date.now(),
  random = Math.random,
  /** (taskName, accountKey) => string[]，用于标出「还没填凭据」的任务 */
  missingCredentials = null,
}) {
  const items = [];
  for (const t of store.listTasks()) {
    const task = tasks.get(t.taskName);
    // 模板已从注册表移除（tasks/ 下的文件删了）：没有定义就没有调度，跳过
    if (!task) continue;
    items.push(
      summarizeTask({
        task,
        store,
        nowMs,
        random,
        id: t.id,
        accountKey: t.accountKey,
        label: t.label,
        config: { enabled: t.enabled, schedule: t.schedule, timeoutMs: t.timeoutMs },
        missingCredentials: missingCredentials ? missingCredentials(t.taskName, t.accountKey) : [],
      }),
    );
  }
  items.sort(
    (a, b) => a.group.localeCompare(b.group, 'zh') || a.name.localeCompare(b.name) || a.id - b.id,
  );

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
  // 没启动过的任务不参与统计：它们一律是「已停止」，
  // 算进来的话新用户登录后首页会显示一堆他根本没启动过的东西。
  const mine = items.filter((it) => it.configured);
  for (const it of mine) {
    if (it.todayStatus in byStatus) byStatus[it.todayStatus] += 1;
    else byStatus.failed += 1; // 其它非成功状态一律计入「需要注意」
  }

  /*
   * 「今天出事了」的清单：失败 / 被拦 / 网络错 / 配置错 / 已错过。
   *
   * **故意不含「已停止」**：停止是用户自己按的，不是今天出的状况，
   * 而且它没有「今天」的边界——上周停掉的任务今天还挂在这儿，
   * 于是这张卡永远有一条，反而把真出事的那条挤下去。
   * 「我停着几个」的回答在顶部统计的「停止/手动」里，那里才是它的位置。
   */
  const attention = mine.filter((it) =>
    ['failed', 'blocked', 'network-error', 'config-error', 'missed'].includes(it.todayStatus),
  );

  /*
   * 「最近执行」必须与任务详情的历史是同一批记录、同一套展示口径：
   * 以前这里只给原始 run（任务名是模板名、没有时间、多账号时分不清哪个账号），
   * 详情页却显示时间和账号，同一条记录在两处长得不一样，用户没法对照。
   * 所以在这里把展示要用的名字补齐——items 里已经有每个账号的元信息，不必再查库。
   * 任务已从注册表移除时（items 里没有）退回原始任务名。
   */
  const metaByAccount = new Map(items.map((it) => [`${it.name}@${it.accountKey}`, it]));
  const recent = store.recentRuns(20).map((r) => {
    const it = metaByAccount.get(`${r.task}@${r.accountKey}`);
    return {
      ...r,
      taskLabel: it?.label ?? r.task,
      taskId: it?.id ?? null,
    };
  });

  return { today, items, byStatus, attention, recent };
}
