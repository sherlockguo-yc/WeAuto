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
function fresh() {
  const db = openDb(path.join(dir, `db-${++seq}.sqlite`));
  openDbs.push(db);
  return createStore(db);
}

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
      store.runsOfTask('t', 10).map((r) => r.ts),
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

    store.saveState('t', { today_date: '2026-10-14', today_target_ts: 111 });
    store.saveState('t', { last_run_id: r.id });

    assert.deepEqual(store.stateOf('t'), {
      today_date: '2026-10-14',
      today_target_ts: 111,
      next_due_ts: null,
      last_run_id: r.id,
    });
  });

  it('last_run_id 必须指向真实记录（外键兜住脏数据）', () => {
    const store = fresh();
    assert.throws(() => store.saveState('t', { last_run_id: 99999 }), /FOREIGN KEY/);
  });

  it('运行记录被保留策略删除后，状态里的引用自动置空而不是指向幽灵', () => {
    const store = fresh();
    const NOW = Date.parse('2026-10-14T12:00:00+08:00');
    const old = run(store, { date: '2026-01-01', ts: NOW - 300 * 86_400_000 });
    store.saveState('t', { last_run_id: old.id });

    store.pruneTask('t', { days: 90, maxRows: 2000, logDays: 30 }, NOW);
    assert.equal(store.stateOf('t').last_run_id, null);
  });
});

describe('覆盖层（代码文件是默认值，DB 只在用户改过时才有行）', () => {
  it('默认无覆盖：任务启用', () => {
    const store = fresh();
    assert.equal(store.getOverride('t'), null);
    assert.equal(store.isEnabled('t'), true);
  });

  it('只改 enabled 不会抹掉已设置的调度', () => {
    const store = fresh();
    store.setOverride('t', { schedule: { kind: 'every', every: { minutes: 5 } } });
    store.setOverride('t', { enabled: false });

    const o = store.getOverride('t');
    assert.equal(o.enabled, false);
    assert.equal(o.schedule.every.minutes, 5);
  });

  it('只改调度不会把 enabled 翻回默认', () => {
    const store = fresh();
    store.setOverride('t', { enabled: false });
    store.setOverride('t', { timeoutMs: 5000 });
    assert.equal(store.getOverride('t').enabled, false);
  });

  it('清除覆盖后回到默认', () => {
    const store = fresh();
    store.setOverride('t', { enabled: false });
    assert.equal(store.clearOverride('t'), true);
    assert.equal(store.getOverride('t'), null);
    assert.equal(store.isEnabled('t'), true);
    assert.equal(store.clearOverride('t'), false); // 再清一次什么也没发生
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
    assert.equal(store.runsOfTask('t', 10).length, 1);

    const stats = Object.fromEntries(store.statsOfTask('t').map((s) => [s.date, s]));
    assert.deepEqual(stats['2026-01-01'], {
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
    assert.equal(store.runsOfTask('t', 10).length, 2);
    // 保留的是最新的那两条
    assert.deepEqual(
      store.runsOfTask('t', 10).map((r) => r.ts),
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
