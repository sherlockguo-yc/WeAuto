/**
 * SQLite 连接与迁移 —— data/weauto.db
 *
 * 为什么从 JSONL 换成 SQLite（2026-10-14 决定）：
 *   · 服务化之后要做「按任务/日期筛选、分页、统计」，JSONL 每次都要全量读进内存再过滤
 *   · 凭据写入、任务启停、执行记录三处都要并发写，需要事务与写锁
 *   · 窗口随机目标时刻要持久化到「当天唯一」的语义，文件方案容易写坏
 * data/runs.jsonl 不会被删除：它仍是历史来源，由 scripts/import-runs.mjs 一次性导入。
 *
 * 迁移约定（长期）：
 *   · **只允许追加，不改已发布的迁移**。升级时按 version 从小到大补齐。
 *   · 迁移跑在事务里，失败则整个回滚，不会留下半套 schema。
 *
 * 测试可通过 WEAUTO_DB 环境变量或显式参数指向临时库，避免污染部署数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from './util.mjs';

export const DB_FILE = process.env.WEAUTO_DB || path.join(DATA_DIR, 'weauto.db');

export const MIGRATIONS = [
  {
    version: 1,
    description: '初始 schema：本地账号 users',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT    NOT NULL UNIQUE,
          password_hash TEXT    NOT NULL,
          role          TEXT    NOT NULL DEFAULT 'user',
          status        TEXT    NOT NULL DEFAULT 'active',
          created_at    INTEGER NOT NULL,
          last_login_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      `);
    },
  },
  {
    version: 2,
    description: '服务化：任务覆盖层、执行记录、运行日志、调度状态、每日统计',
    up(db) {
      db.exec(`
        /* UI 覆盖层：只在用户显式改过某个任务的某项配置时才有行。
           代码文件始终是默认值来源，见 docs/requirements/weauto-contract.md §4 */
        CREATE TABLE IF NOT EXISTS tasks (
          task_name     TEXT PRIMARY KEY,
          enabled       INTEGER NOT NULL DEFAULT 1,
          schedule_json TEXT,
          timeout_ms    INTEGER,
          updated_at    INTEGER NOT NULL
        );

        /* 每次执行一行。account_key 为多账号预留（当前恒为 NULL） */
        CREATE TABLE IF NOT EXISTS runs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          task_name   TEXT    NOT NULL,
          account_key TEXT,
          date        TEXT    NOT NULL,
          ts          INTEGER NOT NULL,
          status      TEXT    NOT NULL,
          message     TEXT    NOT NULL DEFAULT '',
          data_json   TEXT,
          dur         INTEGER NOT NULL DEFAULT 0,
          trigger     TEXT    NOT NULL DEFAULT 'schedule'
        );
        CREATE INDEX IF NOT EXISTS idx_runs_task_ts ON runs(task_name, ts DESC);
        CREATE INDEX IF NOT EXISTS idx_runs_task_date ON runs(task_name, date);
        CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts);

        /* ctx.log() 的输出。随 runs 一起被保留策略清理（ON DELETE CASCADE） */
        CREATE TABLE IF NOT EXISTS run_logs (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id    INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          task_name TEXT    NOT NULL,
          ts        INTEGER NOT NULL,
          line      TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_logs_run ON run_logs(run_id);
        CREATE INDEX IF NOT EXISTS idx_run_logs_ts ON run_logs(ts);

        /* 调度器的当日状态：目标时刻落库，进程重启后目标不变（天然幂等） */
        CREATE TABLE IF NOT EXISTS task_state (
          task_name       TEXT PRIMARY KEY,
          today_date      TEXT,
          today_target_ts INTEGER,
          next_due_ts     INTEGER,
          last_run_id     INTEGER REFERENCES runs(id) ON DELETE SET NULL,
          updated_at      INTEGER NOT NULL
        );

        /* 清理明细前的聚合：删掉明细后「每天成功几次」的趋势仍可查 */
        CREATE TABLE IF NOT EXISTS run_stats_daily (
          task_name TEXT    NOT NULL,
          date      TEXT    NOT NULL,
          success   INTEGER NOT NULL DEFAULT 0,
          failed    INTEGER NOT NULL DEFAULT 0,
          skipped   INTEGER NOT NULL DEFAULT 0,
          total     INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (task_name, date)
        );
      `);
    },
  },
];

/** 用 meta 表记录 schema 版本（用户表之外的第一张表，永远存在） */
function ensureMeta(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

export function currentVersion(db) {
  ensureMeta(db);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}

/** 幂等地把库升到最新 schema，返回本次实际执行的迁移版本 */
export function migrate(db) {
  let version = currentVersion(db);
  const applied = [];

  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(m.version));
    })();
    applied.push(m.version);
    version = m.version;
  }

  return { version: currentVersion(db), applied };
}

/**
 * 打开数据库并保证 schema 最新。
 * @param {string} [file] 默认 data/weauto.db
 */
export function openDb(file = DB_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  // 常驻服务里会有「调度器执行任务」与「HTTP 请求写状态」并发写，写锁要等而不是立刻报错
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
