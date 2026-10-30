/**
 * 账号凭据的加密与存储
 *
 * 重点验证五件安全相关的事：
 *   · 明文不出现在库里（BLOB 是密文）
 *   · 同一个值存两次密文不同（iv 随机，不能靠比较密文判断是否改过）
 *   · 密文被篡改 / 主密钥不匹配 → 校验失败而不是解出垃圾
 *   · 用户之间拿不到对方的账号（越权在结构上不可能：每条 SQL 都带 user_id）
 *   · 加载器只交出任务声明过的字段，缺什么说清楚
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { SecretsError } from '../src/secrets.mjs';
import {
  KEY_LEN,
  UserSecretsError,
  createUserSecrets,
  decryptValue,
  encryptValue,
  generateMasterKey,
  secretsLoaderFor,
} from '../src/user-secrets.mjs';

let dir;
const dbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-secrets-'));
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
  const ins = db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)',
  );
  ins.run(1, 'a', 'x', 'admin', 'active', 1);
  ins.run(2, 'b', 'x', 'user', 'active', 1);
  dbs.push(db);
  return { db, us: createUserSecrets(db, generateMasterKey()) };
}

describe('加解密', () => {
  it('往返一致', () => {
    const key = generateMasterKey();
    const blob = encryptValue('my-password', key);
    assert.equal(decryptValue(blob, key), 'my-password');
  });

  it('同一个值两次加密结果不同（iv 随机）', () => {
    const key = generateMasterKey();
    assert.notEqual(encryptValue('same', key).toString('hex'), encryptValue('same', key).toString('hex'));
  });

  it('密文被篡改一个字节就解不开', () => {
    const key = generateMasterKey();
    const blob = encryptValue('secret', key);
    blob[blob.length - 1] ^= 0xff;
    assert.throws(() => decryptValue(blob, key), UserSecretsError);
  });

  it('换主密钥解不开', () => {
    const blob = encryptValue('secret', generateMasterKey());
    assert.throws(() => decryptValue(blob, generateMasterKey()), UserSecretsError);
  });

  it('主密钥长度不对直接报错，而不是解出空串', () => {
    assert.throws(() => encryptValue('x', Buffer.alloc(16)), UserSecretsError);
  });
});

describe('账号存储', () => {
  it('创建账号后能读回明文', () => {
    const { us } = fresh();
    const acc = us.create(1, { groupName: 'v2free', label: '主号', fields: { USERNAME: 'u1', PASSWORD: 'p1' } });
    assert.equal(acc.groupName, 'v2free');
    assert.equal(acc.label, '主号');
    assert.deepEqual(us.get(1, acc.id), { USERNAME: 'u1', PASSWORD: 'p1' });
  });

  it('库里存的是密文，明文不出现在文件中', () => {
    const { db, us } = fresh();
    us.create(1, { groupName: 'workbuddy', label: 'A', fields: { TOKEN: 'super-secret-value' } });
    const row = db.prepare('SELECT value_enc FROM credential_fields').get();
    assert.ok(Buffer.isBuffer(row.value_enc));
    assert.equal(row.value_enc.includes('super-secret-value'), false);
  });

  it('字段状态只给「有没有」，不给值', () => {
    const { us } = fresh();
    const acc = us.create(1, { groupName: 'g', label: 'A', fields: { A: '1' } });
    assert.deepEqual(us.missing(1, acc.id, ['A', 'B']), ['B']);
    assert.deepEqual(us.fieldNames(1, acc.id), ['A']);
  });

  it('留空表示删除这个字段，而不是写入空串', () => {
    const { us } = fresh();
    const acc = us.create(1, { groupName: 'g', label: 'A', fields: { A: '1', B: '2' } });
    us.set(1, acc.id, { A: '' });
    assert.deepEqual(us.get(1, acc.id), { B: '2' });
  });

  it('两个用户各自一份，互相看不到也改不到', () => {
    const { us } = fresh();
    const a = us.create(1, { groupName: 'g', label: 'A', fields: { TOKEN: 'a-token' } });
    const b = us.create(2, { groupName: 'g', label: 'B', fields: { TOKEN: 'b-token' } });
    assert.deepEqual(us.get(1, a.id), { TOKEN: 'a-token' });
    assert.deepEqual(us.get(2, b.id), { TOKEN: 'b-token' });
    // 越过 user_id 直接读别人的 id：只能拿到空，不能拿到值
    assert.deepEqual(us.get(1, b.id), {});
    assert.equal(us.getCredential(1, b.id), null);
    assert.equal(us.labelOf(1, b.id), '');
    assert.equal(us.remove(1, b.id), false);
  });

  it('同一用户的两个账号各存各的值（不再有「取任意一个」）', () => {
    const { us } = fresh();
    const one = us.create(1, { groupName: 'workbuddy', label: '小号A', fields: { TOKEN: 'one' } });
    const two = us.create(1, { groupName: 'workbuddy', label: '小号B', fields: { TOKEN: 'two' } });
    assert.equal(us.get(1, one.id).TOKEN, 'one');
    assert.equal(us.get(1, two.id).TOKEN, 'two');
  });

  it('同组重名自动加序号，不打断用户', () => {
    const { us } = fresh();
    const a = us.create(1, { groupName: 'g', label: '小号' });
    const b = us.create(1, { groupName: 'g', label: '小号' });
    assert.equal(a.label, '小号');
    assert.equal(b.label, '小号 2');
    // 跨组同名互不影响
    const c = us.create(1, { groupName: 'other', label: '小号' });
    assert.equal(c.label, '小号');
  });

  it('改名会避开同组已有名字', () => {
    const { us } = fresh();
    us.create(1, { groupName: 'g', label: 'A' });
    const b = us.create(1, { groupName: 'g', label: 'B' });
    assert.equal(us.rename(1, b.id, 'A').label, 'A 2');
  });

  it('删账号只删那一个，删用户清掉全部', () => {
    const { db, us } = fresh();
    const one = us.create(1, { groupName: 'g', label: 'A', fields: { TOKEN: 'one' } });
    const two = us.create(1, { groupName: 'g', label: 'B', fields: { TOKEN: 'two' } });
    us.create(2, { groupName: 'g', label: 'C', fields: { TOKEN: 'other' } });

    assert.equal(us.remove(1, one.id), true);
    assert.deepEqual(us.get(1, one.id), {});
    assert.equal(us.get(1, two.id).TOKEN, 'two');
    // 字段行也要一起清（外键 CASCADE 在本项目没开启，靠模块自己删）
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credential_fields WHERE credential_id = ?').get(one.id).n, 0);

    us.removeUser(1);
    assert.deepEqual(us.list(1), []);
    assert.equal(us.list(2).length, 1);
  });

  it('list 只回字段名与元信息，不含值', () => {
    const { us } = fresh();
    us.create(1, { groupName: 'workbuddy', label: 'A', fields: { TOKEN: 'secret' } });
    const [acc] = us.list(1);
    assert.deepEqual(acc.fields, ['TOKEN']);
    assert.equal(JSON.stringify(acc).includes('secret'), false);
  });
});

describe('secretsLoaderFor', () => {
  it('只交出任务声明过的字段，不多给', () => {
    const { us } = fresh();
    const acc = us.create(1, { groupName: 'g', label: 'A', fields: { TOKEN: 't', EXTRA: 'e' } });
    const load = secretsLoaderFor(us);
    assert.deepEqual(load({ userId: 1, credentialId: acc.id, requires: ['TOKEN'] }), { TOKEN: 't' });
  });

  it('没选账号时抛 SecretsError，提示去选账号', () => {
    const { us } = fresh();
    const load = secretsLoaderFor(us);
    assert.throws(
      () => load({ userId: 1, credentialId: null, requires: ['TOKEN'] }),
      (err) => err instanceof SecretsError && /选择账号/.test(err.message),
    );
  });

  it('账号缺字段时错误消息里点名账号与缺哪个字段', () => {
    const { us } = fresh();
    const acc = us.create(1, { groupName: 'g', label: '小号A', fields: { A: '1' } });
    const load = secretsLoaderFor(us);
    assert.throws(
      () => load({ userId: 1, credentialId: acc.id, requires: ['A', 'B'] }),
      (err) => err instanceof SecretsError && /小号A/.test(err.message) && /B/.test(err.message),
    );
  });

  it('无凭据模板直接返回空对象，不要求账号', () => {
    const { us } = fresh();
    const load = secretsLoaderFor(us);
    assert.deepEqual(load({ userId: 1, credentialId: null, requires: [] }), {});
  });
});

describe('主密钥', () => {
  it('生成的是 32 字节', () => {
    assert.equal(generateMasterKey().length, KEY_LEN);
  });
});
