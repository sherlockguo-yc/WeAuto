/**
 * 执行器测试
 *
 * 重点：
 *   · 幂等按「用户 + 任务 + 账号」判断，不能让 A 账号的成功挡住 B 账号
 *   · 配额超限要留下一条看得见的 skipped，而不是静默不跑
 *   · 凭据缺失转成 CONFIG 状态（页面能提示「去填凭据」），而不是 FAILED
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { createStore } from '../src/store.mjs';
import { createExecutor } from '../src/executor.mjs';
import { SecretsError } from '../src/secrets.mjs';
import { secretsLoaderFor, createUserSecrets, generateMasterKey } from '../src/user-secrets.mjs';

const USER_ID = 1;
const NOW = Date.parse('2026-10-14T12:00:00+08:00');

let dir;
const dbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-executor-'));
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
function fresh({ limits } = {}) {
  const db = openDb(path.join(dir, `db-${++seq}.sqlite`));
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)',
  ).run(USER_ID, 'tester', 'x', 'admin', 'active', 1);
  dbs.push(db);
  const store = createStore(db, { limits });
  store.forUser(USER_ID).createTask('t', { accountKey: '' });
  return { db, store, userSecrets: createUserSecrets(db, generateMasterKey()) };
}

const task = {
  name: 't',
  displayName: '演示',
  requires: [],
  timeoutMs: 1000,
  run: async () => ({ status: 'success', message: 'ok' }),
};

describe('幂等', () => {
  it('调度触发当天已成功就跳过；手动触发不受限制', async () => {
    const { store } = fresh();
    const ex = createExecutor({ store, now: () => NOW });

    assert.ok(await ex(task, { trigger: 'schedule', userId: USER_ID }));
    assert.equal(await ex(task, { trigger: 'schedule', userId: USER_ID }), null);
    assert.ok(await ex(task, { trigger: 'manual', userId: USER_ID }));
  });

  it('按账号区分：一个账号成功不影响另一个账号', async () => {
    const { store } = fresh();
    const b = store.forUser(USER_ID).createTask('t', { label: '小号' }).accountKey;
    const ex = createExecutor({ store, now: () => NOW });

    assert.ok(await ex(task, { trigger: 'schedule', userId: USER_ID, accountKey: '' }));
    assert.equal(await ex(task, { trigger: 'schedule', userId: USER_ID, accountKey: '' }), null);
    assert.ok(await ex(task, { trigger: 'schedule', userId: USER_ID, accountKey: b }), '另一个账号应照常执行');
  });

  it('不同用户互不影响', async () => {
    const { store } = fresh();
    const ex = createExecutor({ store, now: () => NOW });
    assert.ok(await ex(task, { trigger: 'schedule', userId: USER_ID }));
    // 用户 2 没有订阅也能跑（配额与幂等只按自己的记录判断），但记录归属正确
    const rec = await ex(task, { trigger: 'manual', userId: 2 });
    assert.equal(rec.userId, 2);
  });
});

describe('配额', () => {
  it('超过每日上限后留下一条 skipped，并说明原因', async () => {
    const { store } = fresh();
    const ex = createExecutor({ store, quotaPerDay: 2, now: () => NOW });

    await ex(task, { trigger: 'manual', userId: USER_ID });
    await ex(task, { trigger: 'manual', userId: USER_ID });
    const third = await ex(task, { trigger: 'manual', userId: USER_ID });

    assert.equal(third.status, 'skipped');
    assert.match(third.message, /配额/);
  });

  it('skipped 不计入配额（它没有真的发出请求）', async () => {
    const { store } = fresh();
    const ex = createExecutor({ store, quotaPerDay: 2, now: () => NOW });
    await ex(task, { trigger: 'manual', userId: USER_ID });
    await ex(task, { trigger: 'manual', userId: USER_ID });
    assert.equal(store.forUser(USER_ID).countRunsToday('2026-10-14'), 2);
  });

  it('超限提示当天只写一条（否则每 30 秒一条，一天近三千条）', async () => {
    const { store } = fresh();
    const ex = createExecutor({ store, quotaPerDay: 1, now: () => NOW });

    await ex(task, { trigger: 'manual', userId: USER_ID });
    const first = await ex(task, { trigger: 'manual', userId: USER_ID });
    assert.equal(first.status, 'skipped');

    const second = await ex(task, { trigger: 'manual', userId: USER_ID });
    assert.equal(second, null, '之后再触发就不再写记录');

    const runs = store.forUser(USER_ID).runsOfTask('t', { limit: 20 });
    assert.equal(runs.filter((r) => r.status === 'skipped').length, 1);
  });

  it('配额按用户分开', async () => {
    const { store } = fresh();
    const ex = createExecutor({ store, quotaPerDay: 1, now: () => NOW });
    await ex(task, { trigger: 'manual', userId: USER_ID });
    assert.equal((await ex(task, { trigger: 'manual', userId: USER_ID })).status, 'skipped');
    assert.equal((await ex(task, { trigger: 'manual', userId: 2 })).status, 'success');
  });
});

/**
 * 续跑：一轮业务拆成两次 run（派出 → 几小时后回来领）。
 *
 * 钉住三件事：
 *   · 结果写回**同一条**记录，历史里不该出现两条 success
 *   · 续跑不被「今日已完成」挡住（派出那次就是今天的成功记录）
 *   · 失败有上限地重排，不能靠续跑把进程拖到第二天
 */
