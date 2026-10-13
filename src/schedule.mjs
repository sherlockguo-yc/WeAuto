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
import { dateInTZ, hhmmToSeconds, secondsOfDayInTZ, secondsToHHMM } from './util.mjs';

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
