import assert from 'node:assert/strict';
import { it } from 'node:test';
import task, { runBrowser } from '../tasks/v2free-checkin.mjs';

const sessionHtml = (traffic = '1GB', signed = false) => `<script>crispSessionData = [[["traffic","${traffic}"]]];</script><b>上次签到</b>:2026-11-05 09:00:00${signed ? '今日已签到' : ''}`;
const response = (json, status = 200, challenge = false) => ({
  allHeaders: async () => challenge ? { 'cf-mitigated': 'challenge' } : {},
  status: () => status,
  json: async () => { if (!json) throw new Error('private response'); return json; },
});
function fixture({ login = false, signed = false, loginResponses = [response({ ret: 1 })], checkResponse = response({ ret: 1, msg: '获得了 415MB 流量.', trafficInfo: { unUsedTraffic: '1.4GB' } }), challengePage = false } = {}) {
  let atLogin = login;
  let signedNow = signed;
  const calls = [];
  const signal = new AbortController().signal;
  const page = {
    goto: async () => calls.push('goto'),
    url: () => `https://v2free.net/${atLogin ? 'auth/login' : 'user'}`,
    waitForFunction: async () => { if (challengePage) throw new Error('not ready'); },
    content: async () => sessionHtml(signedNow ? '1.4GB' : '1GB', signedNow),
    reload: async () => calls.push('reload'),
    waitForURL: async (url, options) => {
      assert.equal(options.waitUntil, 'domcontentloaded');
      atLogin = false;
    },
    waitForResponse: async (predicate) => {
      const loginResponse = predicate({ url: () => 'https://v2free.net/auth/login', request: () => ({ method: () => 'POST' }) });
      const result = loginResponse ? loginResponses.shift() : checkResponse;
      calls.push(loginResponse ? 'login-response' : 'check-response');
      if (!loginResponse && checkResponse) signedNow = true;
      return result;
    },
    locator: (selector) => ({
      fill: async () => calls.push(`fill:${selector}`),
      click: async () => calls.push(`click:${selector}`),
    }),
  };
  return { ctx: { browser: { page }, secrets: { V2FREE_EMAIL: 'private@example.test', V2FREE_PASSWORD: 'private-password' }, signal, log: () => {} }, calls, page };
}
it('expired session is automatically logged in and signed exactly once', async () => {
  const { ctx, calls } = fixture({ login: true });
  const result = await runBrowser(ctx);
  assert.equal(result.status, 'success');
  assert.equal(result.data.gainedTraffic, 415 * 1024 ** 2);
  assert.equal(result.data.remainTraffic, '1.4GB');
  assert.equal(result.data.transport, 'browser');
  assert.equal(calls.filter((item) => item === 'click:#login').length, 1);
  assert.equal(calls.filter((item) => item === 'click:#checkin').length, 1);
});
it('already-signed skips login and checkin', async () => {
  const { ctx, calls } = fixture({ signed: true });
  const result = await runBrowser(ctx);
  assert.equal(result.status, 'already-signed');
  assert.ok(!calls.some((item) => item.startsWith('click:')));
});
it('login challenge permits one normal reload but never unbounded submissions', async () => {
  const { ctx, calls } = fixture({ login: true, loginResponses: [response(null, 403, true), response(null, 403, true)] });
  const result = await runBrowser(ctx);
  assert.equal(result.status, 'blocked');
  assert.equal(calls.filter((item) => item === 'reload').length, 1);
  assert.equal(calls.filter((item) => item === 'click:#login').length, 2);
  assert.ok(!calls.includes('click:#checkin'));
});
it('one reload can recover the login before a single checkin', async () => {
  const { ctx, calls } = fixture({ login: true, loginResponses: [response(null, 403, true), response({ ret: 1 })] });
  assert.equal((await runBrowser(ctx)).status, 'success');
  assert.equal(calls.filter((item) => item === 'click:#checkin').length, 1);
});
it('checkin challenge never repeats the state-changing request', async () => {
  const { ctx, calls } = fixture({ checkResponse: response(null, 403, true) });
  assert.equal((await runBrowser(ctx)).status, 'blocked');
  assert.equal(calls.filter((item) => item === 'click:#checkin').length, 1);
  assert.ok(!calls.includes('reload'));
});
it('non-JSON checkin and unready page are not reported as success', async () => {
  assert.equal((await runBrowser(fixture({ checkResponse: response(null) }).ctx)).status, 'blocked');
  const { ctx, calls } = fixture({ challengePage: true });
  assert.equal((await runBrowser(ctx)).status, 'blocked');
  assert.ok(!calls.some((item) => item.startsWith('click:')));
});
it('invalid login does not leak site response messages or continue to checkin', async () => {
  const { ctx, calls } = fixture({ login: true, loginResponses: [response({ ret: 0, msg: 'private-password' })] });
  const result = await runBrowser(ctx);
  assert.equal(result.status, 'failed');
  assert.ok(!JSON.stringify(result).includes('private-password'));
  assert.ok(!calls.includes('click:#checkin'));
});
it('raw browser errors are not stored and browser failures do not fallback to HTTP', async () => {
  const { ctx, page } = fixture({ login: true });
  page.locator = () => ({ fill: async () => { throw new Error('private-password'); } });
  const result = await task.run({ ...ctx, request: () => { throw new Error('HTTP must not run'); } });
  assert.equal(result.status, 'network-error');
  assert.ok(!JSON.stringify(result).includes('private-password'));
});
it('cancelled browser never navigates or submits', async () => {
  const { ctx, calls } = fixture();
  ctx.signal = AbortSignal.abort();
  assert.equal((await runBrowser(ctx)).status, 'network-error');
  assert.deepEqual(calls, []);
});
