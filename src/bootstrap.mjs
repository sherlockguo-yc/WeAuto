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
        mine.subscribe(row.task_name, {
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
        // 模板声明 accounts 时用默认账号（''），与订阅自动建的那个账号一致
        userSecrets.set(ownerId, task.name, '', fields);
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
