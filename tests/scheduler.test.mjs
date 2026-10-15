/**
 * 调度器测试
 *
 * 调度的错误几乎都是「静默」的：任务该跑没跑，或不该跑却跑了，界面上都看不出来。
 * 所以这里把到期判断拆成纯函数逐条测边界，再用一个真实 SQLite + 假 execute
 * 验证「互斥 / 幂等 / 停用 / 重启」这四件容易写错的事。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { createStore } from '../src/store.mjs';
import { ONCE_GRACE_MS, createScheduler, planTask } from '../src/scheduler.mjs';
import { targetSecondsOfDay } from '../src/schedule.mjs';
import { dateInTZ, startOfDayBeijingMs } from '../src/util.mjs';

/** 北京时间 2026-10-14 12:00 */
const NOON = Date.parse('2026-10-14T12:00:00+08:00');
const DAY = '2026-10-14';
const atBeijing = (hhmm) => startOfDayBeijingMs(DAY) + timeToSec(hhmm) * 1000;
function timeToSec(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}

const windowTask = {
  name: 'w-task',
  schedule: { kind: 'window', window: { start: '09:00', end: '09:50' } },
};
const everyTask = { name: 'e-task', schedule: { kind: 'every', every: { minutes: 30, jitterSec: 0 } } };
const onceTask = {
  name: 'o-task',
  schedule: { kind: 'once', once: { atMs: atBeijing('12:00'), atLabel: `${DAY} 12:00:00` } },
};

/** window 任务当日的目标时刻（与调度器同源，避免测试自己算错） */
const windowTargetMs =
  startOfDayBeijingMs(DAY) + targetSecondsOfDay('w-task', windowTask.schedule.window, DAY) * 1000;

describe('planTask：每天窗口', () => {
  it('未到目标时刻 → 不执行，并把今日目标写入状态', () => {
    const p = planTask({ task: windowTask, nowMs: windowTargetMs - 60_000 });
    assert.equal(p.due, false);
    assert.match(p.reason, /未到今日目标时刻/);
    assert.equal(p.nextState.today_date, DAY);
    assert.equal(p.nextState.today_target_ts, windowTargetMs);
  });

  it('到目标时刻且今天还没成功 → 执行', () => {
    const p = planTask({ task: windowTask, nowMs: windowTargetMs + 1000 });
    assert.equal(p.due, true);
  });

  it('今天已经成功过 → 不再执行（幂等的最后一道闸）', () => {
    const p = planTask({ task: windowTask, nowMs: windowTargetMs + 1000, hasSuccessToday: true });
    assert.equal(p.due, false);
    assert.match(p.reason, /今日已完成/);
  });

  it('窗口已过且未成功 → 不执行，等明天（不追补）', () => {
    const p = planTask({ task: windowTask, nowMs: atBeijing('23:00'), hasSuccessToday: false });
    assert.equal(p.due, false);
    assert.match(p.reason, /窗口已过/);
  });

  it('状态里已有今日目标时沿用原值（重启后目标时刻不变）', () => {
    const p = planTask({
      task: windowTask,
      nowMs: NOON,
      state: { today_date: DAY, today_target_ts: windowTargetMs },
    });
    assert.equal(p.nextState.today_target_ts, windowTargetMs);
  });
});

describe('planTask：间隔', () => {
  it('首次没有下次到期时间 → 排入一个间隔后，不立即执行', () => {
    const p = planTask({ task: everyTask, nowMs: NOON });
    assert.equal(p.due, false);
    assert.equal(p.nextState.next_due_ts, NOON + 30 * 60_000);
  });

  it('到点 → 执行，并把下次到期推进一个间隔', () => {
    const p = planTask({ task: everyTask, nowMs: NOON, state: { next_due_ts: NOON - 1 } });
    assert.equal(p.due, true);
    assert.equal(p.nextState.next_due_ts, NOON + 30 * 60_000);
  });

  it('抖动只加不减，且由注入的随机源决定（可测）', () => {
    const task = { name: 'j', schedule: { kind: 'every', every: { minutes: 10, jitterSec: 60 } } };
    const p = planTask({ task, nowMs: NOON, state: { next_due_ts: NOON - 1 }, random: () => 0.5 });
    assert.equal(p.nextState.next_due_ts, NOON + 10 * 60_000 + 30_000);
  });
});

