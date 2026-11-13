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

  it('服务化后的表齐全（表名写错会静默变成「表不存在」）', () => {
    const db = openDb(freshPath());
    openDbs.push(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of ['users', 'meta', 'tasks', 'runs', 'run_logs', 'task_state', 'run_stats_daily']) {
      assert.ok(tables.includes(t), `缺少表 ${t}`);
    }
  });

  it('run_stats_daily 带上任务实例维度（同模板两个账号各存一行，不互相覆盖）', () => {
    const db = openDb(freshPath());
    openDbs.push(db);
    const cols = db.prepare('PRAGMA table_info(run_stats_daily)').all().map((c) => c.name);
    assert.ok(cols.includes('account_key'), 'run_stats_daily 缺少 account_key 列');

    const ins = db.prepare(
      `INSERT INTO run_stats_daily (user_id, task_name, account_key, date, success, failed, skipped, total)
       VALUES (1, 't', ?, '2026-10-14', 1, 0, 0, 1)`,
    );
    ins.run('a-1');
    ins.run('a-2');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_stats_daily').get().n, 2);
  });

  it('升级 v8 的老库：统计行归给唯一那个任务，同模板有多个任务时留空（不张冠李戴）', () => {
    const file = freshPath();
    // 手工建一个停在 v8 的库：迁移 1..8 原样跑一遍，再写入那个年代的数据
    const old = new Database(file);
    old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 8)) m.up(old);
    old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '8')").run();

    const insUser = old.prepare(
      'INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insUser.run(1, 'u1', 'h', 'user', 'active', 0);
    insUser.run(2, 'u2', 'h', 'user', 'active', 0);
    const insSub = old.prepare(
      `INSERT INTO subscriptions (user_id, task_name, account_key, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, 0)`,
    );
    insSub.run(1, 'solo', 'a-solo'); // 该模板下只有一个任务 → 可以确定归属
    insSub.run(2, 'twice', 'a-x'); // 同模板两个任务 → 归属不可知
    insSub.run(2, 'twice', 'a-y');
    const insStat = old.prepare(
      `INSERT INTO run_stats_daily (user_id, task_name, date, success, failed, skipped, total)
       VALUES (?, ?, '2026-10-01', 1, 0, 0, 1)`,
    );
    insStat.run(1, 'solo');
    insStat.run(2, 'twice');
    old.close();

    const db = openDb(file);
    openDbs.push(db);
    assert.deepEqual(
      db.prepare('SELECT task_name, account_key FROM run_stats_daily ORDER BY task_name').all(),
      [
        { task_name: 'solo', account_key: 'a-solo' },
        { task_name: 'twice', account_key: '' },
      ],
    );
  });

  it('runs 已为多账号预留 account_key（后加列便宜，后改契约要动每个任务）', () => {
    const db = openDb(freshPath());
    openDbs.push(db);
    const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
    assert.ok(cols.includes('account_key'), 'runs 表缺少 account_key 列');
  });

  it('删 runs 时 run_logs 级联删除（否则日志会变成孤儿数据永久堆积）', () => {
    const db = openDb(freshPath());
    openDbs.push(db);
    const runId = db
      .prepare(
        `INSERT INTO runs (task_name, date, ts, status) VALUES ('t', '2026-10-14', 1, 'success')`,
      )
      .run().lastInsertRowid;
    db.prepare('INSERT INTO run_logs (run_id, task_name, ts, line) VALUES (?, ?, ?, ?)').run(
      runId,
      't',
      1,
      'hello',
    );

    db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_logs').get().n, 0);
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
