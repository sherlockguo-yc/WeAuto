/**
 * 常驻调度器 —— 决定「什么时候该跑」，执行本身交给注入的 execute
 *
 * 与执行器的职责切分（刻意分开，两边的失败模式不同）：
 *   · **调度器管时间**：到期了没有。它不关心任务内部、不碰凭据
 *   · **执行器管安全**：锁、幂等（当天已成功不重复跑）、凭据、超时、记录
 * 幂等在两侧都成立是有意的冗余：调度器可能因为重启重算，执行器那一层是最后一道闸。
 *
 * 三条重启语义（对应主文档 §5.2，都是「不要密集追补」的不同表现）：
 *   · 间隔类：错过的整轮直接跳过，重启后重新计时
 *   · 每天窗口：还在窗口内 → 补跑一次；窗口已过 → 等明天
 *   · 一次性：超过宽限期仍未执行 → 判定「已错过」，**不自动补跑**
 *     （否则凌晨三点的重启会突然向目标站点发请求）
 *
 * 调度器**不写「跳过」记录**：每 30 秒写一条「窗口已过」会瞬间淹掉执行历史。
 * 页面上的「今日未执行 / 已错过」由「计划 + 实际记录」推导，而不是靠冗余记录。
 */
import { dateInTZ, hhmmToSeconds, secondsToHHMM, startOfDayBeijingMs } from './util.mjs';
import { effectiveSchedule, targetSecondsOfDay } from './schedule.mjs';

export const TICK_MS = 30_000;

/** 一次性任务的宽限期：超过这么久仍未执行，就认为「已错过」而不是补跑 */
export const ONCE_GRACE_MS = 5 * 60_000;

/**
 * 纯函数：判断某个任务此刻是否到期。不做任何 IO，因此可以完整测边界。
 *
 * @param {object} args
 * @param {object} args.task 已规范化的任务
 * @param {object} args.state task_state 中的既有状态
 * @param {number} args.nowMs
 * @param {boolean} args.hasSuccessToday window 类：今天是否已成功（幂等依据）
 * @param {boolean} args.hasScheduledRun once 类：是否已被调度执行过
 * @param {() => number} [args.random] 仅用于间隔抖动；测试传固定值
 * @returns {{due: boolean, reason: string, nextState: object}}
 */
export function planTask({
  task,
  state = {},
  nowMs,
  hasSuccessToday = false,
  hasScheduledRun = false,
  random = Math.random,
}) {
  const sch = task.schedule;
  if (!sch) {
    return { due: false, reason: '未声明调度，只能手动触发', nextState: {} };
  }

  if (sch.kind === 'window') {
    const today = dateInTZ(new Date(nowMs));
    const target =
      state.today_date === today && state.today_target_ts
        ? state.today_target_ts
        : startOfDayBeijingMs(today) +
          targetSecondsOfDay(task.name, sch.window, today) * 1000;
    const nextState = { today_date: today, today_target_ts: target };
    const label = secondsToHHMM(
      Math.round((target - startOfDayBeijingMs(today)) / 1000),
    );

    if (hasSuccessToday) return { due: false, reason: '今日已完成', nextState };

    const windowEndMs = startOfDayBeijingMs(today) + hhmmToSeconds(sch.window.end) * 1000;
    if (nowMs > windowEndMs) {
      return {
        due: false,
        reason: `今日窗口已过（${sch.window.start}–${sch.window.end}），等明天`,
        nextState,
      };
    }
    if (nowMs < target) {
      return { due: false, reason: `未到今日目标时刻 ${label}`, nextState };
    }
    return { due: true, reason: `到达今日目标时刻 ${label}`, nextState };
  }

  if (sch.kind === 'every') {
    const intervalMs = sch.every.minutes * 60_000;
    const jitterMs = sch.every.jitterSec ? Math.floor(random() * sch.every.jitterSec * 1000) : 0;
    const next = state.next_due_ts ?? null;

    if (next == null) {
      return {
        due: false,
        reason: `已排入下一次（间隔 ${sch.every.minutes} 分钟）`,
        nextState: { next_due_ts: nowMs + intervalMs + jitterMs },
      };
    }
    if (nowMs < next) {
      return { due: false, reason: `未到间隔时刻`, nextState: { next_due_ts: next } };
    }
    return {
      due: true,
      reason: `到达间隔时刻（${sch.every.minutes} 分钟）`,
      nextState: { next_due_ts: nowMs + intervalMs + jitterMs },
    };
  }

  // once
  if (hasScheduledRun) {
    return { due: false, reason: '一次性任务已执行过', nextState: {} };
  }
  if (nowMs < sch.once.atMs) {
    return { due: false, reason: `等到 ${sch.once.atLabel}`, nextState: {} };
  }
  if (nowMs - sch.once.atMs > ONCE_GRACE_MS) {
    return {
      due: false,
      reason: `已错过计划时刻 ${sch.once.atLabel}，不自动补跑（可手动执行）`,
      nextState: {},
      missed: true,
    };
  }
  return { due: true, reason: `到达计划时刻 ${sch.once.atLabel}`, nextState: {} };
}