describe('续跑', () => {
  /** 造一个「第一次派出、续跑时领取」的任务 */
  function travelTask(resumeAt, claimResult = { status: 'success', message: '已领取 10 积分' }) {
    return {
      ...task,
      run: async (ctx) =>
        ctx.trigger === 'resume'
          ? claimResult
          : { status: 'success', message: '已派出', resumeAt, resumeNote: '归来领取' },
    };
  }

  it('任务返回 resumeAt → 写进调度状态，并指向这条记录', async () => {
    const { store } = fresh();
    const resumeAt = NOW + 2 * 3600_000;
    const ex = createExecutor({ store, now: () => NOW });

    const rec = await ex(travelTask(resumeAt), { trigger: 'schedule', userId: USER_ID });
    const state = store.forUser(USER_ID).stateOf('t');
    assert.equal(state.resume_at, resumeAt);
    assert.equal(state.resume_note, '归来领取');
    assert.equal(state.resume_run_id, rec.id);
    assert.equal(state.resume_tries, 0);
  });

  it('续跑写回同一条记录，不新增行；成功后清空续跑', async () => {
    const { store } = fresh();
    const resumeAt = NOW + 2 * 3600_000;
    let nowMs = NOW;
    const ex = createExecutor({ store, now: () => nowMs });
    const t = travelTask(resumeAt);

    const first = await ex(t, { trigger: 'schedule', userId: USER_ID });
    nowMs = resumeAt;
    const second = await ex(t, { trigger: 'resume', userId: USER_ID });

    assert.equal(second.id, first.id, '续跑必须写回原记录');
    assert.equal(second.message, '已领取 10 积分');
    assert.equal(second.dur, 2 * 3600_000, '耗时按整轮算，不是第二次请求的耗时');
    assert.equal(store.forUser(USER_ID).runsOfTask('t', { limit: 10 }).length, 1);

    const state = store.forUser(USER_ID).stateOf('t');
    assert.equal(state.resume_at, null);
    assert.equal(state.resume_run_id, null);
  });

  it('续跑不被「今日已完成」挡住（手动触发才有这条闸）', async () => {
    const { store } = fresh();
    const resumeAt = NOW + 3600_000;
    let nowMs = NOW;
    const ex = createExecutor({ store, now: () => nowMs });
    const t = travelTask(resumeAt);

    await ex(t, { trigger: 'schedule', userId: USER_ID });
    // 同一天、已有 success 记录，仍然必须能续跑
    nowMs = resumeAt;
    const rec = await ex(t, { trigger: 'resume', userId: USER_ID });
    assert.ok(rec);
    assert.equal(rec.status, 'success');
  });

  it('续跑失败 → 排到 10 分钟后重试，达到上限后彻底清空', async () => {
    const { store } = fresh();
    const resumeAt = NOW + 3600_000;
    let nowMs = NOW;
    const ex = createExecutor({ store, now: () => nowMs, log: () => {} });
    const t = travelTask(resumeAt, { status: 'network-error', message: 'socket hang up' });

    await ex(t, { trigger: 'schedule', userId: USER_ID });

    for (let i = 0; i < 3; i++) {
      const state = store.forUser(USER_ID).stateOf('t');
      assert.ok(state.resume_at, `第 ${i + 1} 次续跑前应仍有排期`);
      nowMs = state.resume_at;
      await ex(t, { trigger: 'resume', userId: USER_ID });
    }

    const state = store.forUser(USER_ID).stateOf('t');
    assert.equal(state.resume_at, null, '超过次数上限就不再重排');
    assert.equal(state.resume_tries, 0);
  });

  it('续跑失败但未达上限时，下一次排期是 10 分钟后', async () => {
    const { store } = fresh();
    const resumeAt = NOW + 3600_000;
    let nowMs = NOW;
    const ex = createExecutor({ store, now: () => nowMs, log: () => {} });
    const t = travelTask(resumeAt, { status: 'network-error', message: 'boom' });

    await ex(t, { trigger: 'schedule', userId: USER_ID });
    nowMs = resumeAt;
    await ex(t, { trigger: 'resume', userId: USER_ID });

    const state = store.forUser(USER_ID).stateOf('t');
    assert.equal(state.resume_at, nowMs + 10 * 60_000);
    assert.equal(state.resume_tries, 1);
  });

  it('手动执行不会清掉已排好的续跑（点一下看看状态，不该毁掉几小时后的自动领取）', async () => {
    const { store } = fresh();
    const resumeAt = NOW + 2 * 3600_000;
    const ex = createExecutor({ store, now: () => NOW });
    const t = {
      ...task,
      run: async (ctx) =>
        ctx.trigger === 'resume'
          ? { status: 'success', message: '已领取' }
          : { status: 'success', message: '已派出', resumeAt, resumeNote: '归来领取' },
    };

    await ex(t, { trigger: 'schedule', userId: USER_ID });
    // 手动再跑一次，这次任务什么都没给（比如状态还是 traveling）
    await ex(t, { trigger: 'manual', userId: USER_ID });

    assert.equal(store.forUser(USER_ID).stateOf('t').resume_at, resumeAt);
  });

  it('任务给出的时间太近/太远都不认（防止把状态表当定时器用）', async () => {
    for (const resumeAt of [NOW + 1000, NOW + 48 * 3600_000]) {
      const { store } = fresh();
      const ex = createExecutor({ store, now: () => NOW });
      await ex(
        { ...task, run: async () => ({ status: 'success', message: 'ok', resumeAt }) },
        { trigger: 'manual', userId: USER_ID },
      );
      assert.equal(store.forUser(USER_ID).stateOf('t').resume_at ?? null, null);
    }
  });
});

