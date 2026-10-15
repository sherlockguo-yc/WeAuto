/**
 * 数据访问层测试
 *
 * 重点在两处容易出事的地方：
 *   · 覆盖层的「合并式写入」——写一个字段不能把别的字段抹掉
 *   · 保留策略的「先聚合后删除」——删掉的明细必须留下计数，否则长期趋势会凭空消失
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { createStore } from '../src/store.mjs';

let dir;
const openDbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-store-'));
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

let seq = 0;
/**
 * 外键是开启的，所以订阅前必须有真实存在的用户行。
 * 顺带也是一条约束的证明：不存在「没有主人的订阅」。
 */
function freshDb() {
  const db = openDb(path.join(dir, `db-${++seq}.sqlite`));
  const ins = db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  ins.run(USER_ID, 'user-a', 'not-a-real-hash', 'admin', 'active', 1);
  ins.run(OTHER_USER_ID, 'user-b', 'not-a-real-hash', 'user', 'active', 1);
  openDbs.push(db);
  return db;
}

/** 用户视图：绝大多数用例都在这个视角下（多租户后没有「不带用户」的入口） */
function fresh() {
  return createStore(freshDb()).forUser(USER_ID);
}

/** 根 store：只有跨用户的用例（遍历订阅、删号清理、上限校验）才需要 */
function freshRoot(limits) {
  return createStore(freshDb(), { limits });
}

const USER_ID = 1;
const OTHER_USER_ID = 2;

const run = (store, over = {}) =>
  store.appendRun({
    taskName: 't',
    date: '2026-10-14',
    ts: 1000,
    status: 'success',
    message: 'ok',
    data: { a: 1 },
    dur: 12,
    ...over,
  });

