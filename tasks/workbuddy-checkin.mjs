/**
 * WorkBuddy 每日签到领积分
 *
 * 以下行为全部来自 2026-10-20 用客户端真实 Bearer token 的实测（非推测）：
 *
 *   · POST https://www.workbuddy.cn/billing/meter/daily-checkin   body={}
 *       成功  {"code":0,"msg":"OK","data":{"credit":100,"streak_days":1,"is_streak_day":false}}
 *       已签  {"code":10001,"msg":"今天已签到，请明天再来"}          ← 无 data 字段
 *       失效  HTTP 401 + APISIX 的 HTML 页（不是 JSON）
 *
 *   · POST /billing/meter/checkin-status **不能**用于幂等判断：
 *       签到成功后它依然返回 {"active":false,"today_checked_in":false,"total_credits":0,...}
 *       （活动配置为空，与真实签到结果脱节）。所以本任务不先查状态，直接调领取接口，
 *       把 code 10001 当作「今日已签」——实测中唯一可信的幂等信号。
 *
 *   · 鉴权只需 `Authorization: Bearer <token>`。X-User-Id / X-Domain 实测均非必需。
 *
 *   · token 有效期约 28 天（2026-10-20 签发的这枚 exp 到 2026-11-17），且 refresh_token
 *     取不到：客户端用 keyblob 加密存储，明文只存在于进程内存。
 *     因此策略是「本地解 JWT 的 exp 做过期预警 + 到期前提醒用户重填」，不做自动续期。
 */
import { readJson, request } from '../src/http.mjs';
import { timestampInTZ } from '../src/util.mjs';
import { STATUS } from '../src/task-contract.mjs';

const BASE = 'https://www.workbuddy.cn';
const CHECKIN_PATH = '/billing/meter/daily-checkin';

/** 站点成功码 */
const CODE_OK = 0;
/** 站点「今天已签到」码——实测第二次调用返回的就是它 */
const CODE_ALREADY = 10001;

const DAY_MS = 24 * 60 * 60 * 1000;
/** 剩余天数小于等于它就报警：28 天有效期下，留一周让人补凭据 */
export const WARN_DAYS = 7;

/**
 * 从 JWT 里读 exp（毫秒）。
 *
 * 不校验签名——这里只做「这把钥匙还能用多久」的本地提示，真正的校验在网关。
 * 返回 null 表示不是可解析的 JWT（用户可能填了个 cookie 或其他东西），
 * 此时不做拦截，照常发请求，让服务端给出准确结论。
 */