describe('planTask：一次性', () => {
  it('还没到 → 不执行', () => {
    assert.equal(planTask({ task: onceTask, nowMs: NOON - 60_000 }).due, false);
  });

  it('到点（宽限期内）→ 执行', () => {
    assert.equal(planTask({ task: onceTask, nowMs: NOON + 1000 }).due, true);
    assert.equal(planTask({ task: onceTask, nowMs: NOON + ONCE_GRACE_MS }).due, true);
  });

  it('超过宽限期 → 判定已错过，绝不自动补跑（否则凌晨重启会突然发请求）', () => {
    const p = planTask({ task: onceTask, nowMs: NOON + ONCE_GRACE_MS + 1 });
    assert.equal(p.due, false);
    assert.equal(p.missed, true);
    assert.match(p.reason, /不自动补跑/);
  });

  it('已被调度执行过 → 不再执行；手动执行不算数', () => {
    assert.equal(planTask({ task: onceTask, nowMs: NOON + 1000, hasScheduledRun: true }).due, false);
  });
});

describe('planTask：没有调度声明', () => {
  it('只能手动触发，不自动执行', () => {
    const p = planTask({ task: { name: 'm', schedule: null }, nowMs: NOON });
    assert.equal(p.due, false);
    assert.match(p.reason, /只能手动触发/);
  });
});

/* ─────────────────── 用真实 SQLite 验证调度循环 ─────────────────── */

let dir;
const openDbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-scheduler-'));
});

after(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const USER_ID = 1;

let seq = 0;
/**
 * 默认把两个测试模板都订阅上：调度器只认「订阅 × 账号」，
 * 没有订阅的任务根本不进入调度目标（这正是多租户后的语义）。
 */
function fresh(subs = [windowTask.name, everyTask.name]) {
  const db = openDb(path.join(dir, `db-${++seq}.sqlite`));
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)',
  ).run(USER_ID, 'tester', 'not-a-real-hash', 'admin', 'active', 1);
  openDbs.push(db);
  const store = createStore(db);
  for (const name of subs) store.forUser(USER_ID).subscribe(name);
  return { db, store };
}

/** 假执行器：像真执行器那样自己落库，这样幂等才能被验证 */
function fakeExecute(store, { status = 'success', delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async execute(task, { trigger, userId = USER_ID, accountKey = '' }) {
      calls.push({ task: task.name, trigger, userId, accountKey });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return store.forUser(userId).appendRun({
        taskName: task.name,
        accountKey,
        date: dateInTZ(new Date(NOON)),
        ts: NOON,
        status,
        message: 'fake',
        trigger,
      });
    },
  };
}

