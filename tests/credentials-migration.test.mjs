/**
 * v7 迁移：任务下的凭据 → 可被任务引用的账号
 *
 * 这里守的是「升级不丢东西、也不猜错」：
 *   · 有业务字段的旧记录变成账号，密文原样搬运（解密能还原）
 *   · 只有 WEAUTO_PUSH_TOKEN 的旧记录不构成账号（那不是可用凭据）
 *   · 任务优先绑自己那份；自己没有时，同组唯一账号才自动绑（旧「兜底」的显式化）
 *   · 同组有多个账号时不猜，留空让用户选
 *   · 幂等：第二次启动不再搬
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrateCredentials } from '../src/bootstrap.mjs';
import { openDb } from '../src/db.mjs';
import { normalizeTask } from '../src/task-contract.mjs';
import { decryptValue, encryptValue, generateMasterKey } from '../src/user-secrets.mjs';

let dir;
const dbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-migrate-'));
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
  ).run(1, 'owner', 'x', 'admin', 'active', 1);

  const key = generateMasterKey();
  const insSecret = db.prepare(
    `INSERT INTO user_secrets (user_id, task_name, account_key, field, value_enc, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insTask = db.prepare(
    `INSERT INTO subscriptions
       (user_id, task_name, account_key, label, enabled, schedule_json, timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, NULL, NULL, ?, ?)`,
  );
  const now = Date.now();

  dbs.push(db);
  return {
    db,
    key,
    addSecret(taskName, accountKey, field, value) {
      insSecret.run(1, taskName, accountKey, field, encryptValue(value, key), now);
    },
    addTask(taskName, accountKey, label = '') {
      return Number(insTask.run(1, taskName, accountKey, label, now, now).lastInsertRowid);
    },
  };
}

/** workbuddy 的两个模板同组：同一把 WB_ACCESS_TOKEN */
const TASKS = new Map(
  [
    normalizeTask(
      {
        name: 'wb-checkin',
        displayName: 'WorkBuddy 签到',
        requires: ['TOKEN'],
        credentialGroup: 'workbuddy',
        run: async () => ({}),
      },
      'wb-checkin.mjs',
    ),
    normalizeTask(
      {
        name: 'wb-active',
        displayName: 'WorkBuddy 活跃',
        requires: ['TOKEN'],
        credentialGroup: 'workbuddy',
        run: async () => ({}),
      },
      'wb-active.mjs',
    ),
    normalizeTask(
      { name: 'plain', displayName: '无凭据任务', requires: [], run: async () => ({}) },
      'plain.mjs',
    ),
  ].map((t) => [t.name, t]),
);

describe('migrateCredentials', () => {
  it('有业务字段的旧记录变成账号，密文原样搬运且能解密还原', () => {
    const h = fresh();
    h.addSecret('wb-checkin', 'a-1111', 'TOKEN', 'from-checkin');
    h.addTask('wb-checkin', 'a-1111', 'WorkBuddy 签到');

    migrateCredentials({ db: h.db, tasks: TASKS });

    const acc = h.db.prepare('SELECT * FROM credentials').get();
    assert.equal(acc.group_name, 'workbuddy');
    assert.equal(acc.label, 'WorkBuddy 签到');

    const field = h.db.prepare('SELECT * FROM credential_fields WHERE credential_id = ?').get(acc.id);
    assert.equal(field.field, 'TOKEN');
    assert.equal(decryptValue(field.value_enc, h.key), 'from-checkin', '密文应可被同一个主密钥解开');
  });

  it('只有 WEAUTO_PUSH_TOKEN 的旧记录不构成账号（那不是可用凭据）', () => {
    const h = fresh();
    h.addSecret('wb-active', 'a-2222', 'WEAUTO_PUSH_TOKEN', 'wt1_1_9_secret');
    h.addTask('wb-active', 'a-2222');

    migrateCredentials({ db: h.db, tasks: TASKS });
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, 0);
  });

  it('任务自己没有账号时，绑定同组唯一账号（旧「兜底」的显式化）', () => {
    const h = fresh();
    // 签到填过 token；活跃只有一个推送令牌（旧设计里靠兜底才跑得起来）
    h.addSecret('wb-checkin', 'a-1111', 'TOKEN', 'shared');
    h.addSecret('wb-active', 'a-2222', 'WEAUTO_PUSH_TOKEN', 'wt1_1_9_secret');
    const checkin = h.addTask('wb-checkin', 'a-1111', 'WorkBuddy 签到');
    const active = h.addTask('wb-active', 'a-2222', 'WorkBuddy 活跃');

    migrateCredentials({ db: h.db, tasks: TASKS });

    const rows = h.db
      .prepare('SELECT id, credential_id FROM subscriptions ORDER BY id')
      .all();
    assert.equal(rows.length, 2);
    assert.ok(rows[0].credential_id, '签到应绑到自己那份账号');
    assert.equal(rows[1].credential_id, rows[0].credential_id, '活跃应绑到同组唯一账号');
    assert.equal(rows[0].id, checkin);
    assert.equal(rows[1].id, active);
  });

  it('两个任务各填过 token → 两个账号，各绑各的（不猜谁是同一个）', () => {
    const h = fresh();
    h.addSecret('wb-checkin', 'a-1111', 'TOKEN', 'token-checkin');
    h.addSecret('wb-active', 'a-2222', 'TOKEN', 'token-active');
    h.addTask('wb-checkin', 'a-1111', 'WorkBuddy 签到');
    h.addTask('wb-active', 'a-2222', 'WorkBuddy 活跃');

    migrateCredentials({ db: h.db, tasks: TASKS });

    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, 2);
    const rows = h.db.prepare('SELECT credential_id FROM subscriptions ORDER BY id').all();
    assert.notEqual(rows[0].credential_id, rows[1].credential_id);
  });

  it('无凭据模板的任务不绑账号', () => {
    const h = fresh();
    h.addTask('plain', 'a-3333', '无凭据');
    migrateCredentials({ db: h.db, tasks: TASKS });
    assert.equal(
      h.db.prepare('SELECT credential_id FROM subscriptions').get().credential_id,
      null,
    );
  });

  it('同组多个账号时不猜，任务留空等用户选', () => {
    const h = fresh();
    // 组里已有两个账号（签到 + 另一个也填过 token 的任务），活跃自己没有
    h.addSecret('wb-checkin', 'a-1111', 'TOKEN', 'one');
    h.addSecret('wb-checkin', 'a-9999', 'TOKEN', 'two');
    h.addTask('wb-checkin', 'a-1111', '签到一');
    h.addTask('wb-checkin', 'a-9999', '签到二');
    h.addTask('wb-active', 'a-2222', '活跃');

    migrateCredentials({ db: h.db, tasks: TASKS });
    const active = h.db
      .prepare("SELECT credential_id FROM subscriptions WHERE task_name = 'wb-active'")
      .get();
    assert.equal(active.credential_id, null, '两个账号无从判断，不能猜');
  });

  it('幂等：第二次调用直接跳过，不会重复建账号', () => {
    const h = fresh();
    h.addSecret('wb-checkin', 'a-1111', 'TOKEN', 'x');
    h.addTask('wb-checkin', 'a-1111');

    migrateCredentials({ db: h.db, tasks: TASKS });
    const before = h.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n;
    const again = migrateCredentials({ db: h.db, tasks: TASKS });
    assert.equal(again.skipped, '已迁移');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, before);
  });
});
