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

/** 根 store：只有跨用户的用例（遍历订阅、删号清理）才需要 */
function freshRoot() {
  return createStore(freshDb());
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

describe('订阅（用户 × 模板：没订阅就没有这个实例）', () => {
  it('未订阅时没有实例，也不是启用状态', () => {
    const store = fresh();
    assert.equal(store.getSubscription('t'), null);
    assert.equal(store.isEnabled('t'), false);
  });

  it('订阅后默认启用，并自动建一个默认账号', () => {
    const store = fresh();
    const sub = store.subscribe('t');
    assert.equal(sub.enabled, true);
    assert.deepEqual(sub.accounts.map((a) => a.accountKey), ['']);
    assert.equal(store.isEnabled('t'), true);
  });

  it('只改 enabled 不会抹掉已设置的调度', () => {
    const store = fresh();
    store.subscribe('t', { schedule: { kind: 'every', every: { minutes: 5 } } });
    store.setSubscription('t', { enabled: false });

    const o = store.getSubscription('t');
    assert.equal(o.enabled, false);
    assert.equal(o.schedule.every.minutes, 5);
  });

  it('只改调度不会把 enabled 翻回默认', () => {
    const store = fresh();
    store.subscribe('t');
    store.setSubscription('t', { enabled: false });
    store.setSubscription('t', { timeoutMs: 5000 });
    assert.equal(store.getSubscription('t').enabled, false);
  });

  it('取消订阅后实例消失', () => {
    const store = fresh();
    store.subscribe('t', { enabled: false });
    assert.equal(store.unsubscribe('t'), true);
    assert.equal(store.getSubscription('t'), null);
    assert.equal(store.isEnabled('t'), false);
    assert.equal(store.unsubscribe('t'), false); // 再删一次什么也没发生
  });
});

describe('多账号', () => {
  it('同一模板下可以配多个账号，互不干扰', () => {
    const store = fresh();
    store.subscribe('t');
    const k1 = store.addAccount('t', { label: '主号' });
    const k2 = store.addAccount('t', { label: '小号' });
    assert.notEqual(k1, k2);
    assert.equal(store.activeAccounts('t').length, 3); // 默认账号 + 两个
    assert.equal(store.removeAccount('t', k2), true);
    assert.equal(store.activeAccounts('t').length, 2);
  });

  /**
   * 这是多账号最容易踩的坑：幂等如果只按「任务 + 日期」判断，
   * A 账号成功后 B 账号会被判「今日已完成」而跳过。
   */
  it('今日是否成功按账号区分：A 成功不代表 B 成功', () => {
    const store = fresh();
    store.subscribe('t');
    const b = store.addAccount('t', { label: '小号' });
    store.appendRun({ taskName: 't', accountKey: b, date: '2026-10-14', ts: 1, status: 'success' });

    assert.equal(store.hasSuccessOn('t', '2026-10-14', b), true);
    assert.equal(store.hasSuccessOn('t', '2026-10-14', ''), false);
    assert.equal(store.hasSuccessOn('t', '2026-10-14'), false);
  });

  it('历史可以按账号筛选', () => {
    const store = fresh();
    store.subscribe('t');
    const b = store.addAccount('t', { label: '小号' });
    store.appendRun({ taskName: 't', accountKey: '', date: '2026-10-14', ts: 1, status: 'success' });
    store.appendRun({ taskName: 't', accountKey: b, date: '2026-10-14', ts: 2, status: 'success' });

    assert.equal(store.runsOfTask('t', { accountKey: b, limit: 10 }).length, 1);
    assert.equal(store.runsOfTask('t', { limit: 10 }).length, 2); // 不传就是全部账号
  });
});

describe('多租户隔离', () => {
  it('两个用户的数据互不可见', () => {
    const root = freshRoot();
    const a = root.forUser(1);
    const b = root.forUser(2);
    a.subscribe('t');
    b.subscribe('t');
    a.appendRun({ taskName: 't', date: '2026-10-14', ts: 1, status: 'success', message: 'a' });
    b.appendRun({ taskName: 't', date: '2026-10-14', ts: 2, status: 'failed', message: 'b' });

    assert.deepEqual(a.recentRuns(10).map((r) => r.message), ['a']);
    assert.deepEqual(b.recentRuns(10).map((r) => r.message), ['b']);
    assert.equal(a.runsOfTask('t', { limit: 10 }).length, 1);
  });

  it('调度状态也按用户 × 账号分开', () => {
    const root = freshRoot();
    root.forUser(1).subscribe('t');
    root.forUser(2).subscribe('t');
    root.forUser(1).saveState('t', '', { today_target_ts: 111 });
    root.forUser(2).saveState('t', '', { today_target_ts: 222 });

    assert.equal(root.forUser(1).stateOf('t').today_target_ts, 111);
    assert.equal(root.forUser(2).stateOf('t').today_target_ts, 222);
  });

  it('调度器能跨用户遍历全部订阅', () => {
    const root = freshRoot();
    root.forUser(1).subscribe('t');
    root.forUser(2).subscribe('u');
    const subs = root.allSubscriptions();
    assert.equal(subs.length, 2);
    assert.deepEqual([...new Set(subs.map((s) => s.userId))].sort(), [1, 2]);
  });

  it('删号清理只影响那个人', () => {
    const root = freshRoot();
    root.forUser(1).subscribe('t');
    root.forUser(2).subscribe('t');
    root.forUser(1).appendRun({ taskName: 't', date: '2026-10-14', ts: 1, status: 'success' });
    root.forUser(2).appendRun({ taskName: 't', date: '2026-10-14', ts: 2, status: 'success' });

    root.purgeUser(1);
    assert.equal(root.forUser(2).recentRuns(10).length, 1, '另一个用户的数据不受影响');
    assert.deepEqual(root.allUserIds(), [2]);
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