describe('调度循环', () => {
  it('到期后执行一次并落库', async () => {
    const { store } = fresh();
    const { execute, calls } = fakeExecute(store);
    const tasks = new Map([[windowTask.name, windowTask]]);
    const sch = createScheduler({ store, tasks, execute, now: () => windowTargetMs + 1000 });

    const r = sch.tick();
    assert.deepEqual(r.started, ['w-task:']); // 格式为 `${订阅}:${账号}`，单账号模板的账号是空串
    await sch.waitForIdle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].trigger, 'schedule');
    assert.equal(store.forUser(USER_ID).runsOfTask('w-task', { limit: 10 }).length, 1);
  });

  it('同一 tick 内不会重复执行，且已成功的一轮之后不再执行', async () => {
    const { store } = fresh();
    const { execute, calls } = fakeExecute(store);
    const tasks = new Map([[windowTask.name, windowTask]]);
    const sch = createScheduler({ store, tasks, execute, now: () => windowTargetMs + 1000 });

    sch.tick();
    await sch.waitForIdle();
    // 第一条记录是 success → 幂等生效
    const second = sch.tick();
    assert.deepEqual(second.started, []);
    await sch.waitForIdle();
    assert.equal(calls.length, 1);
  });

  it('执行期间再次 tick 不会并发跑同一个任务', async () => {
    const { store } = fresh();
    const { execute, calls } = fakeExecute(store, { delayMs: 40 });
    const tasks = new Map([[windowTask.name, windowTask]]);
    const sch = createScheduler({ store, tasks, execute, now: () => windowTargetMs + 1000 });

    sch.tick();
    const during = sch.tick();
    assert.deepEqual(during.started, [], '执行中不应再次启动');
    assert.equal(sch.isRunning('w-task', USER_ID), true);
    await sch.waitForIdle();
    assert.equal(calls.length, 1);
  });

  it('停用的任务即使到期也不执行', async () => {
    const { store } = fresh();
    const { execute, calls } = fakeExecute(store);
    const tasks = new Map([[windowTask.name, windowTask]]);
    const sch = createScheduler({ store, tasks, execute, now: () => windowTargetMs + 1000 });

    store.forUser(USER_ID).setSubscription('w-task', { enabled: false });
    sch.tick();
    await sch.waitForIdle();
    assert.equal(calls.length, 0);
  });

  it('间隔任务：错过的整轮在启动时被跳过，而不是密集追补', () => {
    const { store } = fresh();
    const { execute } = fakeExecute(store);
    const tasks = new Map([[everyTask.name, everyTask]]);
    const sch = createScheduler({ store, tasks, execute, now: () => NOON });

    // 进程停了两小时，next_due_ts 停留在过去
    store.forUser(USER_ID).saveState('e-task', '', { next_due_ts: NOON - 2 * 3600_000 });
    sch.normalizeOnStart();

    assert.equal(store.forUser(USER_ID).stateOf('e-task').next_due_ts, NOON + 30 * 60_000);

    // 归一化之后立刻 tick，不应执行
    const r = sch.tick();
    assert.deepEqual(r.started, []);
  });

  it('间隔任务：正常到点执行', async () => {
    const { store } = fresh();
    const { execute, calls } = fakeExecute(store);
    const tasks = new Map([[everyTask.name, everyTask]]);
    const sch = createScheduler({ store, tasks, execute, now: () => NOON });

    store.forUser(USER_ID).saveState('e-task', '', { next_due_ts: NOON - 1 });
    const r = sch.tick();
    assert.deepEqual(r.started, ['e-task:']);
    await sch.waitForIdle();
    assert.equal(calls.length, 1);
    assert.equal(store.forUser(USER_ID).stateOf('e-task').next_due_ts, NOON + 30 * 60_000);
  });

  it('手动触发：跳过调度判断，但依然受幂等与互斥保护', async () => {
    const { store } = fresh();
    const { execute, calls } = fakeExecute(store, { status: 'failed' });
    const tasks = new Map([[windowTask.name, windowTask]]);
    const sch = createScheduler({ store, tasks, execute, now: () => NOON });

    // 远未到窗口，调度器不会跑；手动可以
    assert.deepEqual(sch.tick(), { started: [] });
    await sch.trigger('w-task', { userId: USER_ID });
    await sch.waitForIdle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].trigger, 'manual');

    // 手动执行期间再点一次会被互斥挡住
    const slow = fakeExecute(store, { delayMs: 30 });
    const sch2 = createScheduler({ store, tasks, execute: slow.execute, now: () => NOON });
    const p1 = sch2.trigger('w-task', { userId: USER_ID });
    assert.equal(sch2.trigger('w-task', { userId: USER_ID }), null);
    await p1;
    await sch2.waitForIdle();
    assert.equal(slow.calls.length, 1);
  });

  it('未知任务手动触发直接报错', () => {
    const { store } = fresh();
    const { execute } = fakeExecute(store);
    const sch = createScheduler({ store, tasks: new Map(), execute, now: () => NOON });
    assert.throws(() => sch.trigger('nope', { userId: USER_ID }), /未知任务/);
  });

  it('执行器抛异常不会让调度器停摆', async () => {
    const { store } = fresh();
    const tasks = new Map([[windowTask.name, windowTask]]);
    const sch = createScheduler({
      store,
      tasks,
      execute: async () => {
        throw new Error('boom');
      },
      now: () => windowTargetMs + 1000,
      log: () => {},
    });

    sch.tick();
    await sch.waitForIdle();
    // 异常被兜住：状态里不写入 last_run_id，但调度器仍可继续工作
    assert.equal(store.forUser(USER_ID).stateOf('w-task').last_run_id, null);
    assert.equal(sch.isRunning('w-task', USER_ID), false);
  });

  it('订阅里配的调度覆盖模板默认（否则「配自己的时间」形同虚设）', async () => {
    const { store } = fresh();
    // 模板是 every 30 分钟，用户在订阅里改成 10 分钟
    store.forUser(USER_ID).setSubscription('e-task', {
      schedule: { kind: 'every', every: { minutes: 10 } },
    });
    store.forUser(USER_ID).saveState('e-task', '', { next_due_ts: NOON - 1 });

    const { execute, calls } = fakeExecute(store);
    const sch = createScheduler({
      store,
      tasks: new Map([[everyTask.name, everyTask]]),
      execute,
      now: () => NOON,
    });

    const r = sch.tick();
    assert.deepEqual(r.started, ['e-task:']);
    await sch.waitForIdle();
    assert.equal(calls.length, 1);
    // 下一次到期按 10 分钟算，不是模板的 30 分钟
    assert.equal(store.forUser(USER_ID).stateOf('e-task').next_due_ts, NOON + 10 * 60_000);
  });

  it('停用的用户不再被调度', async () => {
    const { db, store } = fresh();
    const { execute, calls } = fakeExecute(store);
    const sch = createScheduler({
      store,
      tasks: new Map([[windowTask.name, windowTask]]),
      execute,
      now: () => windowTargetMs + 1000,
    });

    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(USER_ID);
    const r = sch.tick();
    assert.deepEqual(r.started, [], '停用后不该再有任何调度目标');
    await sch.waitForIdle();
    assert.equal(calls.length, 0);
  });

  it('停用的账号不参与调度，另一个照常', async () => {
    const { store } = fresh();
    const extra = store.forUser(USER_ID).addAccount('w-task', { label: '小号' });
    store.forUser(USER_ID).setAccountEnabled('w-task', extra, false);

    const { execute, calls } = fakeExecute(store);
    const sch = createScheduler({
      store,
      tasks: new Map([[windowTask.name, windowTask]]),
      execute,
      now: () => windowTargetMs + 1000,
    });

    const r = sch.tick();
    await sch.waitForIdle();
    assert.deepEqual(r.started, ['w-task:'], '只剩默认账号');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].accountKey, '');
  });

  it('同一用户串行：两个账号不会同时打出去', async () => {
    const { store } = fresh();
    const extra = store.forUser(USER_ID).addAccount('w-task', { label: '小号' });
    assert.ok(extra);

    const { execute, calls } = fakeExecute(store, { delayMs: 40 });
    const sch = createScheduler({
      store,
      tasks: new Map([[windowTask.name, windowTask]]),
      execute,
      now: () => windowTargetMs + 1000,
    });

    const r = sch.tick();
    await sch.waitForIdle();
    assert.equal(r.started.length, 1, '同一时刻只启动一个，另一个留给下一轮');
    assert.equal(calls.length, 1);
  });
});
