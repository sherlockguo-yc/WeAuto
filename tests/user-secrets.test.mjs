/**
 * 每用户凭据的加密与存储
 *
 * 重点验证四件安全相关的事：
 *   · 明文不出现在库里（BLOB 是密文）
 *   · 同一个值存两次密文不同（iv 随机，不能靠比较密文判断是否改过）
 *   · 密文被篡改 / 主密钥不匹配 → 校验失败而不是解出垃圾
 *   · 用户之间拿不到对方的凭据
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import {
  KEY_LEN,
  UserSecretsError,
  createUserSecrets,
  decryptValue,
  encryptValue,
  generateMasterKey,
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

describe('存库', () => {
  it('写入后能读回明文', () => {
    const { us } = fresh();
    us.set(1, 'v2free-checkin', '', { USERNAME: 'u1', PASSWORD: 'p1' });
    assert.deepEqual(us.get(1, 'v2free-checkin', ''), { USERNAME: 'u1', PASSWORD: 'p1' });
  });

  it('库里存的是密文，明文不出现在文件中', () => {
    const { db, us } = fresh();
    us.set(1, 't', '', { TOKEN: 'super-secret-value' });
    const row = db.prepare('SELECT value_enc FROM user_secrets WHERE user_id = 1').get();
    assert.ok(Buffer.isBuffer(row.value_enc));
    assert.equal(row.value_enc.includes('super-secret-value'), false);
  });

  it('字段状态只给「有没有」，不给值', () => {
    const { us } = fresh();
    us.set(1, 't', '', { A: '1' });
    assert.deepEqual(us.fieldStatus(1, 't', '', ['A', 'B']), { A: true, B: false });
    assert.deepEqual(us.missing(1, 't', '', ['A', 'B']), ['B']);
  });

  it('留空表示删除这个字段，而不是写入空串', () => {
    const { us } = fresh();
    us.set(1, 't', '', { A: '1', B: '2' });
    us.set(1, 't', '', { A: '' });
    assert.deepEqual(us.get(1, 't', ''), { B: '2' });
  });

  it('两个用户的凭据互不可见', () => {
    const { us } = fresh();
    us.set(1, 't', '', { TOKEN: 'a-token' });
    us.set(2, 't', '', { TOKEN: 'b-token' });
    assert.deepEqual(us.get(1, 't', ''), { TOKEN: 'a-token' });
    assert.deepEqual(us.get(2, 't', ''), { TOKEN: 'b-token' });
  });

  it('同一用户的两个账号各自一份凭据', () => {
    const { us } = fresh();
    us.set(1, 't', 'a-1', { TOKEN: 'one' });
    us.set(1, 't', 'a-2', { TOKEN: 'two' });
    assert.equal(us.get(1, 't', 'a-1').TOKEN, 'one');
    assert.equal(us.get(1, 't', 'a-2').TOKEN, 'two');
  });

  it('删账号只删那一个，删用户清掉全部', () => {
    const { us } = fresh();
    us.set(1, 't', 'a-1', { TOKEN: 'one' });
    us.set(1, 't', 'a-2', { TOKEN: 'two' });
    us.set(2, 't', '', { TOKEN: 'other' });

    assert.equal(us.removeAccount(1, 't', 'a-1'), true);
    assert.deepEqual(us.get(1, 't', 'a-1'), {});
    assert.equal(us.get(1, 't', 'a-2').TOKEN, 'two');

    us.removeUser(1);
    assert.deepEqual(us.accountsOf(1), []);
    assert.equal(us.get(2, 't', '').TOKEN, 'other');
  });
});

describe('主密钥', () => {
  it('生成的是 32 字节', () => {
    assert.equal(generateMasterKey().length, KEY_LEN);
  });
});
