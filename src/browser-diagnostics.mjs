const EVENTS = new Set(['operation_start', 'operation_done', 'operation_failed', 'page_state', 'response',
  'request_failed', 'resource_http_error', 'page_error', 'page_closed', 'browser_disconnected', 'lifecycle', 'snapshot_failed']);
const OPERATIONS = new Set(['open_login', 'wait_ready', 'reload_login', 'open_user', 'fill_email', 'fill_password',
  'click_login', 'login_response', 'login_redirect', 'read_account', 'click_checkin', 'checkin_response', 'reload_account', 'readback']);
const PHASES = new Set(['queue', 'profile_lock', 'launch', 'ready', 'connect', 'page', 'acquire_failed', 'cancel',
  'cleanup_start', 'chrome_close', 'disconnect', 'terminate', 'cleanup_done', 'cleanup_failed', 'spawn_error', 'startup_exit']);
const STAGES = new Set(['打开登录页', '访问账户页', '登录', '等待登录跳转', '签到', '回读账户页']);
const REASONS = new Set(['timeout', 'aborted', 'closed', 'dns', 'tls', 'connection', 'http_error', 'other',
  'cf_challenge', 'json_decode_failed', 'page_not_ready', 'readback_not_user']);
const CODE_RE = /\b(ERR_(?:NAME_NOT_RESOLVED|CONNECTION_[A-Z_]+|CERT_[A-Z_]+|SSL_[A-Z_]+|TIMED_OUT|ABORTED|BLOCKED_BY_CLIENT|FAILED))\b/;

export function browserErrorKind(error, signal) {
  if (signal?.aborted) return 'aborted';
  if (error?.name === 'TimeoutError' || /超时/.test(error?.message ?? '')) return 'timeout';
  const message = String(error?.message ?? '');
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(message)) return 'dns';
  if (/ERR_CERT_|ERR_SSL_/.test(message)) return 'tls';
  if (/ERR_CONNECTION_|ECONN/.test(message)) return 'connection';
  if (/has been closed|Target closed|Session closed/.test(message)) return 'closed';
  return 'other';
}

