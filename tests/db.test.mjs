/**
 * 数据库迁移测试
 *
 * 迁移是唯一「跑错了会把线上数据弄坏」的代码，两个不变量必须守住：
 *   · 幂等：同一个库反复 openDb 不重复执行迁移
 *   · 可增量：从任意旧版本打开都补到最新，而不是要求从头重建
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { MIGRATIONS, currentVersion, migrate, openDb } from '../src/db.mjs';

let dir;
const openDbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-db-'));
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
const freshPath = () => path.join(dir, `db-${++seq}.sqlite`);

describe('openDb', () => {
  it('新库自动建表并写入 schema 版本', () => {
    const file = freshPath();
    const db = openDb(file);
    openDbs.push(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes('users'));
    assert.ok(tables.includes('meta'));
    assert.equal(currentVersion(db), MIGRATIONS.at(-1).version);
  });

  it('幂等：同一个库重复打开不重复执行迁移', () => {
    const file = freshPath();
    const db1 = openDb(file);
    db1.close();

    const db2 = openDb(file);
    openDbs.push(db2);
    assert.deepEqual(migrate(db2).applied, []);
    assert.equal(currentVersion(db2), MIGRATIONS.at(-1).version);
  });

  it('可增量：已有旧版本库时只补跑缺的迁移', () => {
    const file = freshPath();
    // 手工构造一个「schema 版本停在 0」的库，模拟老部署升级
    const raw = new Database(file);
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '0')").run();
    raw.close();

    const db = openDb(file);
    openDbs.push(db);
    assert.deepEqual(migrate(db).applied, []);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0);
  });

  it('user 表字段与登录模块的期望一致（列名写错会静默变成 undefined）', () => {
    const db = openDb(freshPath());
    openDbs.push(db);
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    for (const c of ['id', 'username', 'password_hash', 'role', 'status', 'created_at', 'last_login_at']) {
      assert.ok(cols.includes(c), `users 表缺少列 ${c}`);
    }
  });
});