/** 全局并发上限：N 个用户同时到期时不能一次打出 N 路请求（需求文档 §4.4） */
export const MAX_CONCURRENT_RUNS = 4;

/**
 * @param {object} deps
 * @param {ReturnType<import('./store.mjs').createStore>} deps.store **根 store**（需要跨用户遍历订阅）
 * @param {Map<string, object>} deps.tasks 已规范化的模板（registry.loadTasks 的结果）
 * @param {(task: object, opts: {trigger: string, userId: number, accountKey: string}) => Promise<object|null>} deps.execute
 * @param {() => number} [deps.now] 便于测试注入
 * @param {number} [deps.tickMs]
 * @param {(msg: string) => void} [deps.log]
 * @param {() => number} [deps.random]
 * @param {number} [deps.maxConcurrent]
 */
export function createScheduler({
  store,
  tasks,
  execute,
  now = () => Date.now(),
  tickMs = TICK_MS,
  log = () => {},
  random = Math.random,
  maxConcurrent = MAX_CONCURRENT_RUNS,
}) {
  /** key = `${subscriptionId}:${accountKey}` —— 同一个订阅的两个账号互不影响 */
  const inFlight = new Map();
  /** 同一用户最多一个在飞：不希望一个人把自己的两个账号同时打向同一个站点 */
  const runningUsers = new Set();
  let timer = null;
  let ticking = false;

  /**
   * 待调度的目标 = 订阅 × 启用中的账号。
   *
   * 模板已下线（代码里删了文件）时 `tasks.get()` 拿不到定义，直接跳过——
   * 没有定义就没有 schedule，留着只会每 30 秒打一条找不到任务的日志。
   */
  function targets() {
    const out = [];
    for (const sub of store.allSubscriptions()) {
      if (!sub.enabled) continue;
      const task = tasks.get(sub.taskName);
      if (!task) continue;
      // 用户在订阅里改过的调度与超时优先于模板默认值——不然「配自己的时间」没有意义
      const { schedule } = effectiveSchedule(task, { schedule: sub.schedule });
      const effectiveTask = { ...task, schedule, timeoutMs: sub.timeoutMs ?? task.timeoutMs };
      for (const acc of sub.accounts) {
        if (!acc.enabled) continue;
        out.push({ sub, task: effectiveTask, acc, key: `${sub.id}:${acc.accountKey}` });
      }
    }
    return out;
  }

  /**
   * 启动时归一化「间隔类」的下次到期时刻。
   *
   * 为什么单独做这一步：如果把它交给 planTask，每次 tick 都会把「刚过期几十毫秒」
   * 也当成「错过了」而往后推一整个间隔，任务实际间隔会变成两倍。所以
   * 「重启不追补」只发生在启动那一刻。
   */
  function normalizeOnStart() {
    const nowMs = now();
    for (const { sub, task, acc } of targets()) {
      if (task.schedule?.kind !== 'every') continue;
      const mine = store.forUser(sub.userId);
      const intervalMs = task.schedule.every.minutes * 60_000;
      const next = mine.stateOf(sub.taskName, acc.accountKey).next_due_ts ?? null;
      if (next == null || next < nowMs) {
        mine.saveState(sub.taskName, acc.accountKey, { next_due_ts: nowMs + intervalMs });
        if (next != null) {
          log(`[scheduler] ${sub.taskName}/${acc.accountKey} 休息期间错过了 ${Math.round((nowMs - next) / 1000)}s，跳过本轮，重新计时`);
        }
      }
    }
  }

  /** 启动/手动触发的执行入口：处理互斥、并发闸门、异常兜底与状态回写 */
  function runNow({ sub, task, acc, key }, trigger) {
    if (inFlight.has(key)) return null;
    if (inFlight.size >= maxConcurrent) return null;
    if (runningUsers.has(sub.userId)) return null;

    const mine = store.forUser(sub.userId);
    const promise = (async () => {
      try {
        const record = await execute(task, { trigger, userId: sub.userId, accountKey: acc.accountKey });
        if (record?.id) mine.saveState(sub.taskName, acc.accountKey, { last_run_id: record.id });
        return record;
      } catch (err) {
        // 执行器内部已兜住任务异常；能到这里说明是框架层的意外，绝不能让调度器停摆
        log(`[error] ${sub.taskName} 执行时抛出异常：${err.message}`);
        return null;
      } finally {
        inFlight.delete(key);
        runningUsers.delete(sub.userId);
      }
    })();

    inFlight.set(key, promise);
    runningUsers.add(sub.userId);
    return promise;
  }

  /** 走一遍全部目标。不做等待：任务之间是并行的，慢任务不应拖住别的任务 */
  function tick() {
    if (ticking) return { skipped: '上一轮 tick 尚未结束', started: [] };
    ticking = true;
    const started = [];
    try {
      const nowMs = now();
      const today = dateInTZ(new Date(nowMs));
      for (const target of targets()) {
        const { sub, task, acc, key } = target;
        if (inFlight.has(key)) continue;
        if (inFlight.size >= maxConcurrent) break;

        const mine = store.forUser(sub.userId);
        const plan = planTask({
          task,
          state: mine.stateOf(sub.taskName, acc.accountKey),
          nowMs,
          hasSuccessToday: task.schedule?.kind === 'window'
            ? mine.hasSuccessOn(sub.taskName, today, acc.accountKey)
            : false,
          hasScheduledRun:
            task.schedule?.kind === 'once' ? mine.hasScheduledRun(sub.taskName, acc.accountKey) : false,
          random,
        });

        if (Object.keys(plan.nextState).length) {
          mine.saveState(sub.taskName, acc.accountKey, plan.nextState);
        }
        if (!plan.due) continue;

        if (runNow(target, 'schedule')) started.push(`${sub.taskName}:${acc.accountKey}`);
      }
      return { started };
    } finally {
      ticking = false;
    }
  }

  return {
    /** 启动：先归一化状态，再按 tickMs 周期检查 */
    start() {
      if (timer) return;
      normalizeOnStart();
      timer = setInterval(() => tick(), tickMs);
      // 常驻进程不该被这个定时器拖住退出
      if (typeof timer.unref === 'function') timer.unref();
      log(`[scheduler] 已启动，每 ${Math.round(tickMs / 1000)}s 检查一次（${targets().length} 个调度目标，并发上限 ${maxConcurrent}）`);
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      log('[scheduler] 已停止');
    },

    tick,
    normalizeOnStart,

    /**
     * 手动触发：跳过调度判断，但仍然受幂等与锁保护（除非 force）。
     * 必须带 userId——「跑谁的那个账号」在多租户下不能靠猜。
     */
    trigger(taskName, { userId, accountKey = '', force = true } = {}) {
      const task = tasks.get(taskName);
      if (!task) throw new Error(`未知任务 "${taskName}"`);
      const sub = store.forUser(userId).getSubscription(taskName);
      if (!sub) throw new Error(`用户 ${userId} 还没有订阅 "${taskName}"`);
      const acc = sub.accounts.find((a) => a.accountKey === accountKey)
        ?? (accountKey === '' ? sub.accounts[0] : null);
      if (!acc) throw new Error(`账号 "${accountKey}" 不存在`);
      const { schedule } = effectiveSchedule(task, { schedule: sub.schedule });
      return runNow(
        {
          sub,
          task: { ...task, schedule, timeoutMs: sub.timeoutMs ?? task.timeoutMs },
          acc,
          key: `${sub.id}:${acc.accountKey}`,
        },
        'manual',
      );
    },

    isRunning: (taskName, userId, accountKey = '') => {
      if (userId == null) return false;
      const sub = store.forUser(userId).getSubscription(taskName);
      return sub ? inFlight.has(`${sub.id}:${accountKey}`) : false;
    },
    /** 供测试与优雅退出使用 */
    waitForIdle: () => Promise.allSettled([...inFlight.values()]),
  };
}
