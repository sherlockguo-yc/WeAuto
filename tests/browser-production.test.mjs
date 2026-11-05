import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { createStore } from '../src/store.mjs';
import { createExecutor } from '../src/executor.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { configureBrowserTasks } from '../src/managed-browser.mjs';

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-production-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }), () => db.close());
  db.prepare('INSERT INTO users (id,username,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(1, 'tester', 'x', 'admin', 'active', 1);
  const store = createStore(db);
  const task = store.forUser(1).createTask('v2free-checkin');
  return { store, task };
}
const template = { name: 'v2free-checkin', displayName: 'v2free', requires: [], browser: true,
  credentialGroup: 'v2free', timeoutMs: 45_000,
  schedule: { kind: 'window', window: { start: '08:30', end: '10:30' } } };
it('required browser rejects unavailable provider before decrypting or calling HTTP', async () => {
  for (const browserProvider of [null, { matches: () => false }]) {
    const { store } = fixture();
    let decrypted = false;
    let called = false;
    const execute = createExecutor({ store, browserProvider, secretsLoader: () => { decrypted = true; return {}; } });
    const run = await execute({ ...template, requires: ['PASSWORD'], browserRequired: true, run: async () => { called = true; } }, { userId: 1, trigger: 'manual' });
    assert.equal(run.status, 'config-error');
    assert.equal(decrypted, false);
    assert.equal(called, false);
  }
});
it('scheduler executes production browser daily, deduplicates today and preserves explicit timeout', async () => {
  const { store, task } = fixture();
  let now = Date.parse('2026-11-05T10:29:00+08:00');
  const dates = [];
  let releases = 0;
  const tasks = configureBrowserTasks(new Map([[template.name, { ...template, run: async (ctx) => {
    assert.ok(ctx.browser.page);
    dates.push(ctx.now.toISOString());
    return { status: 'already-signed', data: { transport: 'browser' }, message: '今日已签到' };
  } }]]), { mode: 'managed' });
  const execute = createExecutor({ store, now: () => now, browserProvider: {
    matches: () => true, acquire: async () => ({ page: {}, release: async () => { releases++; } }),
  } });
  const seen = [];
  const scheduler = createScheduler({ store, tasks, now: () => now, execute: (task, opts) => {
    seen.push(task.timeoutMs);
    return execute(task, opts);
  } });
  assert.equal(scheduler.tick().started.length, 1);
  await scheduler.waitForIdle();
  assert.equal(scheduler.tick().started.length, 0);
  now = Date.parse('2026-11-06T10:29:00+08:00');
  assert.equal(scheduler.tick().started.length, 1);
  await scheduler.waitForIdle();
  assert.equal(dates.length, 2);
  assert.equal(releases, 2);
  assert.deepEqual(seen, [180_000, 180_000]);
  store.forUser(1).updateTask(task.id, { timeoutMs: 12_345 });
  await scheduler.trigger(task.id, { userId: 1 });
  assert.equal(seen.at(-1), 12_345);
  scheduler.stop();
  assert.equal(scheduler.tick().started.length, 0);
  assert.equal(scheduler.trigger(task.id, { userId: 1 }), null);
});
it('service cancellation stops active browser tasks and saves a failure', async () => {
  const { store } = fixture();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let released = false;
  const execute = createExecutor({ store, browserProvider: { matches: () => true, acquire: async () => ({
    page: {}, release: async () => { released = true; },
  }) } });
  const pending = execute({ ...template, browserRequired: true, run: async (ctx) => {
    started();
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'failed' };
  } }, { userId: 1, trigger: 'manual' });
  await ready;
  execute.cancelAll();
  const record = await pending;
  assert.equal(record.status, 'network-error');
  assert.ok(released);
});
