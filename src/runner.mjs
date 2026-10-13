/**
 * 任务执行器 —— 锁 → 调度门禁 → 幂等检查 → 解密凭据 → 执行 → 落记录
 */
import { SUCCESS_STATUSES, appendRun, hasSuccessOn } from './history.mjs';
import { CookieJar, request } from './http.mjs';
import { acquireLock } from './lock.mjs';
import { getTask } from './registry.mjs';
import { shouldRunNow } from './schedule.mjs';
import { SecretsError, loadSecrets } from './secrets.mjs';
import { LOCK_FILE, dateInTZ, ensureDataDir, timestampInTZ } from './util.mjs';

const STATUS = {
  SUCCESS: 'success',
  ALREADY: 'already-signed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  NETWORK: 'network-error',
  CONFIG: 'config-error',
};

/** 进程内硬超时，远小于 WeMonitor cron-runner 的 10 分钟 */
const TASK_TIMEOUT_MS = 60_000;


/* ───────────────────────── 执行 ───────────────────────── */

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * 执行任务
 * @param {string} taskName
 * @param {{force?: boolean, log?: Function}} opts
 */
export async function runTask(taskName, opts = {}) {
  const { force = false, log = console.log } = opts;

  const task = await getTask(taskName);
  ensureDataDir();
  const release = acquireLock(LOCK_FILE);
  if (!release) {
    const msg = '另一个实例正在运行，本次跳过';
    log(`[skipped] ${msg}`);
    return { status: STATUS.SKIPPED, task: taskName, message: msg, locked: true };
  }

  const startedAt = Date.now();
  const date = dateInTZ(new Date(startedAt));
  let gate = null;

  try {
    /* 调度门禁与幂等检查（--force 时全部跳过，供手动触发/调试） */
    if (!force && task.schedule?.window) {
      gate = shouldRunNow(taskName, task.schedule.window);
      if (!gate.reached) {
        const msg = `未到今日目标时刻 ${gate.targetLabel}（当前 ${timestampInTZ().slice(11, 16)}）`;
        log(`[skipped] ${msg}`);
        return { status: STATUS.SKIPPED, task: taskName, date, message: msg };
      }
      if (hasSuccessOn(taskName, date)) {
        const msg = `今日已完成（${date}），不再重复执行`;
        log(`[skipped] ${msg}`);
        return { status: STATUS.SKIPPED, task: taskName, date, message: msg };
      }
    }

    /* 执行 */
    log(`[run] ${task.displayName ?? taskName} 开始（${timestampInTZ()}）`);
    let result;
    try {
      const secrets = loadSecrets(task.requires ?? []);
      const ctx = {
        secrets,
        request,
        CookieJar,
        log,
        now: new Date(),
      };
      result = await withTimeout(task.run(ctx), TASK_TIMEOUT_MS, taskName);
    } catch (err) {
      if (err instanceof SecretsError) {
        result = { status: STATUS.CONFIG, message: err.message };
      } else {
        result = { status: STATUS.NETWORK, message: err.message };
      }
    }

    const record = {
      ts: Math.floor(startedAt / 1000),
      time: timestampInTZ(new Date(startedAt)),
      date,
      task: taskName,
      status: result.status ?? STATUS.FAILED,
      message: result.message ?? '',
      data: result.data ?? null,
      dur: Date.now() - startedAt,
      ...(force ? { force: true } : {}),
      ...(gate ? { target: gate.targetLabel } : {}),
    };

    appendRun(record);
    log(`[${record.status}] ${record.message}`);
    return record;
  } finally {
    release();
  }
}

export { STATUS };
