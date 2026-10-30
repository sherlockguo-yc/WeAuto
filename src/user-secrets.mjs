/**
 * 每用户账号凭据 —— 独立实体，加密后存进 SQLite
 *
 * 【为什么是「账号」而不是「任务凭据」】（详见 docs/requirements/weauto-accounts.md）
 *   以前凭据按 (task_name, account_key) 存，一个任务一份。跨模板共享同一把 token
 *   （WorkBuddy 签到 + 活跃）只能靠「去兄弟模板里取任意一份」，多账号时取到谁全看
 *   行顺序，界面上还看不出来 —— 失败现象是「鉴权失败」或「记到错账号」。
 *   现在账号是一等实体：一行 = 一个站点账号（按 credentialGroup 归属），任务通过
 *   credential_id 引用它。换 key 只改一处，所有引用它的任务同时生效。
 *
 * 【为什么按 group 而不是按模板归属】
 *   group 是「同一个站点的同一把钥匙」。workbuddy-checkin 与 workbuddy-active 同组，
 *   所以一个 WorkBuddy 账号只有一份 WB_ACCESS_TOKEN。按模板归属会让「同一把钥匙存
 *   两份」原样保留 —— 那正是这次要消灭的问题。
 *
 * 【威胁模型（不要夸大）】
 *   主密钥就在这台机器上。本方案防的是「数据库文件 / 备份泄露」，
 *   **不防主机被入侵**，也不构成端到端加密——admin 在技术上能解密所有用户的凭据。
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

/** 账号名长度上限：与任务名保持一致，界面上两种名字并排出现 */
export const MAX_LABEL = 32;

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
 * 执行器要的凭据加载器（需求文档 §4.3 的注入接缝）。
 *
 * 只把任务声明过的字段交出去，缺字段抛 `SecretsError`——执行器会把它转成
 * CONFIG 状态显示在页面上，比「执行到一半才发现没密码」好排查得多。
 *
 * 这里**没有任何跨模板兜底**：任务引用哪个账号就用哪个账号，缺就是缺。
 * 兜底会让「多账号时用了错的 token」变成静默事故，而显式绑定能立刻看出问题。
 */
export function secretsLoaderFor(userSecrets) {
  return function loadUserSecrets({ userId, credentialId = null, requires = [] } = {}) {
    if (!requires.length) return {};
    if (!credentialId) {
      throw new SecretsError('还没有选择账号（在任务页的「账号」里选一个，或新建一个）');
    }
    const found = userSecrets.get(userId, credentialId);
    const missing = requires.filter((k) => !found[k]);
    if (missing.length) {
      const label = userSecrets.labelOf(userId, credentialId) || `#${credentialId}`;
      throw new SecretsError(`账号「${label}」缺少凭据字段：${missing.join('、')}`);
    }
    return Object.fromEntries(requires.map((k) => [k, found[k]]));
  };
}

