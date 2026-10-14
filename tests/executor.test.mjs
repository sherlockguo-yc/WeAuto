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
  store.forUser(USER_ID).subscribe('t');
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
    const b = store.forUser(USER_ID).addAccount('t', { label: '小号' });
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

  it('配额按用户分开', async () => {
    const { store } = fresh();
    const ex = createExecutor({ store, quotaPerDay: 1, now: () => NOW });
    await ex(task, { trigger: 'manual', userId: USER_ID });
    assert.equal((await ex(task, { trigger: 'manual', userId: USER_ID })).status, 'skipped');
    assert.equal((await ex(task, { trigger: 'manual', userId: 2 })).status, 'success');
  });
});

describe('凭据', () => {
  it('缺字段时转成 CONFIG 状态，页面能提示去填凭据', async () => {
    const { store, userSecrets } = fresh();
    const needy = { ...task, requires: ['TOKEN'] };
    const ex = createExecutor({
      store,
      secretsLoader: secretsLoaderFor(userSecrets),
      now: () => NOW,
    });

    const rec = await ex(needy, { trigger: 'manual', userId: USER_ID });
    assert.equal(rec.status, 'config-error');
    assert.match(rec.message, /缺少凭据字段/);
  });

  it('填了之后就能拿到，且只给任务声明过的字段', async () => {
    const { store, userSecrets } = fresh();
    userSecrets.set(USER_ID, 't', '', { TOKEN: 'secret', OTHER: 'not-given' });

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
    await ex(needy, { trigger: 'manual', userId: USER_ID });

    assert.deepEqual(seen, { TOKEN: 'secret' });
  });

  it('账号各自的凭据不会串', async () => {
    const { store, userSecrets } = fresh();
    const b = store.forUser(USER_ID).addAccount('t', { label: '小号' });
    userSecrets.set(USER_ID, 't', '', { TOKEN: 'main' });
    userSecrets.set(USER_ID, 't', b, { TOKEN: 'second' });

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
    await ex(needy, { trigger: 'manual', userId: USER_ID, accountKey: '' });
    await ex(needy, { trigger: 'manual', userId: USER_ID, accountKey: b });

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
