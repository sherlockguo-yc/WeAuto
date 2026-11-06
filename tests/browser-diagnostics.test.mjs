import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { browserErrorKind, createDiagnosticLogger, createPageDiagnostics } from '../src/browser-diagnostics.mjs';

function fixture(state = {}) {
  const page = new EventEmitter();
  page.isClosed = () => false;
  page.evaluate = async () => ({ route: 'login', pageKind: 'site', loginReady: false, userReady: false, domReady: true, ...state });
  const logs = [];
  const diagnostics = createPageDiagnostics(page, { log: (line) => logs.push(JSON.parse(line.slice('[browser] '.length))) });
  return { page, logs, diagnostics };
}
it('diagnostic whitelist excludes credentials, full URLs, cookies and raw error messages', () => {
  const logs = [];
  const emit = createDiagnosticLogger((line) => logs.push(line));
  emit({ event: 'response', httpStatus: 403, cfRay: 'a551f2f6df3d9173-SEA', mime: 'html',
    password: 'private-password', url: 'https://v2free.net?token=private-token', cookie: 'private-cookie',
    errorKind: 'private-password', cfRayBad: 'private-cookie' });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('a551f2f6df3d9173-SEA'));
  assert.ok(!logs[0].includes('private-'));
});
it('error classification uses fixed enums, never copied messages', () => {
  assert.equal(browserErrorKind({ name: 'TimeoutError', message: 'password-value' }), 'timeout');
  assert.equal(browserErrorKind({ message: 'net::ERR_NAME_NOT_RESOLVED https://secret.test' }), 'dns');
  assert.equal(browserErrorKind({ message: 'net::ERR_CERT_AUTHORITY_INVALID' }), 'tls');
  assert.equal(browserErrorKind({ message: 'net::ERR_CONNECTION_RESET' }), 'connection');
  assert.equal(browserErrorKind(new Error('Target page, context or browser has been closed')), 'closed');
  assert.equal(browserErrorKind(new Error('private-password')), 'other');
  assert.equal(browserErrorKind(new Error(), AbortSignal.abort()), 'aborted');
});
it('challenge snapshots classify initial navigation even if it predates listener registration', async () => {
  const { diagnostics, logs } = fixture({ pageKind: 'challenge', challengeMarker: true, navigationStatus: 403 });
  assert.deepEqual(await diagnostics.snapshot('打开登录页'), { reason: 'cf_challenge', httpStatus: 403 });
  assert.equal(logs[0].navigationStatus, 403);
  await diagnostics.stop();
});
it('ordinary incomplete page is not falsely diagnosed as Cloudflare', async () => {
  const { diagnostics, logs } = fixture({ navigationStatus: 200 });
  assert.equal((await diagnostics.snapshot('打开登录页')).reason, 'page_not_ready');
  assert.equal(logs[0].loginReady, false);
  await diagnostics.stop();
});
it('failed challenge resource logs only origin category and known network code', async () => {
  const { page, diagnostics, logs } = fixture();
  page.emit('requestfailed', { url: () => 'https://challenges.cloudflare.com/script?token=private-token',
    failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED private-password' }) });
  assert.deepEqual(logs[0], { event: 'request_failed', origin: 'cloudflare', route: 'other', errorKind: 'dns', networkCode: 'ERR_NAME_NOT_RESOLVED', resourceType: 'other', resourceClass: 'other' });
  assert.equal((await diagnostics.snapshot('打开登录页')).reason, 'page_not_ready');
  assert.equal(logs.at(-1).failedRequests, 1);
  await diagnostics.stop();
});
it('auxiliary 401 is identified separately and cannot alone prove a Cloudflare challenge', async () => {
  const { page, diagnostics, logs } = fixture();
  const url = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/pat/private-token';
  page.emit('response', { url: () => url, status: () => 401, request: () => ({ url: () => url, resourceType: () => 'fetch' }) });
  assert.equal(logs[0].resourceClass, 'pat');
  assert.equal((await diagnostics.snapshot('打开登录页')).reason, 'page_not_ready');
  assert.ok(!JSON.stringify(logs).includes('private-token'));
  await diagnostics.stop();
});
it('page error floods are bounded and preserve a final snapshot', async () => {
  const { page, diagnostics, logs } = fixture();
  for (let i = 0; i < 300; i++) page.emit('pageerror', new Error('private-password'));
  assert.equal(logs.length, 20);
  await diagnostics.snapshot('打开登录页');
  assert.equal(logs.at(-1).event, 'page_state');
  await diagnostics.stop();
});
it('response captures status, challenge and valid Ray ID without arbitrary headers', async () => {
  const { page, diagnostics, logs } = fixture();
  page.emit('response', { url: () => 'https://v2free.net/auth/login?private-token', status: () => 403,
    allHeaders: async () => ({ 'cf-mitigated': 'challenge', 'cf-ray': 'a551f2f6df3d9173-SEA', 'content-type': 'text/html', 'set-cookie': 'private-cookie' }) });
  await diagnostics.stop();
  assert.ok(logs.some((item) => item.challenge && item.httpStatus === 403));
  assert.ok(!JSON.stringify(logs).includes('private-'));
  assert.equal(page.listenerCount('response'), 0);
  const count = logs.length;
  page.emit('pageerror', new Error('private-password'));
  assert.equal(logs.length, count);
});
it('old challenge responses never override current ordinary page route or status', async () => {
  const { diagnostics, page, logs } = fixture({ route: 'other', navigationStatus: 200 });
  const frame = {};
  page.mainFrame = () => frame;
  page.emit('response', { url: () => 'https://v2free.net/auth/login', status: () => 403,
    request: () => ({ isNavigationRequest: () => true }), frame: () => frame,
    allHeaders: async () => ({ 'cf-mitigated': 'challenge', 'content-type': 'text/html' }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await diagnostics.snapshot('打开登录页'), { reason: 'page_not_ready', httpStatus: 200 });
  assert.equal(logs.at(-1).route, 'other');
  assert.equal(logs.at(-1).challenge, undefined);
  await diagnostics.stop();
});
it('operation failures and snapshot failures are observable without raw exceptions', async () => {
  const { diagnostics, page, logs } = fixture();
  await assert.rejects(diagnostics.operation('登录', 'fill_password', async () => { throw new Error('private-password'); }));
  assert.equal(logs.at(-1).op, 'fill_password');
  assert.equal(logs.at(-1).errorKind, 'other');
  page.evaluate = async () => { throw new Error('private-cookie'); };
  assert.equal((await diagnostics.snapshot('登录')).reason, 'page_not_ready');
  assert.equal(logs.at(-1).event, 'snapshot_failed');
  assert.ok(!JSON.stringify(logs).includes('private-'));
  await diagnostics.stop();
});
it('broken logging callback never changes browser operation results', async () => {
  const page = new EventEmitter();
  const diagnostics = createPageDiagnostics(page, { log: () => { throw new Error('logger failed'); } });
  assert.equal(await diagnostics.operation('登录', 'click_login', async () => 42), 42);
  await diagnostics.stop();
});