describe('执行记录', () => {
  it('写入后能读回，data 保持结构化', () => {
    const store = fresh();
    const r = run(store, { data: { remainTraffic: 123, nested: { x: 1 } } });
    assert.ok(r.id > 0);
    assert.deepEqual(store.getRun(r.id).data, { remainTraffic: 123, nested: { x: 1 } });
    assert.equal(store.getRun(r.id).trigger, 'schedule');
  });

  it('data 为 null 时不写入 "null" 字符串', () => {
    const store = fresh();
    const r = run(store, { data: null });
    assert.equal(store.getRun(r.id).data, null);
  });

  /*
   * 命令行时代导入的历史记录不带账号 key，而 account_key 列是可空的 → 存进去是 NULL。
   * 订阅账号里「默认」账号的 key 却是 ''，两边拼出的 map key 不一样，
   * status.mjs 匹配不上就回退显示原始任务名（2026-10-15 生产实测）。
   */
  it('account_key 为 NULL 的历史记录读出来是空串', () => {
    const db = freshDb();
    const store = createStore(db).forUser(USER_ID);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO runs (user_id, task_name, account_key, date, ts, status, message)
         VALUES (?, 't', NULL, '2026-10-14', 1000, 'success', 'ok')`,
      )
      .run(USER_ID);
    assert.equal(store.getRun(Number(lastInsertRowid)).accountKey, '');
  });

  it('按任务取记录：最新在前', () => {
    const store = fresh();
    run(store, { ts: 100 });
    run(store, { ts: 300 });
    run(store, { ts: 200 });
    assert.deepEqual(
      store.runsOfTask('t', { limit: 10 }).map((r) => r.ts),
      [300, 200, 100],
    );
  });

  it('全局最近记录默认隐藏 skipped（首页要的是「谁出事了」）', () => {
    const store = fresh();
    run(store, { ts: 1, status: 'success' });
    run(store, { ts: 2, status: 'skipped' });
    run(store, { ts: 3, status: 'failed' });

    assert.deepEqual(
      store.recentRuns(10).map((r) => r.status),
      ['failed', 'success'],
    );
    assert.equal(store.recentRuns(10, { includeSkipped: true }).length, 3);
  });

  it('lastSuccess 只认「办成了」的状态', () => {
    const store = fresh();
    run(store, { ts: 1, status: 'failed' });
    run(store, { ts: 2, status: 'already-signed' });
    run(store, { ts: 3, status: 'blocked' });
    assert.equal(store.lastSuccess('t').ts, 2);
  });

  it('hasSuccessOn 按日期与状态双重判定', () => {
    const store = fresh();
    run(store, { status: 'failed', date: '2026-10-14' });
    assert.equal(store.hasSuccessOn('t', '2026-10-14'), false);
    run(store, { status: 'success', date: '2026-10-14', ts: 2 });
    assert.equal(store.hasSuccessOn('t', '2026-10-14'), true);
    assert.equal(store.hasSuccessOn('t', '2026-10-15'), false);
  });

  it('hasScheduledRun 不算手动执行（否则手滑点一下就把一次性任务的计划吃掉）', () => {
    const store = fresh();
    run(store, { trigger: 'manual' });
    assert.equal(store.hasScheduledRun('t'), false);
    run(store, { trigger: 'schedule', ts: 2 });
    assert.equal(store.hasScheduledRun('t'), true);
  });
});

describe('运行日志', () => {
  it('按运行分组，按写入顺序返回', () => {
    const store = fresh();
    const r = run(store);
    store.appendLogs(r.id, 't', ['第一行', '第二行']);
    assert.deepEqual(
      store.logsOfRun(r.id).map((l) => l.line),
      ['第一行', '第二行'],
    );
  });

  it('非字符串内容被转成字符串（日志不该因为塞了个对象就写不进去）', () => {
    const store = fresh();
    const r = run(store);
    store.appendLogs(r.id, 't', [42, { a: 1 }, null]);
    assert.deepEqual(
      store.logsOfRun(r.id).map((l) => l.line),
      ['42', '[object Object]', 'null'],
    );
  });
});

describe('调度状态', () => {
  it('局部更新不覆盖其它字段', () => {
    const store = fresh();
    const r = run(store);

    store.saveState('t', '', { today_date: '2026-10-14', today_target_ts: 111 });
    store.saveState('t', '', { last_run_id: r.id });

    assert.deepEqual(store.stateOf('t'), {
      today_date: '2026-10-14',
      today_target_ts: 111,
      next_due_ts: null,
      last_run_id: r.id,
    });
  });

  it('last_run_id 必须指向真实记录（外键兜住脏数据）', () => {
    const store = fresh();
    assert.throws(() => store.saveState('t', '', { last_run_id: 99999 }), /FOREIGN KEY/);
  });

  it('运行记录被保留策略删除后，状态里的引用自动置空而不是指向幽灵', () => {
    const store = fresh();
    const NOW = Date.parse('2026-10-14T12:00:00+08:00');
    const old = run(store, { date: '2026-01-01', ts: NOW - 300 * 86_400_000 });
    store.saveState('t', '', { last_run_id: old.id });

    store.pruneTask('t', { days: 90, maxRows: 2000, logDays: 30 }, NOW);
    assert.equal(store.stateOf('t').last_run_id, null);
  });
});

describe('任务（一个任务 = 一个账号）', () => {
  it('没建任务时列表是空的', () => {
    const store = fresh();
    assert.deepEqual(store.listTasks(), []);
    assert.equal(store.getTask(1), null);
  });

  it('建任务默认启用，并自带一个账号', () => {
    const store = fresh();
    const t = store.createTask('t', { label: '主号' });
    assert.equal(t.enabled, true);
    assert.equal(t.label, '主号');
    assert.ok(t.accountKey.length > 0 || t.accountKey === '', '每个任务都有自己的账号维度');
    assert.equal(store.listTasks().length, 1);
  });

  it('同一个模板可以建多个任务，账号互不相同', () => {
    const store = fresh();
    const a = store.createTask('t', { label: '主号' });
    const b = store.createTask('t', { label: '小号' });
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.accountKey, b.accountKey);
    assert.equal(store.tasksOfTemplate('t').length, 2);
  });

  it('只改 enabled 不会抹掉已设置的调度', () => {
    const store = fresh();
    const t = store.createTask('t', { schedule: { kind: 'every', every: { minutes: 5 } } });
    store.updateTask(t.id, { enabled: false });

    const o = store.getTask(t.id);
    assert.equal(o.enabled, false);
    assert.equal(o.schedule.every.minutes, 5);
  });

  it('只改调度不会把 enabled 翻回默认', () => {
    const store = fresh();
    const t = store.createTask('t');
    store.updateTask(t.id, { enabled: false });
    store.updateTask(t.id, { timeoutMs: 5000 });
    assert.equal(store.getTask(t.id).enabled, false);
  });

  it('删掉任务后它就不在了；再删一次什么也没发生', () => {
    const store = fresh();
    const t = store.createTask('t');
    assert.equal(store.deleteTask(t.id), true);
    assert.equal(store.getTask(t.id), null);
    assert.equal(store.deleteTask(t.id), false);
  });

  it('拿不到别人的任务：getTask 只认自己的', () => {
    const root = freshRoot();
    const a = root.forUser(1);
    const b = root.forUser(2);
    const t = a.createTask('t');
    assert.equal(b.getTask(t.id), null);
    assert.equal(b.updateTask(t.id, { enabled: false }), null);
    assert.equal(b.deleteTask(t.id), false);
    assert.equal(a.getTask(t.id).enabled, true, '别人的操作没碰到我的任务');
  });
});

describe('每个任务的历史各自独立', () => {
  /**
   * 这是最容易踩的坑：幂等如果只按「模板 + 日期」判断，
   * A 任务成功后 B 任务会被判「今日已完成」而跳过。
   */
  it('今日是否成功按任务区分：A 成功不代表 B 成功', () => {
    const store = fresh();
    const a = store.createTask('t', { label: '主号' });
    const b = store.createTask('t', { label: '小号' });
    store.appendRun({ taskName: 't', accountKey: b.accountKey, date: '2026-10-14', ts: 1, status: 'success' });

    assert.equal(store.hasSuccessOn('t', '2026-10-14', b.accountKey), true);
    assert.equal(store.hasSuccessOn('t', '2026-10-14', a.accountKey), false);
  });

  it('历史按任务（账号）分开查', () => {
    const store = fresh();
    const a = store.createTask('t', { label: '主号' });
    const b = store.createTask('t', { label: '小号' });
    store.appendRun({ taskName: 't', accountKey: a.accountKey, date: '2026-10-14', ts: 1, status: 'success' });
    store.appendRun({ taskName: 't', accountKey: b.accountKey, date: '2026-10-14', ts: 2, status: 'success' });

    assert.equal(store.runsOfTask('t', { accountKey: b.accountKey, limit: 10 }).length, 1);
    assert.equal(store.runsOfTask('t', { limit: 10 }).length, 2); // 不传就是这个模板下全部任务
  });
});

describe('多租户隔离', () => {
  it('两个用户的数据互不可见', () => {
    const root = freshRoot();
    const a = root.forUser(1);
    const b = root.forUser(2);
    a.createTask('t');
    b.createTask('t');
    a.appendRun({ taskName: 't', date: '2026-10-14', ts: 1, status: 'success', message: 'a' });
    b.appendRun({ taskName: 't', date: '2026-10-14', ts: 2, status: 'failed', message: 'b' });

    assert.deepEqual(a.recentRuns(10).map((r) => r.message), ['a']);
    assert.deepEqual(b.recentRuns(10).map((r) => r.message), ['b']);
    assert.equal(a.runsOfTask('t', { limit: 10 }).length, 1);
  });

  it('调度状态也按用户 × 账号分开', () => {
    const root = freshRoot();
    root.forUser(1).createTask('t');
    root.forUser(2).createTask('t');
    root.forUser(1).saveState('t', '', { today_target_ts: 111 });
    root.forUser(2).saveState('t', '', { today_target_ts: 222 });

    assert.equal(root.forUser(1).stateOf('t').today_target_ts, 111);
    assert.equal(root.forUser(2).stateOf('t').today_target_ts, 222);
  });

  it('调度器能跨用户遍历全部任务', () => {
    const root = freshRoot();
    root.forUser(1).createTask('t');
    root.forUser(2).createTask('u');
    const subs = root.allTasks();
    assert.equal(subs.length, 2);
    assert.deepEqual([...new Set(subs.map((s) => s.userId))].sort(), [1, 2]);
  });

  it('删号清理只影响那个人', () => {
    const root = freshRoot();
    root.forUser(1).createTask('t');
    root.forUser(2).createTask('t');
    root.forUser(1).appendRun({ taskName: 't', date: '2026-10-14', ts: 1, status: 'success' });
    root.forUser(2).appendRun({ taskName: 't', date: '2026-10-14', ts: 2, status: 'success' });

    root.purgeUser(1);
    assert.equal(root.forUser(2).recentRuns(10).length, 1, '另一个用户的数据不受影响');
    assert.deepEqual(root.allUserIds(), [2]);
  });
});

describe('资源上限（由装配层注入，本模块不读环境变量）', () => {
  it('任务数达到上限后拒绝', () => {
    const root = freshRoot({ maxSubscriptions: 2 });
    const mine = root.forUser(USER_ID);
    mine.createTask('a');
    mine.createTask('b');
    assert.throws(() => mine.createTask('c'), /上限/);
    // 改已有任务是更新，不该被名额挡住
    const a = mine.tasksOfTemplate('a')[0];
    assert.equal(mine.updateTask(a.id, { enabled: false }).enabled, false);
  });

  it('间隔低于下限直接拒绝保存', () => {
    const root = freshRoot({ minIntervalMinutes: 5 });
    const mine = root.forUser(USER_ID);
    assert.throws(
      () => mine.createTask('t', { schedule: { kind: 'every', every: { minutes: 1 } } }),
      /不能小于 5 分钟/,
    );
    const ok = mine.createTask('t', { schedule: { kind: 'every', every: { minutes: 10 } } });
    assert.equal(ok.schedule.every.minutes, 10);
    assert.throws(
      () => mine.updateTask(ok.id, { schedule: { kind: 'every', every: { minutes: 1 } } }),
      /不能小于 5 分钟/,
    );
  });

  it('同一个模板能建几个任务，也受任务总数上限约束', () => {
    const root = freshRoot({ maxSubscriptions: 3 });
    const mine = root.forUser(USER_ID);
    mine.createTask('t', { label: '一号' });
    mine.createTask('t', { label: '二号' });
    mine.createTask('t', { label: '三号' });
    assert.throws(() => mine.createTask('t', { label: '四号' }), /上限/);
  });

  it('countRunsToday 不计入 skipped（它不代表真的发出过请求）', () => {
    const store = fresh();
    run(store, { date: '2026-10-14', ts: 1, status: 'success' });
    run(store, { date: '2026-10-14', ts: 2, status: 'skipped' });
    run(store, { date: '2026-10-15', ts: 3, status: 'success' });
    assert.equal(store.countRunsToday('2026-10-14'), 1);
    assert.equal(store.countRunsToday('2026-10-15'), 1);
  });
});

describe('保留策略：先聚合、再删明细', () => {
  const NOW = Date.parse('2026-10-14T12:00:00+08:00');
  const daysAgo = (n) => NOW - n * 86_400_000;

  it('超期明细被删除，但计数留在每日统计里', () => {
    const store = fresh();
    run(store, { date: '2026-01-01', ts: daysAgo(300), status: 'success' });
    run(store, { date: '2026-01-01', ts: daysAgo(300) + 1, status: 'failed' });
    run(store, { date: '2026-01-02', ts: daysAgo(299), status: 'skipped' });
    run(store, { date: '2026-10-14', ts: NOW, status: 'success' }); // 新记录，应保留

    const res = store.pruneTask('t', { days: 90, maxRows: 2000, logDays: 30 }, NOW);

    assert.equal(res.dropped, 3);
    assert.equal(store.runsOfTask('t', { limit: 10 }).length, 1);

    const stats = Object.fromEntries(store.statsOfTask('t').map((s) => [s.date, s]));
    assert.deepEqual(stats['2026-01-01'], {
      user_id: USER_ID, // 统计也是按用户分开的
      task_name: 't',
      date: '2026-01-01',
      success: 1,
      failed: 1,
      skipped: 0,
      total: 2,
    });
    assert.equal(stats['2026-01-02'].skipped, 1);
  });

  it('统计是累加计数器：分批清理不会把已有计数抹掉', () => {
    const store = fresh();
    run(store, { date: '2026-01-01', ts: daysAgo(300), status: 'success' });
    store.pruneTask('t', { days: 90, maxRows: 2000, logDays: 30 }, NOW);
    assert.equal(store.statsOfTask('t')[0].total, 1);

    run(store, { date: '2026-01-01', ts: daysAgo(400), status: 'success' });
    store.pruneTask('t', { days: 90, maxRows: 2000, logDays: 30 }, NOW);
    assert.equal(store.statsOfTask('t')[0].total, 2);
  });

  it('按条数上限裁剪最旧的记录（天数挡不住间隔类任务的条数爆炸）', () => {
    const store = fresh();
    for (let i = 0; i < 5; i++) {
      run(store, { date: '2026-10-14', ts: NOW - i, status: 'success' });
    }
    const res = store.pruneTask('t', { days: 90, maxRows: 2, logDays: 30 }, NOW);

    assert.equal(res.dropped, 3);
    assert.equal(store.runsOfTask('t', { limit: 10 }).length, 2);
    // 保留的是最新的那两条
    assert.deepEqual(
      store.runsOfTask('t', { limit: 10 }).map((r) => r.ts),
      [NOW, NOW - 1],
    );
  });

  it('日志超期被清理，且删除运行记录会级联带走它的日志', () => {
    const store = fresh();
    const kept = run(store, { ts: NOW, date: '2026-10-14' });
    const old = run(store, { ts: daysAgo(300), date: '2026-01-01' });
    store.appendLogs(kept.id, 't', ['新的'], NOW);
    store.appendLogs(old.id, 't', ['陈旧的'], daysAgo(300));

    const res = store.pruneTask('t', { days: 90, maxRows: 2000, logDays: 30 }, NOW);

    assert.equal(res.dropped, 1);
    assert.equal(store.logsOfRun(kept.id).length, 1);
    assert.equal(store.logsOfRun(old.id).length, 0, '随运行记录级联删除');
  });

  it('没有可删的记录时不报错', () => {
    const store = fresh();
    run(store, { ts: NOW });
    const res = store.pruneTask('t', { days: 90, maxRows: 2000, logDays: 30 }, NOW);
    assert.equal(res.dropped, 0);
  });
});
