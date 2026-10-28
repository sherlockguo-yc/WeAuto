/**
 * 凭据组 —— 同一站点的一族模板共用一把钥匙
 *
 * 起因很具体：WorkBuddy 的「签到」和「活跃」都需要同一个 WB_ACCESS_TOKEN，
 * 让用户抓两遍没有意义，而存两份又会导致换 key 时漏改一处。
 *
 * 这里守住三件事：
 *   1. 默认自成一组（不写 credentialGroup 的模板行为与改造前完全一致）
 *   2. 只跨「声明了同一组」的模板兜底，绝不按字段名猜
 *   3. 自己配的值优先，兄弟模板只是补位
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { credentialPeers } from '../src/registry.mjs';
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

/** 只关心 name / credentialGroup，run 用不到但契约要求存在 */
const mkTask = (name, extra = {}) =>
  normalizeTask({ name, displayName: name, requires: ['TOKEN'], run: async () => ({}) ,...extra }, `${name}.mjs`);

describe('credentialGroup 契约', () => {
  it('不声明时自成一组，等于「不去找别人」', () => {
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

describe('credentialPeers', () => {
  const tasks = new Map(
    [
      mkTask('wb-checkin', { credentialGroup: 'workbuddy' }),
      mkTask('wb-active', { credentialGroup: 'workbuddy' }),
      mkTask('wb-other', { credentialGroup: 'workbuddy' }),
      mkTask('v2free'),
    ].map((t) => [t.name, t]),
  );

  it('返回同组的其它模板，不含自己', () => {
    assert.deepEqual(credentialPeers(tasks, 'wb-checkin').sort(), ['wb-active', 'wb-other']);
  });

  it('单独成组的模板没有兄弟', () => {
    assert.deepEqual(credentialPeers(tasks, 'v2free'), []);
  });

  it('未知模板返回空数组而不是抛错', () => {
    assert.deepEqual(credentialPeers(tasks, 'nope'), []);
  });
});

describe('secretsLoaderFor 跨组兜底', () => {
  it('自己没填时用兄弟模板的字段', () => {
    const us = freshUserSecrets();
    us.set(USER_ID, 'wb-checkin', '', { TOKEN: 'from-checkin' });

    const load = secretsLoaderFor(us, () => ['wb-checkin']);
    assert.equal(load({ userId: USER_ID, taskName: 'wb-active', requires: ['TOKEN'] }).TOKEN, 'from-checkin');
  });

  it('自己填了就用自己那份，不被兄弟覆盖', () => {
    const us = freshUserSecrets();
    us.set(USER_ID, 'wb-checkin', '', { TOKEN: 'from-checkin' });
    us.set(USER_ID, 'wb-active', '', { TOKEN: 'from-active' });

    const load = secretsLoaderFor(us, () => ['wb-checkin']);
    assert.equal(load({ userId: USER_ID, taskName: 'wb-active', requires: ['TOKEN'] }).TOKEN, 'from-active');
  });

  it('只补缺的字段，不从兄弟那里多拿没用到的字段', () => {
    const us = freshUserSecrets();
    us.set(USER_ID, 'wb-checkin', '', { TOKEN: 'a', EXTRA: 'b' });
    us.set(USER_ID, 'wb-active', '', { USERNAME: 'me' });

    const load = secretsLoaderFor(us, () => ['wb-checkin']);
    const got = load({ userId: USER_ID, taskName: 'wb-active', requires: ['USERNAME', 'TOKEN'] });
    assert.deepEqual(got, { USERNAME: 'me', TOKEN: 'a' });
  });

  it('谁都没填时仍然抛 SecretsError（错误消息里点名缺哪个字段）', () => {
    const us = freshUserSecrets();
    const load = secretsLoaderFor(us, () => ['wb-checkin']);
    assert.throws(
      () => load({ userId: USER_ID, taskName: 'wb-active', requires: ['TOKEN'] }),
      (err) => err instanceof SecretsError && /TOKEN/.test(err.message),
    );
  });

  it('没传 peersOf 时行为与改造前一致：不跨任务找', () => {
    const us = freshUserSecrets();
    us.set(USER_ID, 'wb-checkin', '', { TOKEN: 'from-checkin' });
    const load = secretsLoaderFor(us);
    assert.throws(() => load({ userId: USER_ID, taskName: 'wb-active', requires: ['TOKEN'] }), SecretsError);
  });
});

/**
 * 界面上的「待填凭据」标记走的是另一条路径（不解密、只看字段名）。
 * 两处判据必须一致，否则会出现「标着待填凭据，却每天正常跑」的矛盾状态。
 */
describe('missingWithPeers（界面标记用）', () => {
  it('兄弟模板配过同名字段时不再标「缺」', () => {
    const us = freshUserSecrets();
    us.set(USER_ID, 'wb-checkin', '', { TOKEN: 'x' });
    assert.deepEqual(us.missingWithPeers(USER_ID, 'wb-active', '', ['TOKEN'], ['wb-checkin']), []);
    assert.deepEqual(us.missingWithPeers(USER_ID, 'wb-active', '', ['TOKEN'], []), ['TOKEN']);
  });

  it('兄弟的字段名不同时仍算缺', () => {
    const us = freshUserSecrets();
    us.set(USER_ID, 'wb-checkin', '', { OTHER: 'x' });
    assert.deepEqual(us.missingWithPeers(USER_ID, 'wb-active', '', ['TOKEN'], ['wb-checkin']), ['TOKEN']);
  });

  it('多个兄弟中任意一个满足即可', () => {
    const us = freshUserSecrets();
    us.set(USER_ID, 'third', '', { TOKEN: 'x' });
    assert.deepEqual(
      us.missingWithPeers(USER_ID, 'wb-active', '', ['TOKEN'], ['wb-checkin', 'third']),
      [],
    );
  });
});
