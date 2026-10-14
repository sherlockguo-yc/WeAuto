/**
 * 种子化随机调度
 *
 * 需求：每天在窗口内（默认北京时间 09:00–09:50）执行，但**每天的偏移不同**，
 *       避免固定时刻被识别为机器行为。
 *
 * 为什么不用 sleep：
 *   WeMonitor 的 cron-runner.js 用 execSync 同步等待且硬超时 10 分钟，
 *   sleep 方案偏移上限被卡死，且睡眠期间进程被 kill 就会丢掉当天签到。
 *
 * 本方案：crontab 在窗口内多次触发，任务用「任务名+日期」做种子的哈希
 *         算出一个当日固定的目标时刻，未到点直接退出。
 *   → 不阻塞进程；天然幂等；被中断后下次触发可自愈。
 */
import crypto from 'node:crypto';
import { normalizeSchedule } from './task-contract.mjs';
import { dateInTZ, hhmmToSeconds, secondsOfDayInTZ, secondsToHHMM } from './util.mjs';

/**
 * 模板自带的调度 vs 用户在订阅里改过的调度，取后者。
 *
 * 以前只有「全站一份覆盖层」，这个函数待在 status.mjs 里就够了；
 * 多租户后调度器也必须遵守用户配的时间（否则「配自己的时间」形同虚设），
 * 所以提到这里两边共用。
 *
 * 覆盖值解析失败时**退回模板默认**并标记 invalid，而不是让整个任务消失——
 * 界面要能显示「你配的那条有问题，当前按默认跑」。
 */
export function effectiveSchedule(task, override) {
  if (!override?.schedule) return { schedule: task.schedule, overrideInvalid: false };
  try {
    // 库里存的是**规范化后**的调度（带 kind），而 normalizeSchedule 收的是**原始声明**
    // （只有 window / once / every 之一，kind 会被当成未知字段而报错）。
    // 先把 kind 摘出来，再校验两者是否一致——不一致说明数据被改坏了。
    const { kind, ...declared } = override.schedule;
    const schedule = normalizeSchedule(task.name, declared);
    if (kind && schedule && schedule.kind !== kind) {
      return { schedule: task.schedule, overrideInvalid: true };
    }
    return { schedule, overrideInvalid: false };
  } catch {
    return { schedule: task.schedule, overrideInvalid: true };
  }
}

/**
 * 计算某任务在指定日期的目标执行时刻（自午夜起的秒数）
 * 同一任务同一天结果恒定 —— 这是幂等与可测试的基础。
 */
export function targetSecondsOfDay(taskName, window, date) {
  const start = hhmmToSeconds(window.start);
  const end = hhmmToSeconds(window.end);
  if (end <= start) {
    throw new Error(`调度窗口非法：${window.start} – ${window.end}（结束须晚于开始）`);
  }
  const digest = crypto.createHash('sha256').update(`${taskName}:${date}`).digest();
  return start + (digest.readUInt32BE(0) % (end - start));
}

/**
 * 判断此刻是否该执行
 * @returns {{date: string, target: number, targetLabel: string, current: number, reached: boolean}}
 */
export function shouldRunNow(taskName, window, now = new Date()) {
  const date = dateInTZ(now);
  const target = targetSecondsOfDay(taskName, window, date);
  const current = secondsOfDayInTZ(now);
  return {
    date,
    target,
    targetLabel: secondsToHHMM(target),
    current,
    reached: current >= target,
  };
}

/** 供 CLI 展示：某个任务今日的预期执行时刻 */
export function describeWindow(taskName, window, now = new Date()) {
  const date = dateInTZ(now);
  const target = targetSecondsOfDay(taskName, window, date);
  return {
    date,
    window: `${window.start}–${window.end}`,
    targetLabel: secondsToHHMM(target),
    remaining: secondsToHHMM(Math.max(0, target - secondsOfDayInTZ(now))),
  };
}
