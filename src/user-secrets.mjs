/**
 * 每用户凭据 —— 加密后存进 SQLite
 *
 * 【为什么不用 age 了】（详见 docs/requirements/weauto-multi-tenant.md §4.3）
 *   单租户时代凭据是「全站一份」，用 age 解密一个文件即可，每次执行 fork 一个进程无所谓。
 *   多租户后凭据是「每人每模板每账号一份」，调度器每 30 秒要为所有到期订阅解密，
 *   fork 进程的次数会随用户数线性增长，所以改为进程内 AES-256-GCM。
 *
 * 【威胁模型（不要夸大）】
 *   主密钥就在这台机器上。本方案防的是「数据库文件 / 备份泄露」，
 *   **不防主机被入侵**，也不构成端到端加密——admin 在技术上能解密所有用户的凭据。
 *   这一点必须对最终用户明说（需求文档 §6）。
 *
 * 【存储格式】
 *   value_enc = iv(12B) || authTag(16B) || ciphertext
 *   每次写入都用新的随机 iv，所以同一个值存两次密文也不同。
 */
import crypto from 'node:crypto';
import { SecretsError } from './secrets.mjs';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
export const KEY_LEN = 32;

export class UserSecretsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserSecretsError';
  }
}

export function generateMasterKey() {
  return crypto.randomBytes(KEY_LEN);
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw new UserSecretsError(`主密钥必须是 ${KEY_LEN} 字节 Buffer`);
  }
}