describe('凭据', () => {
  it('没选账号时转成 CONFIG 状态，页面能提示去选账号', async () => {
    const { store, userSecrets } = fresh();
    const needy = { ...task, requires: ['TOKEN'] };
    const ex = createExecutor({
      store,
      secretsLoader: secretsLoaderFor(userSecrets),
      now: () => NOW,
    });

    const rec = await ex(needy, { trigger: 'manual', userId: USER_ID });
    assert.equal(rec.status, 'config-error');
    assert.match(rec.message, /选择账号/);
  });

  it('选了账号就能拿到，且只给任务声明过的字段', async () => {
    const { store, userSecrets } = fresh();
    const acc = userSecrets.create(USER_ID, {
      groupName: 't',
      label: 'A',
      fields: { TOKEN: 'secret', OTHER: 'not-given' },
    });

    const seen = {};
    const needy = {
      ...task,
      requires: ['TOKEN'],
      run: async (ctx) => {
        Object.assign(seen, ctx.secrets);
        return { status: 'success' };
      },
    };
    const ex = createExecutor({ store, secretsLoader: secretsLoaderFor(userSecrets), now: () => NOW });
    await ex(needy, { trigger: 'manual', userId: USER_ID, credentialId: acc.id });

    assert.deepEqual(seen, { TOKEN: 'secret' });
  });

  it('账号各自的凭据不会串', async () => {
    const { store, userSecrets } = fresh();
    const a = userSecrets.create(USER_ID, { groupName: 't', label: 'A', fields: { TOKEN: 'main' } });
    const b = userSecrets.create(USER_ID, { groupName: 't', label: 'B', fields: { TOKEN: 'second' } });

    const seen = [];
    const needy = {
      ...task,
      requires: ['TOKEN'],
      run: async (ctx) => {
        seen.push(ctx.secrets.TOKEN);
        return { status: 'success' };
      },
    };
    const ex = createExecutor({ store, secretsLoader: secretsLoaderFor(userSecrets), now: () => NOW });
    await ex(needy, { trigger: 'manual', userId: USER_ID, credentialId: a.id });
    await ex(needy, { trigger: 'manual', userId: USER_ID, credentialId: b.id });

    assert.deepEqual(seen, ['main', 'second']);
  });

  it('SecretsError 以外的异常记为网络问题，不冒充凭据问题', async () => {
    const { store } = fresh();
    const boom = { ...task, run: async () => { throw new Error('connect ECONNREFUSED'); } };
    const ex = createExecutor({ store, now: () => NOW });
    const rec = await ex(boom, { trigger: 'manual', userId: USER_ID });
    assert.equal(rec.status, 'network-error');
  });

  it('加载器抛 SecretsError 时不会被当成未捕获异常', async () => {
    const { store } = fresh();
    const ex = createExecutor({
      store,
      secretsLoader: () => {
        throw new SecretsError('没有密文文件');
      },
      now: () => NOW,
    });
    const rec = await ex({ ...task, requires: ['X'] }, { trigger: 'manual', userId: USER_ID });
    assert.equal(rec.status, 'config-error');
  });
});