export function tokenExpiryMs(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** 剩余天数，向下取整；已过期返回负数。expMs 为 null 时返回 null */
export function daysLeft(expMs, nowMs = Date.now()) {
  if (!Number.isFinite(expMs)) return null;
  return Math.floor((expMs - nowMs) / DAY_MS);
}

/** 返回码 → 契约状态。未知码一律 failed，由调用方带上原始 msg */
export function claimStatus(code) {
  if (code === CODE_OK) return STATUS.SUCCESS;
  if (code === CODE_ALREADY) return STATUS.ALREADY;
  return STATUS.FAILED;
}

/**
 * 领取响应 → 落库字段。
 *
 * 只取真的存在且是数字的字段：缺失时留空，界面显示「—」，
 * 而不是编一个 0 出来（0 积分和没有数据是两件事）。
 *
 * nowMs 可注入，只为了让测试能固定时间——剩余天数是相对「现在」算的，
 * 不给入口的话断言只能在 28 与 27 之间飘。
 */
export function summarizeClaim(json, expMs, nowMs = Date.now()) {
  const d = json?.data ?? {};
  const out = {};
  if (Number.isFinite(d.credit)) out.credit = d.credit;
  if (Number.isFinite(d.streak_days)) out.streakDays = d.streak_days;
  if (typeof d.is_streak_day === 'boolean') out.isStreakDay = d.is_streak_day;
  const left = daysLeft(expMs, nowMs);
  if (left !== null) out.tokenDaysLeft = left;
  return out;
}

export default {
  name: 'workbuddy-checkin',
  displayName: 'WorkBuddy 每日签到领积分',
  description: '每天自动签到 WorkBuddy，领取当日积分与连续签到奖励',
  group: '签到',
  tags: ['签到', '积分'],
  requires: ['WB_ACCESS_TOKEN'],

  /**
   * 这个凭据没法"去某个后台注册一个 key"——它只能从桌面客户端进程里抓。
   * 所以把抓取方法直接内置进配置页：用户卡在输入框时，答案就在输入框上方。
   *
   * 界面渲染这段时不认识 workbuddy 这个名字，纯按字段渲染；将来同类任务
   * 只改自己的任务文件，UI 不用动。
   */
  credentialHelper: {
    download: 'grab-workbuddy-token.mjs',
    command: 'node grab-workbuddy-token.mjs',
    note: '需要 Node 18+。客户端装在 C 盘以外也能自动找到；运行时会短暂重启 WorkBuddy（约 10 秒），完成后自动恢复原样。',
  },

  /**
   * 一人一号。token 本身就是身份，多账号要靠多份 WB_ACCESS_TOKEN，
   * 而 requires 是「任务 + 账号」维度注入的，配 accounts:true 反而会让人
   * 误以为同一份 token 能给多个号签。
   */
  accounts: false,

  /** 北京时间窗口；实际执行时刻由种子化随机决定，每天不同 */
  schedule: { window: { start: '09:00', end: '09:50' } },

  /** 单次 POST，实测 200~400ms，30s 足够覆盖跨境抖动 */
  timeoutMs: 30_000,

  view: [
    { key: 'credit', label: '本次获得', type: 'number' },
    { key: 'streakDays', label: '连续签到', type: 'number' },
    { key: 'tokenDaysLeft', label: '凭据剩余天数', type: 'number' },
  ],

  async run({ secrets, log }) {
    const token = secrets.WB_ACCESS_TOKEN;
    const expMs = tokenExpiryMs(token);
    const left = daysLeft(expMs);

    if (left !== null && left < 0) {
      // 必然 401，提前给出「该换钥匙了」而不是让用户对着一行 invalid_token 猜
      return {
        status: STATUS.CONFIG,
        message: `凭据已于 ${timestampInTZ(new Date(expMs))} 过期（${-left} 天前），请重新获取 WB_ACCESS_TOKEN 并填写到任务页`,
        data: { tokenDaysLeft: left },
      };
    }
    if (left === null) {
      log('⚠️ WB_ACCESS_TOKEN 不是可解析的 JWT，跳过本地过期检查，交给服务端判定');
    } else {
      log(`凭据剩余 ${left} 天（到期 ${timestampInTZ(new Date(expMs))}）`);
      if (left <= WARN_DAYS) log(`⚠️ 凭据 ${left} 天后过期，到期前签到会失败，请提前更新`);
    }

    let res;
    try {
      res = await request(`${BASE}${CHECKIN_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept-Language': 'zh-CN',
        },
        body: '{}',
        timeout: 20_000,
      });
    } catch (err) {
      return { status: STATUS.NETWORK, message: `签到请求失败：${err.message}` };
    }

    /*
     * 401 必须单独判：网关返回的是 HTML 错误页，readJson 会拿到 null，
     * 若混进下面的「非 JSON」分支，用户看到的会是「可能被网关拦截」这种模糊话，
     * 而真实原因只是 token 过期——那是最常见的一种失败。
     */
    if (res.status === 401) {
      return {
        status: STATUS.CONFIG,
        message: '凭据已失效（HTTP 401 invalid_token），请重新获取 WB_ACCESS_TOKEN 并填写到任务页',
        data: Number.isFinite(left) ? { tokenDaysLeft: left } : {},
      };
    }

    const { json, text } = await readJson(res);
    if (!json) {
      return {
        status: STATUS.BLOCKED,
        message: `签到返回非 JSON（HTTP ${res.status}），可能被网关拦截或接口变更`,
        data: { snippet: text.slice(0, 300) },
      };
    }

    const status = claimStatus(json.code);
    const data = summarizeClaim(json, expMs);
    const tail = Number.isFinite(left) && left <= WARN_DAYS ? `；凭据 ${left} 天后过期，请更新` : '';

    if (status === STATUS.SUCCESS) {
      return {
        status,
        message:
          Number.isFinite(data.credit)
            ? `签到成功，获得 ${data.credit} 积分${Number.isFinite(data.streakDays) ? `（连续 ${data.streakDays} 天）` : ''}${tail}`
            : `签到成功${tail}`,
        data,
      };
    }
    if (status === STATUS.ALREADY) {
      return { status, message: `${json.msg ?? '今日已签到'}${tail}`, data };
    }
    return {
      status,
      message: json.msg ? `签到失败：${json.msg}` : `签到失败（未知返回码 ${json.code}）`,
      data,
    };
  },
};
