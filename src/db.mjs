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
  {
    version: 3,
    description: '多租户：订阅与账号、每用户凭据、邀请码；历史数据归入首个账号',
    up(db) {
      db.exec(`
        /* ───────── 新表 ───────── */

        /* 邀请码：见需求文档 §6。默认单次使用，可设过期与撤销 */
        CREATE TABLE IF NOT EXISTS invites (
          code       TEXT PRIMARY KEY,
          created_by INTEGER NOT NULL REFERENCES users(id),
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          max_uses   INTEGER NOT NULL DEFAULT 1,
          used_count INTEGER NOT NULL DEFAULT 0,
          used_by    INTEGER REFERENCES users(id),
          revoked_at INTEGER,
          note       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_invites_created ON invites(created_at DESC);

        /* 每用户凭据：密文格式见 src/user-secrets.mjs（AES-256-GCM） */
        CREATE TABLE IF NOT EXISTS user_secrets (
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          task_name   TEXT    NOT NULL,
          account_key TEXT    NOT NULL DEFAULT '',
          field       TEXT    NOT NULL,
          value_enc   BLOB    NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (user_id, task_name, account_key, field)
        );

        /* 订阅 = 用户 × 模板。取代全局 tasks 覆盖层（旧表保留不删，作为回退依据） */
        CREATE TABLE IF NOT EXISTS subscriptions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          task_name     TEXT    NOT NULL,
          enabled       INTEGER NOT NULL DEFAULT 1,
          schedule_json TEXT,
          timeout_ms    INTEGER,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          UNIQUE (user_id, task_name)
        );
        CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
        CREATE INDEX IF NOT EXISTS idx_subs_task ON subscriptions(task_name);

        /* 订阅下的账号。accounts:false 的模板只有 account_key='' 一条 */
        CREATE TABLE IF NOT EXISTS subscription_accounts (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
          account_key     TEXT    NOT NULL DEFAULT '',
          label           TEXT    NOT NULL DEFAULT '',
          enabled         INTEGER NOT NULL DEFAULT 1,
          created_at      INTEGER NOT NULL,
          UNIQUE (subscription_id, account_key)
        );

        /* ───────── 现有表加用户维度 ───────── */

        /* SQLite 的 ADD COLUMN 不能带 REFERENCES，也不能没有默认值。
           DEFAULT 1 正好把历史行归给首个账号——迁移时的语义就是「这些是我的」。 */
        ALTER TABLE runs ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE runs ADD COLUMN subscription_id INTEGER;
        CREATE INDEX IF NOT EXISTS idx_runs_user_task_ts ON runs(user_id, task_name, ts DESC);

        /* 冗余 user_id 而不是 JOIN runs：保留策略要按用户清理日志，JOIN 会变成全表扫 */
        ALTER TABLE run_logs ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
        CREATE INDEX IF NOT EXISTS idx_run_logs_user_ts ON run_logs(user_id, ts);
      `);

      /* 主键变了的两张表只能重建：建新表 → 搬数据 → 删旧表 → 改名 */
      db.exec(`
        CREATE TABLE run_stats_daily_new (
          user_id INTEGER NOT NULL DEFAULT 1,
          task_name TEXT NOT NULL,
          date TEXT NOT NULL,
          success INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          skipped INTEGER NOT NULL DEFAULT 0,
          total INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, task_name, date)
        );
        INSERT INTO run_stats_daily_new (user_id, task_name, date, success, failed, skipped, total)
          SELECT 1, task_name, date, success, failed, skipped, total FROM run_stats_daily;
        DROP TABLE run_stats_daily;
        ALTER TABLE run_stats_daily_new RENAME TO run_stats_daily;

        CREATE TABLE task_state_new (
          user_id INTEGER NOT NULL DEFAULT 1,
          task_name TEXT NOT NULL,
          account_key TEXT NOT NULL DEFAULT '',
          today_date TEXT,
          today_target_ts INTEGER,
          next_due_ts INTEGER,
          last_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, task_name, account_key)
        );
        INSERT INTO task_state_new
          (user_id, task_name, account_key, today_date, today_target_ts, next_due_ts, last_run_id, updated_at)
          SELECT 1, task_name, '', today_date, today_target_ts, next_due_ts, last_run_id, updated_at
          FROM task_state;
        DROP TABLE task_state;
        ALTER TABLE task_state_new RENAME TO task_state;
      `);
    },
  },
  {
    version: 4,
    description: '会话版本号：注销或改密后，之前签发的 token 立即失效',
    up(db) {
      db.exec(`
        /* JWT 是无状态的，签出去就收不回来。
           加一个版本号写进 token，注销/改密时 +1，校验时比对 ——
           不这样的话，「退出登录」只是清了浏览器 cookie，
           那个 cookie 的副本在 7 天内照样能用。 */
        ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 5,
    description: '一任务一账号：账号上提到订阅行，同一个模板可以建多个任务',
    up(db) {
      /*
       * 以前：订阅（用户 × 模板，唯一）+ 订阅下挂多个账号；
       * 现在：一行订阅就是一个任务，自带 account_key 与 label，
       *       同一个模板想跑第二个账号 = 再建一个任务。
       *
       * 之所以敢这么搬：runs / task_state / user_secrets 三张表早就按
       * (user_id, task_name, account_key) 分，账号拆成任务后这些记录自动跟随，
       * 不需要动它们，历史与凭据一条不丢。
       *
       * SQLite 改不了 UNIQUE 约束，只能建新表 → 搬数据 → 删旧表 → 改名。
       * subscription_accounts 有指向 subscriptions(id) 的外键且外键是开启的，
       * 所以必须在删旧表之前把子表的行清掉（数据已经搬进新表，不是丢失）。
       */
      db.exec(`
        CREATE TABLE subscriptions_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          task_name     TEXT    NOT NULL,
          account_key   TEXT    NOT NULL DEFAULT '',
          label         TEXT    NOT NULL DEFAULT '',
          enabled       INTEGER NOT NULL DEFAULT 1,
          schedule_json TEXT,
          timeout_ms    INTEGER,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          UNIQUE (user_id, task_name, account_key)
        );

        INSERT INTO subscriptions_new
          (id, user_id, task_name, account_key, label, enabled, schedule_json, timeout_ms, created_at, updated_at)
          SELECT s.id, s.user_id, s.task_name,
                 '', COALESCE(a.label, ''),
                 s.enabled, s.schedule_json, s.timeout_ms, s.created_at, s.updated_at
            FROM subscriptions s
            LEFT JOIN subscription_accounts a
                   ON a.subscription_id = s.id AND a.account_key = '';
      `);

      /* 第 2 个及以后的账号 → 各自一条新任务行（沿用原订阅的调度与超时） */
      const extras = db
        .prepare(
          `SELECT sa.account_key, sa.label, sa.enabled, sa.created_at,
                  s.user_id, s.task_name, s.schedule_json, s.timeout_ms, s.updated_at
             FROM subscription_accounts sa
             JOIN subscriptions s ON s.id = sa.subscription_id
            WHERE sa.account_key <> ''
            ORDER BY sa.id`,
        )
        .all();
      const insertExtra = db.prepare(
        `INSERT INTO subscriptions_new
           (user_id, task_name, account_key, label, enabled, schedule_json, timeout_ms, created_at, updated_at)
         VALUES (@user_id, @task_name, @account_key, @label, @enabled, @schedule_json, @timeout_ms, @created_at, @updated_at)`,
      );
      for (const a of extras) {
        insertExtra.run({
          user_id: a.user_id,
          task_name: a.task_name,
          account_key: a.account_key,
          label: a.label,
          enabled: a.enabled,
          schedule_json: a.schedule_json,
          timeout_ms: a.timeout_ms,
          created_at: a.created_at,
          updated_at: a.updated_at,
        });
      }

      db.exec(`
        DELETE FROM subscription_accounts;
        DROP TABLE subscriptions;
        ALTER TABLE subscriptions_new RENAME TO subscriptions;
        CREATE INDEX idx_subs_user ON subscriptions(user_id);
        CREATE INDEX idx_subs_task ON subscriptions(task_name);
      `);

      /* 历史记录指回自己那个任务行：账号变成任务后 id 也变了 */
      db.exec(`
        UPDATE runs SET subscription_id =
          (SELECT s.id FROM subscriptions s
            WHERE s.user_id = runs.user_id
              AND s.task_name = runs.task_name
              AND s.account_key = COALESCE(runs.account_key, ''))
         WHERE subscription_id IS NOT NULL;
      `);
    },
  },
  {
    version: 6,
    description: '账号备注：管理员用来记住这个人是谁',
    up(db) {
      /* 用户注册时自己起的用户名往往是网名（jason、GGBond），管理员看不出是谁。
         备注只给管理员看，普通用户既看不到也改不了，所以放在 users 上而不是
         另开一张表：它和 role / status 一样是管理员对这个账号的标注，
         一个账号一条，没有历史与审计需求。
         DEFAULT '' 而不是可空：查询方不必区分 null 与空串（两者都表示「还没写」）。 */
      db.exec(`ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT '';`);
    },
  },
  {
    version: 7,
    description: '账号凭据实体化：一个站点账号可被多个任务引用',
    up(db) {
      /*
       * 以前「账号」只以 account_key（随机串）的形式挂在任务行上，跨模板共享只能靠
       * 「去同组兄弟模板里取任意一份值」——多账号时取到谁全看行顺序。
       * 现在账号是独立实体：一行 = 一个站点账号，任务通过 credential_id 引用它。
       *
       * group_name 来自模板的 credentialGroup（workbuddy / v2free…），不是模板名：
       * 同一个 WorkBuddy 账号同时被签到与活跃引用，指针只有一份，换 key 只改一处。
       *
       * 不加 UNIQUE(group_name, label)：同名在应用层自动加序号，加约束会让改名与
       * 迁移都要先处理冲突，而这里没有「同名必须报错」的业务需求。
       *
       * 旧的 user_secrets 表保留不删：它是本次迁移的唯一数据来源，也是回退依据。
       * 字段密文格式与它完全一致（iv 12B || tag 16B || ciphertext）。
       */
      db.exec(`
        CREATE TABLE IF NOT EXISTS credentials (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          group_name TEXT    NOT NULL,
          label      TEXT    NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id, group_name);

        CREATE TABLE IF NOT EXISTS credential_fields (
          credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
          field         TEXT    NOT NULL,
          value_enc     BLOB    NOT NULL,
          updated_at    INTEGER NOT NULL,
          PRIMARY KEY (credential_id, field)
        );

        /* NULL = 还没选账号。无凭据模板永远为 NULL */
        ALTER TABLE subscriptions ADD COLUMN credential_id INTEGER REFERENCES credentials(id);
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
