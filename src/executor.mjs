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
import { CookieJar, createRequester } from './http.mjs';
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
 * 取这个用户的 store 视图。
 *
 * 两种传法：
 *   · 根 store + userId → `store.forUser(userId)`
 *   · 已绑定的用户视图 → 直接用
 *
 * 根 store 却不带 userId 时**直接报错**而不是退回根 store：
 * 那样只会在后面 appendRun 时抛「方法不存在」，离真正的错因太远，很难查。
 */
function userStore(store, userId) {
  if (typeof store.forUser !== 'function') return store; // 已经是用户视图
  if (userId == null) throw new Error('执行任务必须指定 userId（多租户下没有「不指定用户」的执行）');
  return store.forUser(userId);
}

/**
 * @param {object} deps
 * @param {object} deps.store 根 store（或已绑定的用户视图）
 * @param {(args: {userId: number|null, taskName: string, credentialId: number|null, requires: string[]}) => Record<string,string>} [deps.secretsLoader]
 *        默认取全站凭据（单租户遗留路径）；多租户下应注入每用户凭据，见需求文档 §4.3
 * @param {() => number} [deps.now]
 * @param {(msg: string) => void} [deps.log]
 */
export function createExecutor({
  store,
  secretsLoader = ({ requires }) => loadSecrets(requires),
  quotaPerDay = 0,
  now = () => Date.now(),
  log = () => {},
}) {
  /**
   * @param {object} task 已规范化任务
   * @param {{trigger?: 'schedule'|'manual', userId?: number, accountKey?: string, credentialId?: number|null}} [opts]
   * @returns {Promise<object|null>} null 表示「这次不需要执行」
   */
  return async function execute(
    task,
    { trigger = 'schedule', userId = null, accountKey = '', credentialId = null } = {},
  ) {
    const mine = userStore(store, userId);
    const startedAt = now();
    const date = dateInTZ(new Date(startedAt));

    // 幂等：调度触发时「该账号」当天已成功就跳过。手动触发不拦（用户就是想再跑一次）
    if (trigger === 'schedule' && mine.hasSuccessOn(task.name, date, accountKey)) {
      log(`[skip] ${task.name} 今日已完成，不再执行`);
      return null;
    }

    // 配额：手动触发也算，否则「手动连点 200 次」就能绕过去
    if (quotaPerDay > 0 && userId != null && typeof mine.countRunsToday === 'function') {
      const used = mine.countRunsToday(date);
      if (used >= quotaPerDay) {
        log(`[quota] 用户 ${userId} 今日已执行 ${used} 次，达到上限 ${quotaPerDay}`);
        // 提示当天只写一条：否则每 30 秒一次 tick，一天能攒出近三千条一样的记录
        if (mine.countQuotaSkips(date, task.name, accountKey) > 0) return null;
        return mine.appendRun({
          taskName: task.name,
          accountKey,
          date,
          ts: startedAt,
          status: STATUS.SKIPPED,
          message: `已达今日配额上限（${quotaPerDay} 次）`,
          dur: 0,
          trigger,
        });
      }
    }

    const lines = [];
    const record = (msg) => {
      if (lines.length < MAX_LOG_LINES) lines.push(String(msg).slice(0, MAX_LOG_LINE_LEN));
    };

    const ctx = {
      secrets: {},
      /**
       * 这次执行用的是哪个站点账号。账号已经是独立实体，所以给的是它的 id——
       * `accountKey` 是任务实例标识（历史/调度按它分），不该冒充"账号"给任务看。
       */
      account: credentialId ? { id: credentialId } : null,
      /*
       * 绑定到「这个账号」的 request：UA 按账号固定，不同账号不同。
       * 传 task.name 兜底，保证单账号模板也有一个稳定的 UA，而不是随机漂移。
       * 域名节流在 request 内部，所有账号共用同一张时间表。
       */
      request: createRequester({ seed: accountKey ? `${task.name}:${accountKey}` : task.name }),
      CookieJar,
      log: record,
      now: new Date(startedAt),
    };

    let result;
    try {
      ctx.secrets = task.requires.length
        ? secretsLoader({ userId, taskName: task.name, credentialId, requires: task.requires })
        : {};
      record(`开始执行 ${task.displayName}（${trigger === 'manual' ? '手动' : '调度'}）`);
      result = await withTimeout(task.run(ctx), task.timeoutMs, task.name);
    } catch (err) {
      // 凭据问题与网络问题分开记：界面上的处置方式完全不同
      result =
        err instanceof SecretsError
          ? { status: STATUS.CONFIG, message: err.message }
          : { status: STATUS.NETWORK, message: err.message };
    }

    const saved = mine.appendRun({
      taskName: task.name,
      accountKey,
      date,
      ts: startedAt,
      status: result?.status ?? STATUS.FAILED,
      message: result?.message ?? '',
      data: result?.data ?? null,
      dur: now() - startedAt,
      trigger,
    });

    if (lines.length) mine.appendLogs(saved.id, task.name, lines, startedAt);

    log(`[${saved.status}] ${saved.message}`);
    return saved;
  };
}
