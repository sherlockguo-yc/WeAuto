/**
 * 凭据组 —— 一个站点的一族模板共用一个「账号对象」
 *
 * 这一版把共享从「读取时兜底」换成了「引用同一个账号」：
 *   · 组只用来决定账号归属与字段并集，不再跨模板借值
 *   · 同一账号被签到与活跃同时引用 → 只存一份 token，换 key 只改一处
 *   · 不同账号各存各的 → 不会出现「取到任意一个」这种静默事故
 *
 * 第一段仍然守着契约：组名默认自成一组、非法组名在加载期报错。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { credentialGroups } from '../src/registry.mjs';
import { SecretsError } from '../src/secrets.mjs';
import { normalizeTask } from '../src/task-contract.mjs';
import { createUserSecrets, generateMasterKey, secretsLoaderFor } from '../src/user-secrets.mjs';

const USER_ID = 1;

let dir;
const dbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-credgroup-'));
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
function freshUserSecrets() {
  const db = openDb(path.join(dir, `db-${++seq}.sqlite`));
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)',
  ).run(USER_ID, 'tester', 'x', 'admin', 'active', 1);
  dbs.push(db);
  return createUserSecrets(db, generateMasterKey());
}

/** 只关心 name / displayName / requires / credentialGroup，run 用不到但契约要求存在 */
const mkTask = (name, extra = {}) =>
  normalizeTask(
    { name, displayName: name, requires: ['TOKEN'], run: async () => ({}), ...extra },
    `${name}.mjs`,
  );

describe('credentialGroup 契约', () => {
  it('不声明时自成一组，等于「不与别人共享账号」', () => {
    assert.equal(mkTask('lonely').credentialGroup, 'lonely');
  });

  it('声明后原样保留', () => {
    assert.equal(mkTask('a', { credentialGroup: 'site-x' }).credentialGroup, 'site-x');
  });

  it('组名非法时在加载期就报错', () => {
    assert.throws(() => mkTask('a', { credentialGroup: 'Site X' }), /credentialGroup 非法/);
    assert.throws(() => mkTask('a', { credentialGroup: 'UPPER' }), /credentialGroup 非法/);
    assert.throws(() => mkTask('a', { credentialGroup: '' }), /credentialGroup 非法/);
  });
});

describe('credentialGroups（账号归属的唯一来源）', () => {
  const tasks = new Map(
    [
      mkTask('wb-checkin', { credentialGroup: 'workbuddy' }),
      mkTask('wb-active', { credentialGroup: 'workbuddy', requires: ['TOKEN', 'DEVICE_ID'] }),
      mkTask('v2free-checkin', { credentialGroup: 'v2free', requires: ['EMAIL', 'PASSWORD'] }),
      mkTask('plain', { requires: [] }),
    ].map((t) => [t.name, t]),
  );

  it('同组模板合并成一个组，字段取并集', () => {
    const wb = credentialGroups(tasks).find((g) => g.group === 'workbuddy');
    assert.deepEqual(wb.taskNames.sort(), ['wb-active', 'wb-checkin']);
    assert.deepEqual(wb.fields.sort(), ['DEVICE_ID', 'TOKEN']);
    // 多模板组的标题用站点名（拼模板名会得到撑满一行、手机端折三行的长标题）
    assert.equal(wb.label, 'workbuddy');
    assert.deepEqual(wb.names.sort(), ['wb-active', 'wb-checkin']);
  });

  it('单模板组的标题用模板名（一眼认出是哪个任务）', () => {
    const v2 = credentialGroups(tasks).find((g) => g.group === 'v2free');
    assert.equal(v2.label, 'v2free-checkin');
  });

  it('每组只出现一次', () => {
    const groups = credentialGroups(tasks);
    assert.deepEqual(groups.map((g) => g.group).sort(), ['v2free', 'workbuddy']);
  });

  it('不需要凭据的模板不构成组（给它建账号是无意义的空表单）', () => {
    assert.equal(credentialGroups(tasks).some((g) => g.group === 'plain'), false);
  });
});

describe('账号共享（替代原来的跨模板兜底）', () => {
  it('两个任务引用同一个账号：只存一份，两边取到同样的值', () => {
    const us = freshUserSecrets();
    const acc = us.create(USER_ID, {
      groupName: 'workbuddy',
      label: '小号A',
      fields: { TOKEN: 'shared-token' },
    });
    const load = secretsLoaderFor(us);

    // 同一个 credentialId，两个任务名不同——结果必须一致
    assert.equal(
      load({ userId: USER_ID, taskName: 'wb-checkin', credentialId: acc.id, requires: ['TOKEN'] }).TOKEN,
      'shared-token',
    );
    assert.equal(
      load({ userId: USER_ID, taskName: 'wb-active', credentialId: acc.id, requires: ['TOKEN'] }).TOKEN,
      'shared-token',
    );
  });

  it('改一次就全生效：账号里的值更新后，两个任务都拿到新值', () => {
    const us = freshUserSecrets();
    const acc = us.create(USER_ID, { groupName: 'workbuddy', label: 'A', fields: { TOKEN: 'old' } });
    const load = secretsLoaderFor(us);
    us.set(USER_ID, acc.id, { TOKEN: 'new' });
    for (const taskName of ['wb-checkin', 'wb-active']) {
      assert.equal(load({ userId: USER_ID, taskName, credentialId: acc.id, requires: ['TOKEN'] }).TOKEN, 'new');
    }
  });

  it('两个账号各有各的 token，互不串（不再有「取任意一个」）', () => {
    const us = freshUserSecrets();
    const a = us.create(USER_ID, { groupName: 'workbuddy', label: 'A', fields: { TOKEN: 'token-a' } });
    const b = us.create(USER_ID, { groupName: 'workbuddy', label: 'B', fields: { TOKEN: 'token-b' } });
    const load = secretsLoaderFor(us);
    assert.equal(load({ userId: USER_ID, credentialId: a.id, requires: ['TOKEN'] }).TOKEN, 'token-a');
    assert.equal(load({ userId: USER_ID, credentialId: b.id, requires: ['TOKEN'] }).TOKEN, 'token-b');
  });

  it('没引用账号就是缺凭据，不会去别处借', () => {
    const us = freshUserSecrets();
    us.create(USER_ID, { groupName: 'workbuddy', label: 'A', fields: { TOKEN: 'somebody-else' } });
    const load = secretsLoaderFor(us);
    assert.throws(
      () => load({ userId: USER_ID, taskName: 'wb-active', credentialId: null, requires: ['TOKEN'] }),
      SecretsError,
    );
  });
});
