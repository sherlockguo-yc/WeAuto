/**
 * 一次性配对码 + 长期上传令牌
 *
 * 要解决的问题：有些凭据（如 WorkBuddy 的 accessToken）只能从用户本机的客户端里抓，
 * 而任务配置在服务器上。让用户「跑完脚本再手抄 token 粘到网页」是最难用的一步，
 * 所以让脚本直接把值推上来。
 *
 * 但脚本没有登录态（它是 curl 那一侧的，没有 Cookie），怎么证明「这个推送属于哪个任务」？
 * 两段式：
 *   1. 用户在页面上点「一键更新」→ 服务器发一个**一次性配对码**（默认 10 分钟）
 *   2. 脚本带码推送 → 服务器验码、写入凭据，并回发一个**长期 pushToken**
 *      脚本把它存在本机 ~/.weauto/bind.json，以后每月直接推送，不再需要打开页面
 *
 * 为什么配对码要一次性：它会出现在命令行里（会被 shell 历史、进程列表看到），
 * 有效期短 + 用完即删，把泄漏窗口压到最小。长期 pushToken 只存在本机文件（0600）
 * 与服务器密文里，不进命令行。
 *
 * 存储在内存里而不是数据库：配对码只有 10 分钟寿命，服务重启后失效是**可接受**的
 * （用户重新点一次按钮即可），换来的是不用为临时状态加一张表和一个清理任务。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 去掉容易看错的 I / O / 0 / 1：这个码要被人从屏幕上抄到终端里 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

function randomCode() {
  const bytes = randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  // 分成两段只是为了好念：XXXX-XXXX
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export const DEFAULT_PAIR_TTL_MS = 10 * 60_000;

export function createPairing({ ttlMs = DEFAULT_PAIR_TTL_MS, now = Date.now } = {}) {
  /**
   * code → { userId, credentialId, expiresAt }
   *
   * 码绑定的是**账号**，不是任务：一个 WorkBuddy 账号被签到和活跃两个任务引用时，
   * 抓一次 token 就该同时生效，而不是每个任务各抓一遍。
   */
  const codes = new Map();
  /** credentialId → 最近一次推送完成的时间戳（页面靠它判断"脚本跑完了"） */
  const pushed = new Map();

  function prune() {
    const t = now();
    for (const [code, entry] of codes) {
      if (entry.expiresAt <= t) codes.delete(code);
    }
  }

  return {
    /** 发一个新码。同一账号可以同时有多个未使用的码（多点几次不会互相作废） */
    issue({ userId, credentialId }) {
      prune();
      const code = randomCode();
      const expiresAt = now() + ttlMs;
      codes.set(code, { userId, credentialId: Number(credentialId), expiresAt });
      return { code, expiresAt };
    },

    /**
     * 兑换。**无论成功与否都不区分大小写**，且成功即删除。
     * 返回 null 表示码不存在或已过期——调用方统一回「无效或已过期」，
     * 不告诉攻击者是"不存在"还是"过期了"。
     */
    redeem(input) {
      prune();
      const key = String(input ?? '').trim().toUpperCase();
      if (!key) return null;
      const entry = codes.get(key);
      if (!entry) return null;
      codes.delete(key);
      return { userId: entry.userId, credentialId: entry.credentialId };
    },

    markPushed(credentialId) {
      pushed.set(Number(credentialId), now());
    },

    pushedAt(credentialId) {
      return pushed.get(Number(credentialId)) ?? null;
    },

    /** 仅测试用：看还有多少个未兑换的码 */
    get pending() {
      prune();
      return codes.size;
    },
  };
}

/**
 * 长期上传令牌：`wt2_<userId>_<credentialId>_<secret>`
 *
 * 把 userId / credentialId 编进令牌是为了**一次查库就能定位账号**——否则得遍历
 * 所有用户比对密文。它们不是秘密（账号 id 在 URL 里就有），真正的凭据是最后那段
 * 随机串，而它在服务器侧只以密文形式存在（当成一个普通字段存）。
 */
export function makePushToken({ userId, credentialId }) {
  return `wt2_${userId}_${credentialId}_${randomBytes(18).toString('base64url')}`;
}

/**
 * 解析上传令牌。
 *
 * 兼容 `wt1_<userId>_<taskId>_...`：那是「凭据还挂在任务上」时代发给脚本的令牌，
 * 已经下载到用户机器上的脚本不该因为一次升级就全部失效（它们还会每月自动跑）。
 * 调用方拿到 `taskId` 时自己去任务行取 credentialId。
 *
 * @returns {{userId:number, credentialId:number|null, taskId:number|null}|null}
 */
export function parsePushToken(token) {
  const s = String(token ?? '');
  const v2 = /^wt2_(\d{1,12})_(\d{1,12})_([A-Za-z0-9_-]{16,})$/.exec(s);
  if (v2) return { userId: Number(v2[1]), credentialId: Number(v2[2]), taskId: null };
  const v1 = /^wt1_(\d{1,12})_(\d{1,12})_([A-Za-z0-9_-]{16,})$/.exec(s);
  if (v1) return { userId: Number(v1[1]), credentialId: null, taskId: Number(v1[2]) };
  return null;
}

/** 定长比较，避免按字节短路泄漏位置信息 */
export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * 校验推送上来的值像不像一个 JWT。
 *
 * 不做签名校验（那需要 SSO 的公钥，且真正的校验在目标站点）。这里只挡住
 * 明显的错误输入——比如用户粘了半截、或者粘了别的东西——让错误在推送这一刻
 * 就暴露，而不是等到第二天任务跑失败才发现。
 */
export function looksLikeJwt(value) {
  return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(String(value ?? '').trim());
}

/** 解 JWT 的 exp（毫秒）。解不出来返回 null，不抛错 */
export function tokenExpiryMs(token) {
  const part = String(token ?? '').split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}
