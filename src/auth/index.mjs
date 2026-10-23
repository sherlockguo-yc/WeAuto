/**
 * WeAuto 本地登录模块（门面）
 *
 * 【边界】
 *   WeAuto 的账号与 WeMusic / WeMonitor 完全独立，不共享用户库、不共享 secret。
 *   这是 2026-10-14 的决定：把两个项目的用户合并会让他们互相登录到对方的系统，
 *   细节见 docs/requirements/weauto-standalone.md §13。
 *
 * 【调用方式】
 *   const db = openDb();
 *   const auth = createAuth({ db, jwtSecret: config.jwtSecret });
 *   auth.login('someone', 'password')  // → { ok, token, user } | { ok, error, code }
 *
 * db 由调用方注入（而不是本模块自己开库）：整个服务只有一个 SQLite 连接，
 * schema 由 src/db.mjs 的迁移统一管理，避免两处各建一半表。
 */
import { hashPassword, verifyPassword, burnTime } from './password.mjs';
import { sign, verify, fromAuthHeader, DEFAULT_TTL } from './token.mjs';
import {
  STATUS,
  ROLES,
  USERNAME_RE,
  PASSWORD_MIN,
  PASSWORD_MAX,
  NOTE_MAX,
  normalizeNote,
  validateNewCredentials,
  createUserStore,
  toPublic,
} from './users.mjs';

const MAX_FIELD_LEN = { username: 64, password: 256 };

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db 已迁移完成的数据库连接
 * @param {string} opts.jwtSecret 必填
 * @param {string} [opts.tokenTtl]
 */
export function createAuth({ db, jwtSecret, tokenTtl = DEFAULT_TTL } = {}) {
  if (!db) throw new Error('createAuth 需要已打开的数据库连接');
  if (!jwtSecret) throw new Error('createAuth 需要 jwtSecret');

  const store = createUserStore(db);

  return {
    STATUS,
    ROLES,

    /**
     * @returns {{ok: true, token: string, user: object}
     *         | {ok: false, error: string, code: 'invalid' | 'disabled'}}
     */
    login(username, password) {
      if (!username || !password) {
        return { ok: false, error: '用户名和密码不能为空', code: 'invalid' };
      }
      if (
        String(username).length > MAX_FIELD_LEN.username ||
        String(password).length > MAX_FIELD_LEN.password
      ) {
        return { ok: false, error: '用户名或密码错误', code: 'invalid' };
      }

      const row = store.findByUsername(username);
      // 用户不存在时同样消耗校验时间，防用户名枚举
      const valid = row ? verifyPassword(password, row.password_hash) : burnTime(password);
      if (!valid) {
        return { ok: false, error: '用户名或密码错误', code: 'invalid' };
      }
      if (row.status !== STATUS.ACTIVE) {
        return { ok: false, error: '该账号已被停用', code: 'disabled' };
      }

      store.touchLogin(row.id);
      const user = { id: row.id, username: row.username, role: row.role, status: row.status };
      return {
        ok: true,
        // se = 会话版本号，注销/改密时 +1，用来让旧 token 失效
        token: sign(
          { id: row.id, username: row.username, role: row.role, se: row.session_epoch ?? 0 },
          jwtSecret,
          tokenTtl,
        ),
        user,
      };
    },

    /** 创建账号。首个账号由调用方传 role='admin' */
    register({ username, password, role = 'user', status = STATUS.ACTIVE } = {}) {
      const invalid = validateNewCredentials(username, password);
      if (invalid) return { ok: false, error: invalid, code: 'invalid' };
      if (store.findByUsername(username)) {
        return { ok: false, error: '用户名已存在', code: 'exists' };
      }
      if (!ROLES.includes(role)) return { ok: false, error: `未知角色：${role}`, code: 'invalid' };
      if (!Object.values(STATUS).includes(status)) {
        return { ok: false, error: `未知状态：${status}`, code: 'invalid' };
      }

      return { ok: true, user: store.create({ username, passwordHash: hashPassword(password), role, status }) };
    },

    /** 验签失败返回 null，不抛异常 */
    verify: (token) => verify(token, jwtSecret),
    verifyHeader: (header) => verify(fromAuthHeader(header), jwtSecret),

    listUsers: () => store.list(),
    getUser: (id) => toPublic(store.findById(id)),
    countUsers: () => store.count(),
    setStatus: (id, status) => store.setStatus(id, status),
    setRole: (id, role) => store.setRole(id, role),
    /** 备注只给管理员用（/admin/users 的行内编辑），普通用户既读不到也写不了 */
    setNote: (id, note) => store.setNote(id, note),
    removeUser: (id) => store.remove(id),

    setPassword(id, newPassword) {
      if (!newPassword || String(newPassword).length < PASSWORD_MIN) {
        return { ok: false, error: `密码至少 ${PASSWORD_MIN} 位` };
      }
      if (String(newPassword).length > PASSWORD_MAX) return { ok: false, error: '密码过长' };
      store.setPasswordHash(id, hashPassword(newPassword));
      // 改密后旧会话必须失效：不改的话，偷到旧 token 的人照样能进来
      store.bumpSessionEpoch(id);
      return { ok: true };
    },

    /** 注销用：让这个账号之前签发的 token 全部作废 */
    bumpSessionEpoch: (id) => store.bumpSessionEpoch(id),
  };
}

export { STATUS, ROLES, USERNAME_RE, PASSWORD_MIN, PASSWORD_MAX, NOTE_MAX, normalizeNote };
