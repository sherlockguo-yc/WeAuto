/**
 * 启动期回填 —— v3 迁移的第二步（第一步是 schema，在 db.mjs 里）
 *
 * 为什么不把回填也放进 `MIGRATIONS`：
 *   凭据迁移要用到主密钥做加密，而主密钥由 config 加载、db.mjs 不依赖 config
 *   （否则形成循环依赖）。所以「改表结构」和「搬数据」分开：
 *   前者纯 SQL、在 openDb 里完成；后者需要密钥与任务定义，在装配阶段做。
 *
 * 【幂等】
 *   用 meta 表的 `tenant_bootstrap_v3` 做标记。服务每次启动都会跑到这里，
 *   不能因为重启就再搬一次（凭据会被重新加密、订阅的 updated_at 会被刷新）。
 *
 * 【语义】
 *   迁移前的全部数据都是「这台机器的主人」的，所以统一归给 users 里 id 最小的
 *   那个账号（也就是第一个创建的管理员）。
 */
import { readSecrets } from './credentials.mjs';

/** 账号名长度上限，与 user-secrets.MAX_LABEL 一致 */
const MAX_LABEL = 32;

/** 这个字段是「往服务器推送凭据」用的令牌，不是站点凭据本身 */
const PUSH_TOKEN_FIELD = 'WEAUTO_PUSH_TOKEN';

export function pickOwnerId(db) {
  const row = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  return row ? row.id : null;
}

/**
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {object} args.store 根 store
 * @param {object} args.userSecrets createUserSecrets 的结果
 * @param {Map<string, object>} args.tasks 已加载的模板（用来知道每个任务需要哪些凭据字段）
 * @param {number} args.ownerId
 * @param {(msg: string) => void} [args.log]
 */
export function bootstrapTenancy({ db, store, userSecrets, tasks, ownerId, log = () => {} }) {
  if (!Number.isInteger(ownerId)) {
    return { skipped: '还没有任何账号，等创建完管理员再回填' };
  }

  const marker = 'tenant_bootstrap_v3';
  const already = db.prepare('SELECT value FROM meta WHERE key = ?').get(marker);
  if (already) return { skipped: '已回填过' };

  const mine = store.forUser(ownerId);
  const result = { subscriptions: 0, secretFields: 0, notes: [] };

  const tx = db.transaction(() => {
    /* 1. 旧的全局覆盖层 → 这个用户的订阅 */
    const legacy = db.prepare('SELECT * FROM tasks').all();
    for (const row of legacy) {
      try {
        let schedule = null;
        if (row.schedule_json) {
          try {
            schedule = JSON.parse(row.schedule_json);
          } catch {
            result.notes.push(`${row.task_name} 的旧调度配置无法解析，按默认处理`);
          }
        }
        mine.ensureConfig(row.task_name, {
          enabled: !!row.enabled,
          schedule,
          timeoutMs: row.timeout_ms ?? null,
        });
        result.subscriptions += 1;
      } catch (err) {
        result.notes.push(`迁移订阅 ${row.task_name} 失败：${err.message}`);
      }
    }

    /* 2. 旧的全局凭据 → 这个用户的加密凭据 */
    let secrets = null;
    try {
      // 只有部署环境才有 age 私钥与密文；读不到是正常情况，不该让启动失败
      secrets = readSecrets();
    } catch (err) {
      result.notes.push(`读取旧凭据失败：${err.message}`);
    }
    if (secrets) {
      for (const task of tasks.values()) {
        const fields = {};
        for (const key of task.requires ?? []) {
          if (secrets[key]) fields[key] = secrets[key];
        }
        if (!Object.keys(fields).length) continue;
        // 直接建成 v7 的账号实体（旧 user_secrets 表已不再写入），并绑给同模板的任务
        const account = userSecrets.create(ownerId, {
          groupName: task.credentialGroup,
          label: task.displayName,
          fields,
        });
        for (const t of mine.tasksOfTemplate(task.name)) {
          if (!t.credentialId) mine.updateTask(t.id, { credentialId: account.id });
        }
        result.secretFields += Object.keys(fields).length;
      }
    } else {
      result.notes.push('没有可迁移的旧凭据（首次部署或凭据不可用），跳过');
    }

    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(marker, String(Date.now()));
  });

  tx();

  if (result.subscriptions || result.secretFields) {
    log(`[bootstrap] 历史数据已归入账号 ${ownerId}：订阅 ${result.subscriptions} 个，凭据 ${result.secretFields} 个字段`);
  }
  return result;
}

