/**
 * 账号存储层
 *
 * 状态机刻意只保留两个状态（active / disabled），而不是照搬其它项目的
 * pending / banned / archived 四态：
 *   · pending 是 WeMonitor 的「注册后待管理员激活」流程，WeAuto 的账号
 *     由管理员在 UI 里直接创建，不存在「等待激活」这个中间态
 *   · archived 与 disabled 表达的是同一件事（不能登录），两套机制并存只会
 *     让「为什么这个人登不上」变成需要排查两个字段的问题
 * 少一个状态就少一类「两个字段互相矛盾」的 bug。
 */

export const STATUS = {
  /** 正常，可登录 */
  ACTIVE: 'active',
  /** 明确停用，拒绝登录 */
  DISABLED: 'disabled',
};

export const ROLES = ['user', 'admin'];

export const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** 注册/改密的校验，返回错误文案或 null */
export function validateNewCredentials(username, password) {
  if (!username || !password) return '用户名和密码不能为空';
  if (!USERNAME_RE.test(String(username))) {
    return '用户名 2-32 位，只允许字母、数字、下划线、中文';
  }
  if (String(password).length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (String(password).length > PASSWORD_MAX) return '密码过长';
  return null;
}

/** 对外暴露的用户对象：**永不含 password_hash** */
export function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
  };
}

export function createUserStore(db) {
  const sel = {
    byUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    all: db.prepare('SELECT * FROM users ORDER BY id'),
    insert: db.prepare(
      `INSERT INTO users (username, password_hash, role, status, created_at)
       VALUES (@username, @passwordHash, @role, @status, @createdAt)`,
    ),
    setStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM users WHERE id = ?'),
  };

  return {
    findByUsername: (username) => sel.byUsername.get(String(username)) || null,
    findById: (id) => sel.byId.get(id) || null,
    count: () => sel.count.get().n,
    list: () => sel.all.all().map(toPublic),

    create({ username, passwordHash, role = 'user', status = STATUS.ACTIVE, createdAt = Date.now() }) {
      const info = sel.insert.run({ username, passwordHash, role, status, createdAt });
      return toPublic(sel.byId.get(info.lastInsertRowid));
    },

    setStatus(id, status) {
      if (!Object.values(STATUS).includes(status)) throw new Error(`未知状态：${status}`);
      sel.setStatus.run(status, id);
      return toPublic(sel.byId.get(id));
    },

    setRole(id, role) {
      if (!ROLES.includes(role)) throw new Error(`未知角色：${role}`);
      sel.setRole.run(role, id);
      return toPublic(sel.byId.get(id));
    },

    setPasswordHash(id, hash) {
      sel.setPassword.run(hash, id);
      return toPublic(sel.byId.get(id));
    },

    touchLogin(id, at = Date.now()) {
      sel.touchLogin.run(at, id);
    },

    remove(id) {
      return sel.remove.run(id).changes > 0;
    },
  };
}
