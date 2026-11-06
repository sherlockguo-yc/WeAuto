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
import { createPageDiagnostics } from './browser-diagnostics.mjs';
import { SecretsError, loadSecrets } from './secrets.mjs';
import { STATUS, isSuccess, normalizeResume } from './task-contract.mjs';
import { dateInTZ } from './util.mjs';

/** 单次运行最多保留多少行日志（日志是最容易失控的一项） */
export const MAX_LOG_LINES = 200;
export const MAX_LOG_LINE_LEN = 2000;

/**
 * 续跑失败后的重试间隔与次数上限。
 *
 * 这里重试的是「框架侧续跑」——比如归来那一刻恰好网络不通。
 * 间隔取 10 分钟而不是 30 秒：目标是等人回来，不是抢时间；
 * 上限 3 次是为了不让一个必失败的任务靠续跑把进程拖到第二天。
 */
export const RESUME_RETRY_MS = 10 * 60_000;
export const MAX_RESUME_TRIES = 3;

function withTimeout(promise, ms, label, controller) {
  let timer;
  let onAbort;
  const guard = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason ?? new Error('任务已取消'));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`${label} 超时（${Math.round(ms / 1000)}s）`);
      reject(error);
      controller.abort(error);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  });
}

function redact(value, secrets) {
  const hidden = [...new Set(Object.values(secrets).filter((v) => typeof v === 'string' && v)
    .flatMap((v) => [v, encodeURIComponent(v)]))].sort((a, b) => b.length - a.length);
  const visit = (item) => {
    if (typeof item === 'string') return hidden.reduce((text, secret) => text.split(secret).join('[redacted]'), item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, visit(v)]));
    return item;
  };
  return visit(value);
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
  browserProvider = null,
  quotaPerDay = 0,
  now = () => Date.now(),
  log = () => {},
}) {
  const controllers = new Set();
  /**
   * @param {object} task 已规范化任务
   * @param {{trigger?: 'schedule'|'manual'|'resume', userId?: number, accountKey?: string, credentialId?: number|null}} [opts]
   * @returns {Promise<object|null>} null 表示「这次不需要执行」
   */
  const execute = async function execute(
    task,
    { trigger = 'schedule', userId = null, accountKey = '', credentialId = null } = {},
  ) {
    const mine = userStore(store, userId);
    const startedAt = now();
    const date = dateInTZ(new Date(startedAt));
    /**
     * 续跑 = 上一轮还没做完（派出后等归来领取）。它不是新的一轮：
     * 结果写回原记录、不占配额、也不该被「今日已完成」挡住。
     */
    const isResume = trigger === 'resume';
    const prevState = typeof mine.stateOf === 'function' ? mine.stateOf(task.name, accountKey) : {};
    const resumeRunId = isResume ? prevState.resume_run_id ?? null : null;

    // 幂等：调度触发时「该账号」当天已成功就跳过。手动/续跑不拦
    if (trigger === 'schedule' && mine.hasSuccessOn(task.name, date, accountKey)) {
      log(`[skip] ${task.name} 今日已完成，不再执行`);
      return null;
    }

    // 配额：手动触发也算，否则「手动连点 200 次」就能绕过去；续跑是同一轮，不重复计数
    if (!isResume && quotaPerDay > 0 && userId != null && typeof mine.countRunsToday === 'function') {
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
    const controller = new AbortController();
    let sealed = false;
    const diagnosticLog = (msg) => {
      if (!sealed && lines.length < MAX_LOG_LINES) lines.push(String(msg).slice(0, MAX_LOG_LINE_LEN));
    };
    const record = (msg) => {
      if (!controller.signal.aborted && lines.length < MAX_LOG_LINES - 20) diagnosticLog(msg);
    };

    const ctx = {
      secrets: {},
      signal: controller.signal,
      /**
       * 这次是哪种触发：'schedule' 常规调度 / 'manual' 手动 / 'resume' 续跑。
       * 任务可以用它区分「第一次派出」和「回来领取」，不必自己去猜。
       */
      trigger,
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
    let lease;
    let acquiring;
    let diagnostics;
    controllers.add(controller);
    const deadlineAt = Date.now() + task.timeoutMs;
    try {
      const identity = { userId, credentialId, groupName: task.credentialGroup ?? task.name };
      const useBrowser = task.browser === true && browserProvider?.matches(identity);
      if (task.browserRequired && !useBrowser) throw new SecretsError('此任务必须使用浏览器，但浏览器配置或账号绑定不可用');
      record(
        `开始执行 ${task.displayName}（${trigger === 'manual' ? '手动' : trigger === 'resume' ? '续跑' : '调度'}）`,
      );
      const run = async () => {
        ctx.secrets = task.requires.length
          ? await secretsLoader({ userId, taskName: task.name, credentialId, requires: task.requires }) : {};
        ctx.signal.throwIfAborted();
        if (useBrowser) {
          acquiring = browserProvider.acquire({ ...identity, signal: ctx.signal, deadlineAt, log: diagnosticLog });
          lease = await acquiring;
          ctx.signal.throwIfAborted();
          diagnostics = createPageDiagnostics(lease.page, { log: diagnosticLog, signal: ctx.signal });
          ctx.browser = { page: lease.page, diagnostics };
        }
        return task.run(ctx);
      };
      result = await withTimeout(run(), task.timeoutMs, task.name, controller);
    } catch (err) {
      result = {
        status: err instanceof SecretsError ? STATUS.CONFIG :
          [STATUS.CONFIG, STATUS.BLOCKED].includes(err.status) ? err.status : STATUS.NETWORK,
        message: err.message,
      };
    } finally {
      controller.abort();
      if (acquiring && !lease) await acquiring.catch(() => {});
      try { if (lease) await lease.release(); } catch {
        result = { status: STATUS.NETWORK, message: '浏览器资源清理失败，停止复用该 profile' };
      }
      if (diagnostics) await diagnostics.stop();
      sealed = true;
      controllers.delete(controller);
    }
    result = redact(result, ctx.secrets);
    const safeLines = redact(lines, ctx.secrets);
    ctx.secrets = {};

    const nowMs = now();
    const saved = saveRun({
      mine,
      task,
      accountKey,
      date,
      startedAt,
      nowMs,
      trigger,
      resumeRunId,
      result,
    });
    if (safeLines.length) mine.appendLogs(saved.id, task.name, safeLines, startedAt);

    trackResume({ mine, task, accountKey, result, isResume, prevState, saved, nowMs, log });

    log(`[${saved.status}] ${saved.message}`);
    return saved;
  };
  execute.cancelAll = () => {
    for (const controller of controllers) controller.abort(new Error('服务退出，任务已取消'));
  };
  return execute;
}

/**
 * 落记录。
 *
 * 续跑时**写回原记录**而不是追加：一轮「派出 → 归来领取」对用户是一件事。
 * 追加会让历史里出现两条 success，还会让「今日成功次数」算成两次。
 *
 * dur 用「从首次执行到现在」而不是本次请求耗时：续跑那一次只花了一秒，
 * 但这一轮确实跑了几个小时，页面上显示 1s 会让人以为派出瞬间就领到了。
 */
function saveRun({ mine, task, accountKey, date, startedAt, nowMs, trigger, resumeRunId, result }) {
  const status = result?.status ?? STATUS.FAILED;
  const message = result?.message ?? '';
  const data = result?.data ?? null;

  if (resumeRunId) {
    const original = mine.getRun(resumeRunId);
    if (original) {
      const updated = mine.updateRun(resumeRunId, {
        status,
        message,
        data,
        dur: nowMs - original.ts,
      });
      // 记录可能被保留策略删了（或属于别的用户）：退回追加，宁可多一条也别丢结果
      if (updated) return updated;
    }
  }

  return mine.appendRun({
    taskName: task.name,
    accountKey,
    date,
    ts: startedAt,
    status,
    message,
    data,
    dur: nowMs - startedAt,
    trigger,
  });
}

/**
 * 维护「还有没有下半场」。
 *
 * 三个分支，互不重叠：
 *   · 任务这次给了新的续跑时间 → 覆盖写入（这是唯一会凭空产生续跑的路径）
 *   · 这次是续跑且失败 → 重排一次（网络抖动不该让一次领取彻底作废），有次数上限
 *   · 这次是续跑且成功 → 清空
 *
 * 其它触发方式（schedule / manual）如果任务没给新时间，**不动既有续跑**：
 * 用户手动点一下看看状态，不该把几小时后自动领取的计划顺手清掉。
 */
function trackResume({ mine, task, accountKey, result, isResume, prevState, saved, nowMs, log }) {
  const resume = normalizeResume(result, nowMs);
  if (result?.resumeAt && !resume) {
    log('[resume] 任务给出的续跑时间不可用（太近或超过 24 小时），已忽略');
  }

  if (resume) {
    mine.saveState(task.name, accountKey, {
      resume_at: resume.atMs,
      resume_note: resume.note || null,
      resume_run_id: saved.id,
      resume_tries: 0,
    });
    return;
  }
  if (!isResume) return;

  const tries = (prevState.resume_tries ?? 0) + 1;
  if (!isSuccess(result?.status) && tries < MAX_RESUME_TRIES) {
    mine.saveState(task.name, accountKey, {
      resume_at: nowMs + RESUME_RETRY_MS,
      resume_note: prevState.resume_note ?? null,
      resume_run_id: saved.id,
      resume_tries: tries,
    });
    log(`[resume] 续跑未成功，${Math.round(RESUME_RETRY_MS / 60_000)} 分钟后重试（第 ${tries} 次）`);
    return;
  }

  mine.saveState(task.name, accountKey, {
    resume_at: null,
    resume_note: null,
    resume_run_id: null,
    resume_tries: 0,
  });
}