/** @returns {Buffer} iv || tag || ciphertext */
export function encryptValue(plain, key) {
  assertKey(key);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** @param {Buffer} blob encryptValue 的输出 */
export function decryptValue(blob, key) {
  assertKey(key);
  if (!Buffer.isBuffer(blob) || blob.length < IV_LEN + TAG_LEN) {
    throw new UserSecretsError('凭据密文损坏（长度不足）');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = blob.subarray(IV_LEN + TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // 主密钥换了、或密文被改过，都会走到这里。不区分，避免成为 oracle
    throw new UserSecretsError('凭据解密失败（密文损坏或主密钥不匹配）');
  }
}

/**
 * @param {import('better-sqlite3').Database} db 已迁移到 v3 的库
 * @param {Buffer} masterKey 32 字节
 */
/**
 * 执行器要的凭据加载器（需求文档 §4.5 的注入接缝）。
 *
 * 只把任务声明过的字段交出去，缺字段抛 `SecretsError`——执行器会把它转成
 * CONFIG 状态显示在页面上，比「执行到一半才发现没密码」好排查得多。
 *
 * 【凭据组】`peersOf(taskName)` 给出同组其它模板名。自己的字段优先，缺的才去
 * 兄弟模板里按**同名字段**找。这样「WorkBuddy 签到填过一次 token」就能让同组
 * 的活跃任务直接跑起来，不必让用户再抓一遍——同一把钥匙存两份，换 key 时
 * 必然会漏改一处。
 *
 * 兜底范围必须是显式的：只跨 `credentialGroup` 相同、且字段名完全一致的字段，
 * 绝不按「都叫 TOKEN 就大概是同一个」去猜。
 */
export function secretsLoaderFor(userSecrets, peersOf = () => []) {
  return function loadUserSecrets({ userId, taskName, accountKey = '', requires = [] } = {}) {
    if (!requires.length) return {};
    const found = userSecrets.get(userId, taskName, accountKey);
    let missing = requires.filter((k) => !found[k]);
    if (missing.length) {
      for (const peer of peersOf(taskName)) {
        const theirs = userSecrets.get(userId, peer, accountKey);
        for (const k of missing) {
          if (theirs[k]) found[k] = theirs[k];
        }
        missing = requires.filter((k) => !found[k]);
        if (!missing.length) break;
      }
    }
    if (missing.length) {
      throw new SecretsError(
        `缺少凭据字段：${missing.join('、')}（账号「${accountKey || '默认'}」）`,
      );
    }
    return Object.fromEntries(requires.map((k) => [k, found[k]]));
  };
}

export function createUserSecrets(db, masterKey) {
  assertKey(masterKey);

  const st = {
    fieldsOf: db.prepare(
      `SELECT field, value_enc FROM user_secrets
       WHERE user_id = ? AND task_name = ? AND account_key = ?`,
    ),
    allOfUser: db.prepare(
      'SELECT task_name, account_key, field FROM user_secrets WHERE user_id = ?',
    ),
    upsert: db.prepare(
      `INSERT INTO user_secrets (user_id, task_name, account_key, field, value_enc, updated_at)
       VALUES (@user_id, @task_name, @account_key, @field, @value_enc, @updated_at)
       ON CONFLICT(user_id, task_name, account_key, field) DO UPDATE SET
         value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
    ),
    deleteField: db.prepare(
      `DELETE FROM user_secrets WHERE user_id = ? AND task_name = ? AND account_key = ? AND field = ?`,
    ),
    deleteAccount: db.prepare(
      'DELETE FROM user_secrets WHERE user_id = ? AND task_name = ? AND account_key = ?',
    ),
    deleteUser: db.prepare('DELETE FROM user_secrets WHERE user_id = ?'),
  };

  /**
   * 取出一组凭据的明文。**只应在服务端内部使用，绝不进日志与 API 响应。**
   * @returns {Record<string,string>} 缺字段不出现在结果里
   */
  function get(userId, taskName, accountKey = '') {
    const out = {};
    for (const row of st.fieldsOf.all(userId, taskName, accountKey)) {
      try {
        out[row.field] = decryptValue(row.value_enc, masterKey);
      } catch {
        /* 单个字段解不开就当它不存在，不让一处损坏拖垮整个任务 */
      }
    }
    return out;
  }

  /** 只给界面用：字段名清单（不含值） */
  function fieldNames(userId, taskName, accountKey = '') {
    return st.fieldsOf.all(userId, taskName, accountKey).map((r) => r.field);
  }

  /** 只给界面用：必需字段里哪些已设置 */
  function fieldStatus(userId, taskName, accountKey, required = []) {
    const present = new Set(fieldNames(userId, taskName, accountKey));
    return Object.fromEntries(required.map((k) => [k, present.has(k)]));
  }

  /** 缺哪些必需字段（执行前校验用） */
  function missing(userId, taskName, accountKey, required = []) {
    const present = new Set(fieldNames(userId, taskName, accountKey));
    return required.filter((k) => !present.has(k));
  }

  /**
   * 缺哪些必需字段 —— 把凭据组的兄弟算进去。
   *
   * 判据必须和 `secretsLoaderFor` 的兜底范围一致，否则会出现「界面标着待填凭据、
   * 任务其实每天正常跑」这种自相矛盾的状态。
   */
  function missingWithPeers(userId, taskName, accountKey, required = [], peers = []) {
    const rest = missing(userId, taskName, accountKey, required);
    if (!rest.length) return [];
    const covered = new Set();
    for (const peer of peers) {
      for (const field of fieldNames(userId, peer, accountKey)) covered.add(field);
    }
    return rest.filter((k) => !covered.has(k));
  }

  /** 写入（局部更新：只动 patch 里出现的字段）。空字符串视为「删除该字段」 */
  function set(userId, taskName, accountKey = '', patch = {}) {
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const [field, value] of Object.entries(patch)) {
        if (value === '' || value == null) {
          st.deleteField.run(userId, taskName, accountKey, field);
          continue;
        }
        st.upsert.run({
          user_id: userId,
          task_name: taskName,
          account_key: accountKey,
          field,
          value_enc: encryptValue(value, masterKey),
          updated_at: now,
        });
      }
    });
    tx();
    return fieldNames(userId, taskName, accountKey);
  }

  function removeAccount(userId, taskName, accountKey) {
    return st.deleteAccount.run(userId, taskName, accountKey).changes > 0;
  }

  function removeUser(userId) {
    return st.deleteUser.run(userId).changes;
  }

  /** 该用户配置过凭据的 (task, account) 组合，供迁移与删除用户时清点 */
  function accountsOf(userId) {
    const seen = new Map();
    for (const row of st.allOfUser.all(userId)) {
      const key = `${row.task_name}\u0000${row.account_key}`;
      if (!seen.has(key)) seen.set(key, { taskName: row.task_name, accountKey: row.account_key });
    }
    return [...seen.values()];
  }

  return {
    get,
    fieldNames,
    fieldStatus,
    missing,
    missingWithPeers,
    set,
    removeAccount,
    removeUser,
    accountsOf,
  };
}
