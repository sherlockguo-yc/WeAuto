import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { createBrowserProvider, validateBrowserEndpoint } from '../src/browser.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const identity = { userId: 1, credentialId: 2, groupName: 'v2free' };
function fixture(connect) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-browser-'));
  dirs.push(profileDir);
  fs.chmodSync(profileDir, 0o700);
  const options = { endpoint: 'http://127.0.0.1:19222', profileDir, ...identity, connect };
  return { provider: createBrowserProvider(options), options, profileDir };
}
function fakePage() {
  let closed = false;
  return { isClosed: () => closed, close: async () => { closed = true; },
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {} };
}
it('CDP accepts only local loopback without credentials or extra paths', () => {
  assert.equal(validateBrowserEndpoint('http://127.0.0.1:19222'), 'http://127.0.0.1:19222');
  for (const url of ['http://0.0.0.0:19222', 'http://example.com', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/json', 'http://127.0.0.1/?x=1']) {
    assert.throws(() => validateBrowserEndpoint(url));
  }
});
it('profile binding is persistent and rejects a different credential or user', () => {
  const { options } = fixture();
  assert.doesNotThrow(() => createBrowserProvider(options));
  assert.throws(() => createBrowserProvider({ ...options, credentialId: 3 }), /其他账号/);
  assert.throws(() => createBrowserProvider({ ...options, userId: 2 }), /其他账号/);
});
it('profile must not be accessible by other users', () => {
  const { options, profileDir } = fixture();
  fs.chmodSync(profileDir, 0o755);
  assert.throws(() => createBrowserProvider(options), /700/);
});
it('lease locks across providers and only closes its own page', async () => {
  const page = fakePage();
  const browser = { contexts: () => [{ newPage: async () => page }] };
  const { provider, options, profileDir } = fixture(async () => browser);
  const signal = new AbortController().signal;
  const lease = await provider.acquire({ ...identity, signal });
  assert.equal(lease.page, page);
  await assert.rejects(provider.acquire({ ...identity, signal }), /正在执行/);
  await assert.rejects(createBrowserProvider(options).acquire({ ...identity, signal }), /被占用/);
  await lease.release();
  await lease.release();
  assert.ok(page.isClosed());
  assert.ok(!fs.existsSync(path.join(profileDir, '.weauto-browser.lock')));
});
it('mismatched identity is rejected before connection', async () => {
  const { provider } = fixture(() => { throw new Error('should not connect'); });
  await assert.rejects(provider.acquire({ ...identity, userId: 2, signal: new AbortController().signal }), /不匹配/);
});
it('connection errors release lock and never expose raw browser errors', async () => {
  const { provider, profileDir } = fixture(async () => { throw new Error('private-password'); });
  await assert.rejects(provider.acquire({ ...identity, signal: new AbortController().signal }), (err) => {
    assert.ok(!err.message.includes('private-password'));
    return true;
  });
  assert.ok(!fs.existsSync(path.join(profileDir, '.weauto-browser.lock')));
});
it('cancellation during page creation keeps lock until the late page is closed', async () => {
  let finish;
  const page = fakePage();
  const creating = new Promise((resolve) => { finish = resolve; });
  const { provider, profileDir } = fixture(async () => ({ contexts: () => [{ newPage: () => creating }] }));
  const controller = new AbortController();
  const pending = provider.acquire({ ...identity, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.ok(fs.existsSync(path.join(profileDir, '.weauto-browser.lock')));
  finish(page);
  await assert.rejects(pending);
  assert.ok(page.isClosed());
  assert.ok(!fs.existsSync(path.join(profileDir, '.weauto-browser.lock')));
});
