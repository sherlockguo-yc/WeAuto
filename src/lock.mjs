/**
 * 进程锁 —— 保证同一任务在同一台机器上不会并发执行
 *
 * 单独成模块（而非内联在 runner 里）是为了可测：锁的正确性完全依赖
 * 「文件何时被创建、内容何时写入」这类时序细节，只有能直接指定锁文件路径
 * 才能覆盖到边界场景。
 *
 * 两条设计要点都必须保留，都是踩过的坑：
 *
 * 1. **年龄兜底** —— 超过 `LOCK_MAX_AGE_MS` 的锁一律视为可回收。任务硬超时
 *    只有 60s，任何合法持锁都远小于此值。这道兜底解决两个死角：
 *      · PID 被系统复用给无关进程 → `process.kill(pid, 0)` 误判「持有者存活」
 *        → 锁永远回收不掉，任务从此再也不执行（静默失效）
 *      · 持有者在 `openSync` 与 `writeSync` 之间崩溃 → 留下 0 字节锁文件
 *
 * 2. **空内容视为「正被持有」** —— 必须排在年龄兜底之后生效。早期实现把
 *    0 字节锁文件判为「陈旧锁」并回收，导致两个进程同时执行：手动连续触发
 *    两次即可命中（2026-10-13 实测记录复现，两次执行时间区间重叠）。
 */
import fs from 'node:fs';

export const LOCK_MAX_AGE_MS = 5 * 60_000;

/**
 * 判定锁的当前状态
 * @param {string} file 锁文件路径
 * @returns {'absent' | 'stale' | 'held'}
 *   absent = 文件不存在，可获取；stale = 陈旧锁，可回收；held = 正被持有
 */
export function lockState(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return 'absent';
  }

  // 先做年龄兜底，再判断持有者存活 —— 顺序不能反，PID 复用会让存活判断失真
  if (Date.now() - st.mtimeMs > LOCK_MAX_AGE_MS) return 'stale';

  let pid;
  try {
    pid = Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return 'stale'; // 读取瞬间被其他进程删除 → 当作不存在
  }

  // 内容尚未写入（openSync 成功与 writeSync 之间的窗口）→ 必须视为「正被持有」。
  // 绝不能当陈旧锁回收 —— 那会让两个进程同时执行。
  if (!Number.isInteger(pid) || pid <= 0) return 'held';

  try {
    process.kill(pid, 0); // 进程存活则不抛错
    return 'held';
  } catch (err) {
    // ESRCH：持有者已消失 → 陈旧锁可回收
    // EPERM 等其余错误：保守视为仍被持有
    return err.code === 'ESRCH' ? 'stale' : 'held';
  }
}

/**
 * 取得进程锁
 * @param {string} file 锁文件路径（其所在目录必须已存在）
 * @returns {(() => void) | null} 释放函数；null 表示已被其他实例持有
 */
export function acquireLock(file) {
  // 最多两轮：第一轮若撞上陈旧锁就清掉，第二轮重新创建
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* 已被清理 */
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (attempt > 0) return null;
      if (lockState(file) !== 'stale') return null;
      try {
        fs.unlinkSync(file);
      } catch {
        /* 竞争下已被他人清理 */
      }
    }
  }
  return null;
}