export function createUserSecrets(db, masterKey) {
  assertKey(masterKey);

  const st = {
    listOfUser: db.prepare(
      'SELECT * FROM credentials WHERE user_id = ? ORDER BY group_name, id',
    ),
    byId: db.prepare('SELECT * FROM credentials WHERE id = ? AND user_id = ?'),
    countOfGroup: db.prepare(
      'SELECT COUNT(*) AS n FROM credentials WHERE user_id = ? AND group_name = ?',
    ),
    insertCredential: db.prepare(
      `INSERT INTO credentials (user_id, group_name, label, created_at, updated_at)
       VALUES (@user_id, @group_name, @label, @created_at, @updated_at)`,
    ),
    updateLabel: db.prepare(
      'UPDATE credentials SET label = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ),
    touch: db.prepare('UPDATE credentials SET updated_at = ? WHERE id = ? AND user_id = ?'),
    deleteCredential: db.prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?'),
    deleteFieldsOfCredential: db.prepare('DELETE FROM credential_fields WHERE credential_id = ?'),
    deleteAllOfUser: db.prepare('DELETE FROM credentials WHERE user_id = ?'),
    allOfUser: db.prepare('SELECT * FROM credentials WHERE user_id = ?'),
    fieldsOf: db.prepare('SELECT field, value_enc FROM credential_fields WHERE credential_id = ?'),
    upsertField: db.prepare(
      `INSERT INTO credential_fields (credential_id, field, value_enc, updated_at)
       VALUES (@credential_id, @field, @value_enc, @updated_at)
       ON CONFLICT(credential_id, field) DO UPDATE SET
         value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
    ),
    deleteField: db.prepare('DELETE FROM credential_fields WHERE credential_id = ? AND field = ?'),
  };

  function rowToCredential(row) {
    if (!row) return null;
    return {
      id: row.id,
      groupName: row.group_name,
      label: row.label ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 这个账号属于这个用户吗。所有读写都先过它，越权在结构上不可能 */
  function ownRow(userId, credentialId) {
    const id = Number(credentialId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return st.byId.get(id, userId);
  }

  /**
   * 取出一组凭据的明文。**只应在服务端内部使用，绝不进日志与 API 响应。**
   * @returns {Record<string,string>} 缺字段不出现在结果里
   */
  function get(userId, credentialId) {
    const row = ownRow(userId, credentialId);
    if (!row) return {};
    const out = {};
    for (const r of st.fieldsOf.all(row.id)) {
      try {
        out[r.field] = decryptValue(r.value_enc, masterKey);
      } catch {
        /* 单个字段解不开就当它不存在，不让一处损坏拖垮整个任务 */
      }
    }
    return out;
  }

  /** 只给界面用：字段名清单（不含值） */
  function fieldNames(userId, credentialId) {
    const row = ownRow(userId, credentialId);
    if (!row) return [];
    return st.fieldsOf.all(row.id).map((r) => r.field);
  }

  /** 缺哪些必需字段（执行前校验与界面标记共用） */
  function missing(userId, credentialId, required = []) {
    const present = new Set(fieldNames(userId, credentialId));
    return required.filter((k) => !present.has(k));
  }

  /** 账号名（错误信息与界面用）。取不到返回空串 */
  function labelOf(userId, credentialId) {
    return ownRow(userId, credentialId)?.label ?? '';
  }

  function getCredential(userId, credentialId) {
    return rowToCredential(ownRow(userId, credentialId));
  }

  /** 该用户全部账号（不含值，含字段名与更新时间） */
  function list(userId) {
    return st.listOfUser.all(userId).map((row) => {
      const fields = st.fieldsOf.all(row.id).map((r) => r.field);
      return { ...rowToCredential(row), fields };
    });
  }

  /**
   * 新建账号。label 同组重名时自动加序号，不报错——
   * 用户刚点「新建」就想填字段，被一个命名冲突打断没有意义。
   */
  function create(userId, { groupName, label = '', fields = {} } = {}) {
    const group = String(groupName ?? '').trim();
    if (!group) throw new UserSecretsError('缺少账号所属的站点（group）');
    const now = Date.now();
    const want = String(label ?? '').trim().slice(0, MAX_LABEL) || '账号';

    const tx = db.transaction(() => {
      const taken = new Set(st.listOfUser.all(userId).filter((r) => r.group_name === group).map((r) => r.label));
      let name = want;
      for (let n = 2; taken.has(name); n += 1) name = `${want} ${n}`;

      const info = st.insertCredential.run({
        user_id: userId,
        group_name: group,
        label: name,
        created_at: now,
        updated_at: now,
      });
      const id = Number(info.lastInsertRowid);
      for (const [field, value] of Object.entries(fields)) {
        if (value === '' || value == null) continue;
        st.upsertField.run({
          credential_id: id,
          field,
          value_enc: encryptValue(value, masterKey),
          updated_at: now,
        });
      }
      return id;
    });

    return getCredential(userId, tx());
  }

  /** 改名。同组重名时自动加序号（与新建同一口径） */
  function rename(userId, credentialId, label) {
    const row = ownRow(userId, credentialId);
    if (!row) return null;
    const want = String(label ?? '').trim().slice(0, MAX_LABEL);
    if (!want) throw new UserSecretsError('账号名不能为空');
    const taken = new Set(
      st.listOfUser
        .all(userId)
        .filter((r) => r.group_name === row.group_name && r.id !== row.id)
        .map((r) => r.label),
    );
    let name = want;
    for (let n = 2; taken.has(name); n += 1) name = `${want} ${n}`;
    st.updateLabel.run(name, Date.now(), row.id, userId);
    return getCredential(userId, row.id);
  }

  /** 写入（局部更新：只动 patch 里出现的字段）。空字符串视为「删除该字段」 */
  function set(userId, credentialId, patch = {}) {
    const row = ownRow(userId, credentialId);
    if (!row) throw new UserSecretsError('没有这个账号');
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const [field, value] of Object.entries(patch)) {
        if (value === '' || value == null) {
          st.deleteField.run(row.id, field);
          continue;
        }
        st.upsertField.run({
          credential_id: row.id,
          field,
          value_enc: encryptValue(value, masterKey),
          updated_at: now,
        });
      }
      st.touch.run(now, row.id, userId);
    });
    tx();
    return fieldNames(userId, row.id);
  }

  function remove(userId, credentialId) {
    const row = ownRow(userId, credentialId);
    if (!row) return false;
    const tx = db.transaction(() => {
      // 外键的 ON DELETE CASCADE 在本项目没有开启（PRAGMA foreign_keys 默认 off），
      // 所以子表必须手动清 —— 依赖 CASCADE 会留下一批孤儿字段行
      st.deleteFieldsOfCredential.run(row.id);
      st.deleteCredential.run(row.id, userId);
    });
    tx();
    return true;
  }

  /**
   * 删号清理。旧表 user_secrets 也一起清：它虽然已不再读写，
   * 但留着别人的密文没有任何意义，反而是备份泄露时的额外风险面。
   */
  function removeUser(userId) {
    const ids = st.allOfUser.all(userId).map((r) => r.id);
    const tx = db.transaction(() => {
      for (const id of ids) st.deleteFieldsOfCredential.run(id);
      st.deleteAllOfUser.run(userId);
      db.prepare('DELETE FROM user_secrets WHERE user_id = ?').run(userId);
    });
    tx();
    return ids.length;
  }

  /** 这个用户在某个组里已经建了几个账号（界面提示 / 上限判断用） */
  function countOfGroup(userId, groupName) {
    return st.countOfGroup.get(userId, groupName).n;
  }

  return {
    list,
    get,
    getCredential,
    fieldNames,
    missing,
    labelOf,
    create,
    rename,
    set,
    remove,
    removeUser,
    countOfGroup,
  };
}