export function createDiagnosticLogger(log = () => {}) {
  return (fields) => {
    const safe = {};
    for (const [key, value] of Object.entries(fields)) {
      const choices = { event: EVENTS, op: OPERATIONS, phase: PHASES, stage: STAGES, reason: REASONS,
        errorKind: REASONS, route: new Set(['login', 'user', 'other']), origin: new Set(['site', 'cloudflare', 'other']),
        pageKind: new Set(['challenge', 'site', 'other']), mime: new Set(['html', 'json', 'other']),
        resourceType: new Set(['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'fetch', 'other']),
        resourceClass: new Set(['pat', 'orchestrate', 'other']) }[key];
      if (choices?.has(value)) safe[key] = value;
      else if (['elapsedMs', 'timeoutMs', 'attempt', 'httpStatus', 'navigationStatus', 'challengeFrames', 'responseCount',
        'failedRequests', 'resourceErrors', 'exitCode'].includes(key) && Number.isFinite(value)) safe[key] = Math.round(value);
      else if (['aborted', 'pageClosed', 'loginReady', 'userReady', 'challenge', 'jsonParsed', 'retOk', 'forcedKill',
        'lockReleased', 'profileReused', 'domReady', 'challengeMarker'].includes(key) && typeof value === 'boolean') safe[key] = value;
      else if (key === 'cfRay' && typeof value === 'string' && /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(value)) safe[key] = value;
      else if (key === 'networkCode' && typeof value === 'string' && CODE_RE.exec(value)?.[0] === value) safe[key] = value;
      else if (key === 'exitSignal' && ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGTRAP'].includes(value)) safe[key] = value;
    }
    if (!safe.event) return;
    try { log(`[browser] ${JSON.stringify(safe)}`); } catch {}
  };
}

export function createPageDiagnostics(page, { log, signal } = {}) {
  const emit = createDiagnosticLogger(log);
  let active = true;
  const pending = new Set();
  let responses = 0;
  let failedRequests = 0;
  let resourceErrors = 0;
  let networkLogs = 0;
  let lastResponse;
  const listeners = [];
  const originOf = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === 'https://v2free.net' ? 'site' : parsed.hostname === 'challenges.cloudflare.com' ? 'cloudflare' : 'other';
    } catch { return 'other'; }
  };
  const routeOf = (url) => {
    try { const path = new URL(url).pathname; return path === '/auth/login' ? 'login' : path.startsWith('/user') ? 'user' : 'other'; } catch { return 'other'; }
  };
  const resourceOf = (request) => {
    let resourceClass = 'other';
    try {
      const url = new URL(request.url());
      if (url.hostname === 'challenges.cloudflare.com') {
        resourceClass = /\/pat\//.test(url.pathname) ? 'pat' : /\/orchestrate\//.test(url.pathname) ? 'orchestrate' : 'other';
      }
    } catch {}
    return { resourceType: request?.resourceType?.() ?? 'other', resourceClass };
  };
  const record = (data) => { if (active) emit(data); };
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
  };
  const listen = (event, fn) => { if (page.on) { page.on(event, fn); listeners.push([event, fn]); } };
  listen('response', (response) => {
    try {
      const origin = originOf(response.url());
      const route = routeOf(response.url());
      if (origin === 'other') return;
      if (response.status() >= 400) {
        resourceErrors++;
        if (networkLogs++ < 20) record({ event: 'resource_http_error', origin, route, httpStatus: response.status(),
          ...resourceOf(response.request?.()) });
      }
      if (origin !== 'site' || route === 'other') return;
      track((async () => {
        const headers = await response.allHeaders();
        responses++;
        const mime = headers['content-type']?.includes('json') ? 'json' : headers['content-type']?.includes('html') ? 'html' : 'other';
        const details = { httpStatus: response.status(), challenge: headers['cf-mitigated'] === 'challenge', cfRay: headers['cf-ray'], mime, route };
        if (response.request?.()?.isNavigationRequest?.() && response.frame?.() === page.mainFrame?.()) lastResponse = details;
        if (responses <= 20) record({ event: 'response', ...details });
      })().catch(() => {}));
    } catch {}
  });
  listen('requestfailed', (request) => {
    try {
      failedRequests++;
      if (networkLogs++ >= 20) return;
      const error = request.failure()?.errorText ?? '';
      record({ event: 'request_failed', origin: originOf(request.url()), route: routeOf(request.url()),
        errorKind: browserErrorKind({ message: error }), networkCode: CODE_RE.exec(error)?.[0], ...resourceOf(request) });
    } catch {}
  });
  listen('pageerror', () => { if (networkLogs++ < 20) record({ event: 'page_error', errorKind: 'other' }); });
  listen('close', () => record({ event: 'page_closed', pageClosed: true }));
  return {
    record,
    async operation(stage, op, fn, attempt) {
      const start = Date.now();
      record({ event: 'operation_start', stage, op, attempt });
      try {
        const result = await fn();
        record({ event: 'operation_done', stage, op, attempt, elapsedMs: Date.now() - start });
        return result;
      } catch (error) {
        record({ event: 'operation_failed', stage, op, attempt, elapsedMs: Date.now() - start,
          errorKind: browserErrorKind(error, signal), aborted: signal?.aborted === true });
        throw error;
      }
    },
    async snapshot(stage) {
      let timer;
      try {
        const state = await Promise.race([page.evaluate(() => {
          const text = document.body?.innerText ?? '';
          return {
            route: location.pathname === '/auth/login' ? 'login' : location.pathname.startsWith('/user') ? 'user' : 'other',
            pageKind: /^(Just a moment|请稍候)/i.test(document.title) ? 'challenge' : document.title === 'V2free' ? 'site' : 'other',
            challengeMarker: !!document.querySelector('#challenge-running, #challenge-stage, .cf-challenge') || /challenges\.cloudflare\.com/.test(document.querySelector('meta[http-equiv="content-security-policy"]')?.content ?? ''),
            loginReady: !!document.querySelector('#login') && !!document.querySelector('#passwd'),
            userReady: location.pathname.startsWith('/user') && (!!document.querySelector('#checkin') || /今日已签到/.test(text)),
            domReady: document.readyState !== 'loading',
            challengeFrames: [...document.querySelectorAll('iframe')].filter((frame) => { try { return new URL(frame.src).hostname === 'challenges.cloudflare.com'; } catch { return false; } }).length,
            navigationStatus: performance.getEntriesByType('navigation')[0]?.responseStatus,
          };
        }), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(), { name: 'TimeoutError' })), 1500); })]);
        const details = lastResponse?.route === state.route && lastResponse?.httpStatus === state.navigationStatus ? lastResponse : {};
        const reason = state.pageKind === 'challenge' || state.challengeMarker ? 'cf_challenge' : 'page_not_ready';
        record({ event: 'page_state', stage, ...details, ...state, reason, responseCount: responses,
          failedRequests, resourceErrors, pageClosed: page.isClosed?.() === true, aborted: signal?.aborted === true });
        return { reason, httpStatus: state.navigationStatus };
      } catch (error) {
        record({ event: 'snapshot_failed', stage, errorKind: browserErrorKind(error, signal), pageClosed: page.isClosed?.() === true });
        return { reason: 'page_not_ready' };
      } finally { clearTimeout(timer); }
    },
    async stop() {
      for (const [event, fn] of listeners) page.removeListener?.(event, fn);
      await Promise.race([Promise.allSettled([...pending]), new Promise((resolve) => setTimeout(resolve, 100))]);
      active = false;
    },
  };
}
