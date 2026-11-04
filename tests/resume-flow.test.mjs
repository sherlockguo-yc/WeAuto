/**
 * 续跑端到端：调度器 → 执行器 → 执行记录。
 *
 * 钉住的是这轮改造的真正目的：**一次自动执行就能完成「派出 + 归来领取」**，
 * 而不是派出后要等第二天的每日调度（改造前：早上出门、中午回来，
 * 奖励躺在服务端直到第二天早上那次调度才顺手领走）。
 *
 * 三个断言缺一不可：
 *   · 派出后必须排上续跑（否则回到了「等明天」）
 *   · 到点自动续跑，且**不新增执行记录**（用户看到的是一件事）
 *   · 领完之后彻底收尾，当天不再重复跑
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { createStore } from '../src/store.mjs';
import { createExecutor } from '../src/executor.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { targetSecondsOfDay } from '../src/schedule.mjs';
import { startOfDayBeijingMs } from '../src/util.mjs';

const USER_ID = 1;
const DAY = '2026-11-04';
const WINDOW = { start: '09:00', end: '09:50' };

/**
 * 今日目标时刻：与调度器同源，且**必须带 accountKey**。
 *
 * 账号参与种子（同一模板的多个账号要散在窗口内不同时刻），
 * 漏了这个参数就会算出另一个时刻，测试变成看运气——
 * 目标晚于测试时刻时任务根本不会到期，断言会随机失败。
 */
function targetMs(accountKey, day = DAY) {
  return startOfDayBeijingMs(day) + targetSecondsOfDay('travel', WINDOW, day, accountKey) * 1000;
}

let dir;
const dbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-resume-flow-'));
});

after(() => {
  for (const db of dbs) {
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
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)',
  ).run(USER_ID, 'tester', 'x', 'admin', 'active', 1);
  dbs.push(db);
  const store = createStore(db);
  // accountKey 是随机生成的，且参与调度种子：必须把它带出来，别自己猜
  const { accountKey } = store.forUser(USER_ID).createTask('travel');
  return { store, accountKey };
}

/**
 * 模拟 WorkBuddy 旅行任务：第一次派出并交回 resumeAt，续跑那次只领奖。
 * 用真实任务里同样的字段名，保证这条链路和线上一致。
 */
function travelTask({ resumeAt, claimMessage = '已领取 10 积分' }) {
  return {
    name: 'travel',
    displayName: '派 Buddy 旅行',
    requires: [],
    timeoutMs: 1000,
    schedule: { kind: 'window', window: WINDOW },
    run: async (ctx) =>
      ctx.trigger === 'resume'
        ? { status: 'success', message: claimMessage, data: { credit: 10 } }
        : {
            status: 'success',
            message: '已派出',
            data: { locationName: '京都' },
            resumeAt,
            resumeNote: '归来领取',
          },
  };
}

describe('续跑端到端', () => {
  it('派出 → 自动续跑领取 → 当天收尾，全程一条执行记录', async () => {
    const { store, accountKey } = fresh();
    let nowMs = targetMs(accountKey) + 1000;
    const resumeAt = nowMs + 2 * 3600_000;

    const execute = createExecutor({ store, now: () => nowMs, log: () => {} });
    const tasks = new Map([['travel', travelTask({ resumeAt })]]);
    const sch = createScheduler({ store, tasks, execute, now: () => nowMs, log: () => {} });

    /* ① 到点：派出，并排好下半场 */
    sch.tick();
    await sch.waitForIdle();

    const afterDepart = store.forUser(USER_ID);
    let runs = afterDepart.runsOfTask('travel', { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].message, '已派出');
    assert.equal(afterDepart.stateOf('travel', accountKey).resume_at, resumeAt);
    assert.equal(afterDepart.stateOf('travel', accountKey).resume_run_id, runs[0].id);

    /* ② 未到归来时刻：tick 多少次都不该发第二次请求 */
    nowMs = resumeAt - 60_000;
    sch.tick();
    await sch.waitForIdle();
    assert.equal(afterDepart.runsOfTask('travel', { limit: 10 }).length, 1);

    /* ③ 归来：自动续跑领取，写回同一条记录 */
    nowMs = resumeAt;
    sch.tick();
    await sch.waitForIdle();

    runs = afterDepart.runsOfTask('travel', { limit: 10 });
    assert.equal(runs.length, 1, '续跑不能新增记录 —— 一轮就是一件事');
    assert.equal(runs[0].message, '已领取 10 积分');
    assert.equal(runs[0].status, 'success');
    assert.equal(runs[0].dur, 2 * 3600_000, '耗时按整轮算');
    assert.equal(afterDepart.stateOf('travel', accountKey).resume_at, null);

    /* ④ 收尾：当天不再重复执行 */
    sch.tick();
    await sch.waitForIdle();
    assert.equal(afterDepart.runsOfTask('travel', { limit: 10 }).length, 1);
  });

  it('续跑跨天（服务停了一夜）：第二天先补领，再派新的一轮', async () => {
    const { store, accountKey } = fresh();
    let nowMs = targetMs(accountKey) + 1000;
    const resumeAt = nowMs + 2 * 3600_000;

    const execute = createExecutor({ store, now: () => nowMs, log: () => {} });
    const tasks = new Map([['travel', travelTask({ resumeAt })]]);
    const sch = createScheduler({ store, tasks, execute, now: () => nowMs, log: () => {} });

    sch.tick(); // 派出
    await sch.waitForIdle();

    // 进程停了一夜，第二天窗口内才恢复
    const tomorrow = '2026-11-05';
    nowMs = targetMs(accountKey, tomorrow) + 1000;
    sch.tick();
    await sch.waitForIdle();

    const mine = store.forUser(USER_ID);
    let runs = mine.runsOfTask('travel', { limit: 10 });
    assert.equal(runs.length, 1, '补领仍然写回原记录（昨天那一轮）');
    assert.equal(runs[0].message, '已领取 10 积分');
    assert.equal(mine.stateOf('travel', accountKey).resume_at, null);

    // 收尾之后的下一 tick：新一轮正常派出（昨天的记录不占今天的名额）
    sch.tick();
    await sch.waitForIdle();
    runs = mine.runsOfTask('travel', { limit: 10 });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].message, '已派出');
  });
});
