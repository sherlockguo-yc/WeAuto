/**
 * 执行器（常驻服务用）—— 把一次任务执行落进数据库
 *
 * 与调度器的分工：调度器只管时间，本模块管「安全」：
 *   · 幂等：调度触发时当天已成功就不再执行（手动触发不受它限制）
 *   · 凭据：只解密任务声明的字段
 *   · 超时：用任务自己声明的 timeoutMs
 *   · 记录：结果与日志都进库，界面才有东西可看
 *
 * 与 `src/runner.mjs`（CLI 用、写 JSONL）暂时并存：CLI 路径是当前每天在跑签到的
 * 那条路，不动它以免打断线上；等 P2c 把历史导入数据库后统一成一条。
 */
import { CookieJar, request } from './http.mjs';
import { SecretsError, loadSecrets } from './secrets.mjs';
import { STATUS } from './task-contract.mjs';
import { dateInTZ } from './util.mjs';

/** 单次运行最多保留多少行日志（日志是最容易失控的一项） */
export const MAX_LOG_LINES = 200;
export const MAX_LOG_LINE_LEN = 2000;

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {(keys: string[]) => Record<string,string>} [deps.secretsLoader] 便于测试注入
 * @param {() => number} [deps.now]
 * @param {(msg: string) => void} [deps.log]
 */
export function createExecutor({ store, secretsLoader = loadSecrets, now = () => Date.now(), log = () => {} }) {
  /**
   * @param {object} task 已规范化任务
   * @param {{trigger?: 'schedule'|'manual'}} [opts]
   * @returns {Promise<object|null>} null 表示「这次不需要执行」
   */
  return async function execute(task, { trigger = 'schedule' } = {}) {
    const startedAt = now();
    const date = dateInTZ(new Date(startedAt));

    // 幂等：调度触发时当天已成功就跳过。手动触发不拦（用户就是想再跑一次）
    if (trigger === 'schedule' && store.hasSuccessOn(task.name, date)) {
      log(`[skip] ${task.name} 今日已完成，不再执行`);
      return null;
    }

    const lines = [];
    const record = (msg) => {
      if (lines.length < MAX_LOG_LINES) lines.push(String(msg).slice(0, MAX_LOG_LINE_LEN));
    };

    const ctx = {
      secrets: {},
      account: null, // 多账号预留在契约里，当前恒为 null
      request,
      CookieJar,
      log: record,
      now: new Date(startedAt),
    };

    let result;
    try {
      ctx.secrets = task.requires.length ? secretsLoader(task.requires) : {};
      record(`开始执行 ${task.displayName}（${trigger === 'manual' ? '手动' : '调度'}）`);
      result = await withTimeout(task.run(ctx), task.timeoutMs, task.name);
    } catch (err) {
      // 凭据问题与网络问题分开记：界面上的处置方式完全不同
      result =
        err instanceof SecretsError
          ? { status: STATUS.CONFIG, message: err.message }
          : { status: STATUS.NETWORK, message: err.message };
    }

    const saved = store.appendRun({
      taskName: task.name,
      date,
      ts: startedAt,
      status: result?.status ?? STATUS.FAILED,
      message: result?.message ?? '',
      data: result?.data ?? null,
      dur: now() - startedAt,
      trigger,
    });

    if (lines.length) store.appendLogs(saved.id, task.name, lines, startedAt);

    log(`[${saved.status}] ${saved.message}`);
    return saved;
  };
}
