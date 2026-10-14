/**
 * 邀请码 —— 新用户进来的唯一入口
 *
 * 【为什么不是开放注册】
 *   这个服务跑在单机上，出口 IP 只有一个，跑的又是别人网站的账号。
 *   开放注册意味着任何人都能把凭据交给这台机器、都能消耗那个出口 IP，
 *   而你能做的控制只有一个「事后删号」。邀请码把决定权放在事前（需求文档 §6）。
 *
 * 【并发重放】
 *   单次码被两个人同时提交时，靠 `UPDATE ... WHERE used_count < max_uses` 的
 *   changes 判断胜负——只有一个请求能把计数加上去，另一个失败。
 *   这是唯一可靠的地方：先 SELECT 再 UPDATE 会留下竞态窗口。
 */
import crypto from 'node:crypto';

export const DEFAULT_EXPIRE_DAYS = 7;

export function newInviteCode() {
  // 32 字节随机：不可猜，也就不需要「隐藏码本身」
  return crypto.randomBytes(32).toString('base64url');
}

export function createInvites(db) {
  const st = {
    insert: db.prepare(
      `INSERT INTO invites (code, created_by, created_at, expires_at, max_uses, used_count, note)
       VALUES (@code, @created_by, @created_at, @expires_at, @max_uses, 0, @note)`,
    ),
    byCode: db.prepare('SELECT * FROM invites WHERE code = ?'),
    recent: db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT ?'),
    /** 条件更新：用完/撤销的码更新不到行，changes 为 0 */
    bump: db.prepare(
      `UPDATE invites SET used_count = used_count + 1, used_by = ?
       WHERE code = ? AND revoked_at IS NULL AND used_count < max_uses`,
    ),
    revoke: db.prepare('UPDATE invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL'),
  };

  /**
   * @param {object} args
   * @param {number} args.createdBy
   * @param {number} [args.expiresInDays] 0 或 null = 长期有效
   * @param {number} [args.maxUses]
   * @param {string} [args.note] 给谁的，备查
   */
  function create({ createdBy, expiresInDays = DEFAULT_EXPIRE_DAYS, maxUses = 1, note = '' } = {}) {
    if (!Number.isInteger(createdBy)) throw new Error('create 需要 createdBy');
    const uses = Number.isInteger(maxUses) && maxUses > 0 ? maxUses : 1;
    const code = newInviteCode();
    const now = Date.now();
    st.insert.run({
      code,
      created_by: createdBy,
      created_at: now,
      expires_at: expiresInDays > 0 ? now + expiresInDays * 86_400_000 : null,
      max_uses: uses,
      note: String(note ?? '').slice(0, 120),
    });
    return st.byCode.get(code);
  }

  /** 只判断不改状态。页面的提示与提交时的校验用同一份逻辑 */
  function check(code, now = Date.now()) {
    if (!code || typeof code !== 'string') {
      return { ok: false, reason: 'missing', message: '缺少邀请码' };
    }
    const row = st.byCode.get(code);
    if (!row) return { ok: false, reason: 'not-found', message: '邀请码无效' };
    if (row.revoked_at) return { ok: false, reason: 'revoked', message: '邀请码已被撤销' };
    if (row.expires_at && now > row.expires_at) {
      return { ok: false, reason: 'expired', message: '邀请码已过期' };
    }
    if (row.used_count >= row.max_uses) {
      return { ok: false, reason: 'exhausted', message: '邀请码已用完' };
    }
    return { ok: true, invite: row };
  }

  /** 只能在事务里调用：返回 false 表示被抢先用了（或码已失效） */
  function consume(code, userId) {
    return st.bump.run(userId, code).changes > 0;
  }

  function list(limit = 50) {
    return st.recent.all(limit);
  }

  function revoke(code) {
    return st.revoke.run(Date.now(), code).changes > 0;
  }

  /** 给界面用：把一行 invites 翻成「能不能用、为什么」 */
  function describe(row, now = Date.now()) {
    if (!row) return null;
    let state = 'unused';
    if (row.revoked_at) state = 'revoked';
    else if (row.used_count >= row.max_uses) state = 'used';
    else if (row.expires_at && now > row.expires_at) state = 'expired';
    else if (row.used_count > 0) state = 'partial';
    return {
      code: row.code,
      note: row.note,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      usedCount: row.used_count,
      usedBy: row.used_by,
      state,
    };
  }

  return { create, check, consume, list, revoke, describe };
}
