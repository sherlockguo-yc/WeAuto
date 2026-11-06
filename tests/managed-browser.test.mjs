import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { browserConfig } from '../src/config.mjs';
import { browserEnvironment, browserProfilePath, configureBrowserTasks, createManagedBrowserProvider, seedBrowserProfile } from '../src/managed-browser.mjs';
import { prepareBrowserProfile } from '../src/browser.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const identity = { userId: 1, credentialId: 2, groupName: 'v2free' };
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-managed-'));
  dirs.push(root);
  fs.chmodSync(root, 0o700);
  const events = [];
  const page = { isClosed: () => false, close: async () => events.push('page.close'), setDefaultTimeout() {}, setDefaultNavigationTimeout() {} };
  const browser = { contexts: () => [{ newPage: async () => page }], close: async () => events.push('browser.close') };
  const provider = createManagedBrowserProvider({ profileRoot: root,
    launch: async (options) => { events.push({ launch: options }); return { pid: 123, ready: async () => 'http://127.0.0.1:12345', terminate: async () => events.push('terminate') }; },
    connect: async () => browser, ...overrides });
  return { root, provider, events, browser, page };
}
const acquire = (provider, args = {}) => provider.acquire({ ...identity, signal: new AbortController().signal, ...args });
it('Linux defaults managed and Mac HTTP; invalid browser settings fail visibly', () => {
  assert.equal(browserConfig((k, d) => d, 'linux').mode, 'managed');
  assert.equal(browserConfig((k, d) => d, 'darwin').mode, 'http');
  assert.throws(() => browserConfig((k, d) => k === 'WEAUTO_BROWSER_MODE' ? 'stealth' : d));
  assert.throws(() => browserConfig((k, d) => k === 'WEAUTO_BROWSER_CONCURRENCY' ? '0' : d));
  assert.throws(() => browserConfig((k, d) => k === 'WEAUTO_BROWSER_PROFILES' ? '../data' : d));
});
it('production tasks require browsers without changing unrelated tasks', () => {
  const other = { name: 'workbuddy', timeoutMs: 45_000 };
  const tasks = new Map([['v2', { browser: true, credentialGroup: 'v2free', timeoutMs: 45_000 }], ['other', other]]);
  configureBrowserTasks(tasks, { mode: 'managed' });
  assert.equal(tasks.get('v2').timeoutMs, 180_000);
  assert.equal(tasks.get('v2').browserRequired, true);
  assert.equal(tasks.get('other'), other);
});
it('profile keys isolate users and credentials and reject unbound identities', () => {
  const p = browserProfilePath('/tmp/profiles', identity);
  assert.notEqual(p, browserProfilePath('/tmp/profiles', { ...identity, userId: 2 }));
  assert.notEqual(p, browserProfilePath('/tmp/profiles', { ...identity, credentialId: 3 }));
  assert.throws(() => browserProfilePath('/tmp/profiles', { ...identity, credentialId: null }));
});
it('each run owns its browser; cleanup precedes unlock and profile is reused next day', async () => {
  const { root, provider, events } = fixture();
  const lease = await acquire(provider);
  const dir = browserProfilePath(root, identity);
  assert.ok(fs.existsSync(path.join(dir, '.weauto-browser.lock')));
  await lease.release();
  await lease.release();
  assert.ok(events.indexOf('browser.close') < events.indexOf('terminate'));
  assert.ok(!fs.existsSync(path.join(dir, '.weauto-browser.lock')));
  const next = await acquire(provider);
  await next.release();
  assert.equal(events.filter((e) => e.launch).length, 2);
  assert.equal(events[0].launch.profileDir, events.findLast((e) => e.launch).launch.profileDir);
});
it('queue waits instead of starting concurrent browsers and cancellation stops waiting', async () => {
  const { provider, events } = fixture();
  const first = await acquire(provider);
  const controller = new AbortController();
  const waiting = acquire(provider, { credentialId: 3, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(events.filter((e) => e.launch).length, 1);
  await first.release();
});
it('queued second account starts after first release', async () => {
  const { provider, events } = fixture();
  const first = await acquire(provider);
  const pending = acquire(provider, { credentialId: 3 });
  await first.release();
  const second = await pending;
  assert.equal(events.filter((e) => e.launch).length, 2);
  await second.release();
});
it('startup and connection failures clean resources without raw error leakage', async () => {
  const { provider, root, events } = fixture({ connect: async () => { throw new Error('private-password'); } });
  await assert.rejects(acquire(provider), (err) => !err.message.includes('private-password'));
  assert.ok(events.includes('terminate'));
  assert.ok(!fs.existsSync(path.join(browserProfilePath(root, identity), '.weauto-browser.lock')));
});
it('cleanup failure retains the lock and forbids profile reuse', async () => {
  const { provider, root } = fixture({ launch: async () => ({ pid: 123, ready: async () => 'http://127.0.0.1:12345', terminate: async () => { throw new Error('cleanup-failed'); } }) });
  const lease = await acquire(provider);
  await assert.rejects(lease.release());
  assert.ok(fs.existsSync(path.join(browserProfilePath(root, identity), '.weauto-browser.lock')));
  await assert.rejects(acquire(provider), /正在使用/);
});
it('unowned profile directory or external Chrome occupation fails before launch', async () => {
  const { provider, root, events } = fixture();
  const directory = browserProfilePath(root, identity);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, '.weauto-browser.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(acquire(provider), /正在使用/);
  assert.ok(!events.some((e) => e.launch));
});
it('native Chrome is closed before CDP disconnect and process fallback', async () => {
  const { provider, browser, events } = fixture();
  browser.newBrowserCDPSession = async () => ({ send: async (method) => events.push(method) });
  const controller = new AbortController();
  const lease = await acquire(provider, { signal: controller.signal });
  controller.abort();
  assert.ok(!events.includes('terminate'));
  await lease.release();
  assert.ok(events.indexOf('Browser.close') < events.indexOf('browser.close'));
  assert.ok(events.indexOf('browser.close') < events.indexOf('terminate'));
});
it('environment preserves real desktop plumbing but never passes application secrets', () => {
  const out = browserEnvironment({ PATH: '/bin', HOME: '/home/test', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/real/socket',
    WEAUTO_MASTER_KEY: 'private-master-key', WEAUTO_JWT_SECRET: 'private-jwt' }, '/does-not-exist');
  assert.equal(out.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/real/socket');
  assert.equal(out.WEAUTO_MASTER_KEY, undefined);
  assert.equal(out.WEAUTO_JWT_SECRET, undefined);
});
it('explicit same-account seed preserves original and backups and refuses mismatches', () => {
  const { root } = fixture();
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-seed-'));
  dirs.push(source);
  fs.chmodSync(source, 0o700);
  prepareBrowserProfile({ profileDir: source, ...identity });
  fs.writeFileSync(path.join(source, 'test-state'), 'fake-browser-state');
  fs.writeFileSync(path.join(source, 'DevToolsActivePort'), 'not-a-cookie');
  const destination = seedBrowserProfile({ source, profileRoot: root, ...identity });
  assert.equal(fs.readFileSync(path.join(destination, 'test-state'), 'utf8'), 'fake-browser-state');
  assert.ok(fs.existsSync(path.join(source, 'test-state')));
  assert.ok(!fs.existsSync(path.join(destination, 'DevToolsActivePort')));
  seedBrowserProfile({ source, profileRoot: root, ...identity });
  assert.ok(fs.readdirSync(root).some((name) => name.includes('.backup-')));
  assert.throws(() => seedBrowserProfile({ source, profileRoot: root, ...identity, credentialId: 3 }), /不匹配/);
});
it('managed close rejects future execution', async () => {
  const { provider } = fixture();
  const lease = await acquire(provider);
  await lease.release();
  await provider.close();
  await assert.rejects(acquire(provider), /正在退出/);
});
it('lifecycle diagnostics preserve failure phase and cleanup outcome without raw exceptions', async () => {
  const logs = [];
  const { provider } = fixture({ connect: async () => { throw new Error('private-password'); } });
  await assert.rejects(acquire(provider, { log: (line) => logs.push(JSON.parse(line.slice('[browser] '.length))) }));
  assert.ok(logs.some((line) => line.event === 'operation_failed' && line.phase === 'connect'));
  assert.ok(logs.some((line) => line.phase === 'cleanup_done' && line.lockReleased));
  assert.ok(!JSON.stringify(logs).includes('private-'));
});
it('successful release logs cleanup even after the abort signal fires', async () => {
  const logs = [];
  const { provider } = fixture();
  const controller = new AbortController();
  const lease = await acquire(provider, { signal: controller.signal, log: (line) => logs.push(JSON.parse(line.slice('[browser] '.length))) });
  controller.abort();
  await lease.release();
  assert.ok(logs.some((line) => line.phase === 'cancel'));
  assert.ok(logs.some((line) => line.phase === 'cleanup_done' && line.lockReleased));
});
it('acquire failure and cleanup failure are both retained', async () => {
  const logs = [];
  const { provider } = fixture({ connect: async () => { throw new Error('private-first'); },
    launch: async () => ({ pid: 123, ready: async () => 'http://127.0.0.1:12345', terminate: async () => { throw new Error('private-cleanup'); } }) });
  await assert.rejects(acquire(provider, { log: (line) => logs.push(JSON.parse(line.slice('[browser] '.length))) }));
  assert.ok(logs.some((line) => line.event === 'operation_failed' && line.phase === 'connect'));
  assert.ok(logs.some((line) => line.phase === 'cleanup_failed' && !line.lockReleased));
  assert.ok(!JSON.stringify(logs).includes('private-'));
});
it('late page after cancellation is never returned to a task', async () => {
  let finish;
  const creating = new Promise((resolve) => { finish = resolve; });
  const { provider, browser, page, events } = fixture();
  browser.contexts = () => [{ newPage: () => creating }];
  const controller = new AbortController();
  const pending = acquire(provider, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  finish(page);
  await assert.rejects(pending);
  assert.ok(events.includes('terminate'));
});
