/**
 * 登录模块集成测试（真实 SQLite，每个用例独立临时库）
 *
 * 每个用例开一个新库而不是复用：用户表是全局唯一状态，
 * 共享一个库时「上一条用例注册的用户」会悄悄影响下一条的判断。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { createAuth } from '../src/auth/index.mjs';

const SECRET = 'unit-test-secret';

let dir;
const openDbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-auth-store-'));
});

after(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* 用例内已关闭 */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
/** 每个用例一个全新库 */
function fresh() {
  const file = path.join(dir, `db-${++seq}.sqlite`);
  const db = openDb(file);
  openDbs.push(db);
  return { db, file, auth: createAuth({ db, jwtSecret: SECRET }) };
}

const PW = 'pass-word-1';

describe('登录', () => {
  it('注册后可登录，token 可验签', () => {
    const { auth } = fresh();
    const reg = auth.register({ username: 'sherlockguo', password: PW, role: 'admin' });
    assert.equal(reg.ok, true);

    const res = auth.login('sherlockguo', PW);
    assert.equal(res.ok, true);
    assert.deepEqual(
      { id: res.user.id, username: res.user.username, role: res.user.role, status: res.user.status },
      { id: reg.user.id, username: 'sherlockguo', role: 'admin', status: 'active' },
    );
    assert.equal(auth.verify(res.token).username, 'sherlockguo');
  });

  it('密码错误与用户不存在返回完全相同的错误（防枚举）', () => {
    const { auth } = fresh();
    auth.register({ username: 'someone', password: PW });

    const wrongPass = auth.login('someone', 'wrong-pass');
    const noUser = auth.login('nobody', 'whatever-1');
    assert.equal(wrongPass.ok, false);
    assert.equal(noUser.ok, false);
    assert.equal(wrongPass.error, noUser.error);
    assert.equal(wrongPass.code, 'invalid');
  });

  it('空用户名或空密码直接拒绝', () => {
    const { auth } = fresh();
    assert.equal(auth.login('', 'x').code, 'invalid');
    assert.equal(auth.login('a', '').code, 'invalid');
  });

  it('停用账号拒绝登录，恢复后可登录', () => {
    const { auth } = fresh();
    auth.register({ username: 'temp', password: PW });
    const u = auth.listUsers()[0];

    auth.setStatus(u.id, 'disabled');
    const denied = auth.login('temp', PW);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'disabled'); // 与「密码错」可区分：账号确实存在且被停用

    auth.setStatus(u.id, 'active');
    assert.equal(auth.login('temp', PW).ok, true);
  });

  it('登录会更新 last_login_at', () => {
    const { auth } = fresh();
    auth.register({ username: 'stamp', password: PW });
    assert.equal(auth.listUsers()[0].lastLoginAt, null);

    auth.login('stamp', PW);
    assert.ok(auth.listUsers()[0].lastLoginAt > 0);
  });
});

describe('账号管理', () => {
  it('重复用户名被拒绝', () => {
    const { auth } = fresh();
    auth.register({ username: 'dup', password: PW });
    assert.equal(auth.register({ username: 'dup', password: PW }).code, 'exists');
  });

  it('非法用户名与短密码被拒绝', () => {
    const { auth } = fresh();
    assert.equal(auth.register({ username: 'okname', password: '123' }).ok, false);
    assert.equal(auth.register({ username: 'a', password: PW }).ok, false);
    assert.equal(auth.register({ username: 'has space', password: PW }).ok, false);
    assert.equal(auth.register({ username: '郭某', password: PW }).ok, true); // 中文允许
  });

  it('listUsers 不含 password_hash', () => {
    const { auth } = fresh();
    auth.register({ username: 'u1', password: PW });
    const [u] = auth.listUsers();
    assert.equal(u.username, 'u1');
    assert.equal('password_hash' in u, false);
  });

  it('改密码后旧密码失效、新密码生效', () => {
    const { auth } = fresh();
    auth.register({ username: 'pwd', password: 'old-pass-11' });
    const u = auth.listUsers()[0];

    assert.equal(auth.setPassword(u.id, '123').ok, false); // 太短
    assert.equal(auth.setPassword(u.id, 'new-pass-22').ok, true);

    assert.equal(auth.login('pwd', 'old-pass-11').ok, false);
    assert.equal(auth.login('pwd', 'new-pass-22').ok, true);
  });

  it('删除账号后无法登录', () => {
    const { auth } = fresh();
    auth.register({ username: 'gone', password: PW });
    const u = auth.listUsers()[0];

    assert.equal(auth.removeUser(u.id), true);
    assert.equal(auth.countUsers(), 0);
    assert.equal(auth.login('gone', PW).ok, false);
  });

  it('countUsers 可用于判断是否需要引导创建首个管理员', () => {
    const { auth } = fresh();
    assert.equal(auth.countUsers(), 0);
    auth.register({ username: 'first', password: PW, role: 'admin' });
    assert.equal(auth.countUsers(), 1);
  });
});

describe('会话与配置边界', () => {
  it('数据持久化：关掉再打开同一个库仍在', () => {
    const { db, file, auth } = fresh();
    auth.register({ username: 'persist', password: PW });
    db.close();

    const reopened = openDb(file);
    openDbs.push(reopened);
    const auth2 = createAuth({ db: reopened, jwtSecret: SECRET });
    assert.equal(auth2.login('persist', PW).ok, true);
  });

  it('token 不能跨 secret 使用', () => {
    const { db, auth } = fresh();
    auth.register({ username: 'cross', password: PW });
    const token = auth.login('cross', PW).token;

    const other = createAuth({ db, jwtSecret: 'a-different-secret' });
    assert.equal(other.verify(token), null);
  });

  it('缺少 db 或 jwtSecret 直接报错（配置被静默忽略比报错更危险）', () => {
    assert.throws(() => createAuth({ jwtSecret: SECRET }), /数据库连接/);
    assert.throws(() => createAuth({ db: openDbs[0] }), /jwtSecret/);
  });
});