/**
 * v7 数据迁移：把「任务下的凭据」搬成「可被任务引用的账号」。
 *
 * 【为什么不在 db.mjs 的迁移里做】
 *   账号归属哪个组必须查模板定义（`credentialGroup`），而 db.mjs 不依赖任务注册表；
 *   而且判定「哪些旧记录值得变成一个账号」需要业务语义（见下）。
 *
 * 【保守 1:1，只做三件保守的事】
 *   1. 只有含**业务字段**的旧记录才变成账号。只有 WEAUTO_PUSH_TOKEN 的记录不是可用凭据
 *      （旧设计里它是「往服务器推 token 的钥匙」，任务本身没配任何东西），若也建成账号，
 *      页面会出现一堆空账号。
 *   2. 任务优先绑自己那份账号；自己没有则绑「同组唯一账号」——这条正是旧「凭据组兜底」
 *      的显式化：以前签到填过 token、活跃靠兜底跑，迁移后活跃显式引用同一个账号。
 *      同组有多个账号时不猜，留空让用户选。
 *   3. 字段密文原样复制，不解密再加密：主密钥版本、解密失败、迁移中途留下明文，都是
 *      不必要的风险。
 *
 * 【幂等】meta.credentials_migrated_v7。旧表 user_secrets 一条不删，回退有据。
 */
export function migrateCredentials({ db, tasks, log = () => {} }) {
  const marker = 'credentials_migrated_v7';
  const already = db.prepare('SELECT value FROM meta WHERE key = ?').get(marker);
  if (already) return { skipped: '已迁移' };

  const result = { accounts: 0, bound: 0, notes: [] };

  const tx = db.transaction(() => {
    const rows = db
      .prepare('SELECT * FROM user_secrets ORDER BY user_id, task_name, account_key, field')
      .all();

    /* 1. 按 (用户, 模板, 任务实例) 聚合旧行 */
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.user_id}\u0000${r.task_name}\u0000${r.account_key}`;
      let g = groups.get(key);
      if (!g) {
        g = { userId: r.user_id, taskName: r.task_name, accountKey: r.account_key, fields: new Map() };
        groups.set(key, g);
      }
      g.fields.set(r.field, { enc: r.value_enc, updatedAt: r.updated_at });
    }

    const insertCredential = db.prepare(
      `INSERT INTO credentials (user_id, group_name, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertField = db.prepare(
      `INSERT INTO credential_fields (credential_id, field, value_enc, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    const labelsOfGroup = db.prepare(
      'SELECT id, label FROM credentials WHERE user_id = ? AND group_name = ?',
    );
    const subLabel = db.prepare(
      'SELECT label FROM subscriptions WHERE user_id = ? AND task_name = ? AND account_key = ?',
    );

    /** 旧 (user, task, account) → 新 credential id */
    const made = new Map();

    for (const [key, g] of groups) {
      const business = [...g.fields.keys()].filter((f) => f !== PUSH_TOKEN_FIELD);
      if (!business.length) continue;

      const task = tasks.get(g.taskName);
      const groupName = task?.credentialGroup ?? g.taskName;
      const own = subLabel.get(g.userId, g.taskName, g.accountKey);
      const want = String(own?.label || task?.displayName || g.taskName).trim().slice(0, MAX_LABEL) || '账号';

      const taken = new Set(labelsOfGroup.all(g.userId, groupName).map((r) => r.label));
      let label = want;
      for (let n = 2; taken.has(label); n += 1) label = `${want} ${n}`;

      const now = Date.now();
      const info = insertCredential.run(g.userId, groupName, label, now, now);
      const id = Number(info.lastInsertRowid);
      for (const [field, v] of g.fields) insertField.run(id, field, v.enc, v.updatedAt);
      made.set(key, id);
      result.accounts += 1;
    }

    /* 2. 任务绑定账号 */
    const subs = db.prepare('SELECT * FROM subscriptions ORDER BY id').all();
    const setCredential = db.prepare('UPDATE subscriptions SET credential_id = ? WHERE id = ?');
    const sameGroup = db.prepare(
      'SELECT id FROM credentials WHERE user_id = ? AND group_name = ? ORDER BY id',
    );

    for (const sub of subs) {
      const task = tasks.get(sub.task_name);
      // 无凭据模板不绑；模板已下线（文件删了）也不绑——没有定义就不知道组
      if (!task || !(task.requires ?? []).length) continue;

      let cid = made.get(`${sub.user_id}\u0000${sub.task_name}\u0000${sub.account_key}`);
      if (!cid) {
        const peers = sameGroup.all(sub.user_id, task.credentialGroup);
        // 同组恰好一个账号才自动绑：两个账号时无从判断谁是谁，不能猜
        if (peers.length === 1) cid = peers[0].id;
      }
      if (cid) {
        setCredential.run(cid, sub.id);
        result.bound += 1;
      } else {
        result.notes.push(`任务 #${sub.id}（${sub.task_name}）还没有账号，需要手动选一个`);
      }
    }

    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(marker, String(Date.now()));
  });

  tx();

  if (result.accounts) {
    log(`[bootstrap] 账号迁移完成：新建 ${result.accounts} 个账号，绑定 ${result.bound} 个任务`);
  }
  for (const n of result.notes) log(`[bootstrap] ${n}`);
  return result;
}
