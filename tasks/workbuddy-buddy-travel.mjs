/**
 * WorkBuddy 派 Buddy 旅行 —— 每天出门一次，回来领 5~10 积分
 *
 * 接口与规则全部取自**官方前端 bundle**（2026-11-02 读取，非推测）：
 *   · 网页端在 https://www.workbuddy.cn/profile/growth-center
 *   · 接口封装见 assets.workbuddy.cn/.../growthSpace-BiD1i4dd.js：
 *       GET  /activity/growth/buddy/travel/config    地点与文案
 *       GET  /activity/growth/buddy/travel/status    当前状态
 *       POST /activity/growth/buddy/travel/depart    { location_id }
 *       POST /activity/growth/buddy/travel/claim     {}
 *   · 响应字段取自 GrowthCenterPage-*.js 的映射函数 nt()：
 *       { state, location, depart_at, arrive_at, server_now,
 *         letter, use_deeplink, daily_limit_reached, reward_credit }
 *     state ∈ idle / traveling / arrived，时间是**秒**级时间戳。
 *   · 报错文案（前端用 includes 判断，所以后端返回的是英文）：
 *       depart: "daily limit" / "no active buddy" / "already traveling" / "location not available"
 *       claim : "not arrived yet" / "no unclaimed travel" / "grant credits failed"
 *
 * 活动条款（页面内嵌原文）：
 *   · 旅行时长 1~4 小时随机，单次奖励 5~10 积分
 *   · 回家后**必须在下一次派出之前**领取，逾期视为放弃
 *   · 每位用户每日可派 1 次，按自然日重置
 *
 * 「每天 1 次 + 必须先领再派」正好等于本框架的 window 调度（一天跑一次），
 * 所以不需要 every 轮询：一次执行里先领后派，顺序就是条款要求的顺序。
 *
 * ⚠️ 待实测（2026-11-03）：网页端用 /activity 前缀、桌面客户端用 /v2/activity，
 *    两者是否等价未验证。PROBE 脚本会先给出结论，再决定是否保留 API_PREFIX。
 */
import { readJson, request as defaultRequest } from '../src/http.mjs';
import { timestampInTZ } from '../src/util.mjs';
import { STATUS } from '../src/task-contract.mjs';
// 与签到/活跃同一把 token，剩余天数判断复用同一份实现，避免三个任务各写一遍
import { daysLeft, tokenExpiryMs, WARN_DAYS } from './workbuddy-checkin.mjs';

const BASE = 'https://www.workbuddy.cn';
const API_PREFIX = '/activity/growth/buddy';
const STATUS_PATH = `${API_PREFIX}/travel/status`;
const CONFIG_PATH = `${API_PREFIX}/travel/config`;
const DEPART_PATH = `${API_PREFIX}/travel/depart`;
const CLAIM_PATH = `${API_PREFIX}/travel/claim`;

/** 站点成功码（与签到同一个网关、同一套 {code,msg,data}） */
const CODE_OK = 0;

export const TRAVEL_IDLE = 'idle';
export const TRAVELING = 'traveling';
export const ARRIVED = 'arrived';

/** 单次最多发 4 个请求；域名节流 1~3 秒一个，40s 留足跨境抖动 */
const REQ_TIMEOUT_MS = 20_000;

/* ───────────────────── 纯函数（可测） ───────────────────── */

/**
 * status / depart 响应 → 归一化快照。
 *
 * 一律 ?? 兜底而不是解构：字段缺一个不该让整次执行抛错，
 * 但**也不给假数据** —— 缺就是 0 / null，由上层决定要不要显示。
 */
export function parseTravel(raw) {
  const d = raw ?? {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    state: String(d.state ?? TRAVEL_IDLE),
    location: d.location && typeof d.location === 'object' ? d.location : null,
    departAt: num(d.depart_at),
    arriveAt: num(d.arrive_at),
    serverNow: num(d.server_now),
    dailyLimitReached: d.daily_limit_reached === true,
    rewardCredit: num(d.reward_credit),
    letter: d.letter ?? null,
  };
}

/**
 * 快照 → 这次要做什么。
 *
 * 两个动作互不排斥：可以先领再派（条款要求的顺序），也可以只做其中一个。
 *   · needClaim：state=arrived 才算「回了家」。traveling 但本地算着已过 arrive_at
 *     时也试一次 —— 服务端状态可能滞后几秒，claim 失败只是白跑一个请求。
 *   · canDepart：**唯一判据是今天的次数**（dailyLimitReached），不是当前状态。
 *     早派晚归的号在早上是 idle、晚上是 arrived，两种都还能派；中午派出的号
 *     下午回来会带着 dailyLimitReached=true，这时只能领。把「state=idle」当条件
 *     会让「昨天派出、今天归来」的账号永远派不出去。
 */
export function planFor(s) {
  const arrivedByClock = s.state === TRAVELING && s.arriveAt > 0 && s.serverNow >= s.arriveAt;
  const needClaim = s.state === ARRIVED || arrivedByClock;
  return {
    needClaim,
    canDepart: !s.dailyLimitReached && (s.state === TRAVEL_IDLE || needClaim),
  };
}

/**
 * 从 config 的地点表里挑一个。
 *
 * 不用种子固定：每天换一个地点更像真人（旅行记录里全是同一个城市会很怪）。
 * 但**必须过滤掉没有 id 的项** —— 传 undefined 给 depart 只会换回一个
 * location not available，把「配置改了」伪装成「网络失败」。
 */
export function pickLocation(locations, random = Math.random) {
  const list = (Array.isArray(locations) ? locations : []).filter((l) => l && l.id != null && l.id !== '');
  if (list.length === 0) return null;
  const i = Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)));
  return list[i];
}

/** 失败文案 → 归类。后端返回英文，大小写按前端一律 lower 处理 */
export function classifyError(httpStatus, msg) {
  const m = String(msg ?? '').toLowerCase();
  if (httpStatus === 429 || m.includes('daily limit')) return 'daily-limit';
  if (m.includes('already traveling')) return 'traveling';
  if (m.includes('no active buddy')) return 'no-buddy';
  if (m.includes('location not available')) return 'location';
  if (m.includes('not arrived yet') || m.includes('no unclaimed travel')) return 'nothing-to-claim';
  if (m.includes('grant credits failed')) return 'grant-failed';
  if (httpStatus === 401) return 'unauthorized';
  return 'unknown';
}

/** 秒级时间戳 → 北京时间字符串；0/缺失时给空串（界面显示「—」而不是 1970） */
export function clockText(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? timestampInTZ(new Date(seconds * 1000)) : '';
}

/* ───────────────────── 请求 ───────────────────── */

/**
 * 统一的 API 调用。
 *
 * Referer 指向成长中心页：真实浏览器从这里发起 XHR，缺了它这个接口
 * 比签到接口更容易被网关判成「直接调用」。UA 由执行器按账号注入。
 */
async function api(request, token, path, { method = 'GET', body } = {}) {
  const res = await request(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN',
      Referer: `${BASE}/profile/growth-center`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    timeout: REQ_TIMEOUT_MS,
  });
  const { json, text } = await readJson(res);
  return { httpStatus: res.status, json, text };
}

/** 非 2xx / 非 JSON / code≠0 都收敛成一个字符串，调用方只需判断有没有值 */
function failureOf(r) {
  if (r.httpStatus === 401) return { kind: 'unauthorized', msg: '凭据已失效（HTTP 401）' };
  if (!r.json) return { kind: 'blocked', msg: `返回非 JSON（HTTP ${r.httpStatus}）` };
  const code = r.json.code;
  if (code === CODE_OK) return null;
  const kind = classifyError(r.httpStatus, r.json.msg);
  return { kind, msg: r.json.msg ? `${r.json.msg}（code=${code}）` : `未知返回码 ${code}` };
}

/* ───────────────────── 任务 ───────────────────── */

export default {
  name: 'workbuddy-buddy-travel',
  displayName: 'WorkBuddy 派 Buddy 旅行',
  description: '每天派出 Buddy 旅行（1~4 小时后归来），并领取上一次旅行的 5~10 积分',
  group: '签到',
  tags: ['积分', '旅行', 'Buddy'],
  requires: ['WB_ACCESS_TOKEN'],

  /** 与签到同一个抓取脚本：token 只存在于桌面客户端进程内存里 */
  credentialHelper: {
    download: 'grab-workbuddy-token.mjs',
    launchScript: 'grab-workbuddy-token.sh',
    command: 'node grab-workbuddy-token.mjs',
    note: '需要 Node.js 18+，没装也没关系：启动器会自己装一份便携版（Windows 约 36MB / macOS 约 50MB，全程不需要管理员权限）。客户端装在 C 盘以外也能自动找到；运行时会短暂重启 WorkBuddy（约 10 秒），完成后自动恢复原样。',
  },

  accounts: false,

  /**
   * 先只给 admin 看：接口路径与字段名是从官方前端 bundle 读出来的，
   * 但「/activity 还是 /v2/activity」要等一次真实 token 的实测（见文件头 ⚠️）。
   * 实测通过后删掉这一行即可对所有人开放。
   */
  visibility: 'internal',

  /** 与签到、活跃共用一把 token：填过一次，三个任务都能跑 */
  credentialGroup: 'workbuddy',

  /** 与签到同窗；种子含任务名，所以两者落在窗口内不同时刻 */
  schedule: { window: { start: '09:00', end: '09:50' } },

  /** 最多 4 个请求，域名节流 1~3 秒一个 */
  timeoutMs: 60_000,

  view: [
    { key: 'credit', label: '本次领取积分', type: 'number' },
    { key: 'locationName', label: '旅行地点', type: 'text' },
    { key: 'arriveAtLabel', label: '预计归来', type: 'text' },
    { key: 'state', label: '当前状态', type: 'text' },
    { key: 'dailyLimitReached', label: '今日已派完', type: 'bool' },
    { key: 'tokenDaysLeft', label: '凭据剩余天数', type: 'number' },
  ],

  async run({ secrets, request = defaultRequest, log }) {
    const token = secrets.WB_ACCESS_TOKEN;
    const expMs = tokenExpiryMs(token);
    const left = daysLeft(expMs);

    if (left !== null && left < 0) {
      return {
        status: STATUS.CONFIG,
        message: `凭据已于 ${timestampInTZ(new Date(expMs))} 过期（${-left} 天前），请重新获取 WB_ACCESS_TOKEN`,
        data: { tokenDaysLeft: left },
      };
    }
    if (left !== null && left <= WARN_DAYS) {
      log(`⚠️ 凭据 ${left} 天后过期，到期前旅行任务会失败，请提前更新`);
    }

    /* ── 1. 查状态 ── */
    let statusRes;
    try {
      statusRes = await api(request, token, STATUS_PATH);
    } catch (err) {
      return { status: STATUS.NETWORK, message: `查询旅行状态失败：${err.message}` };
    }
    const statusFail = failureOf(statusRes);
    if (statusFail) {
      return {
        status: statusFail.kind === 'unauthorized' ? STATUS.CONFIG : STATUS.BLOCKED,
        message:
          statusFail.kind === 'unauthorized'
            ? `${statusFail.msg}，请重新获取 WB_ACCESS_TOKEN 并填写到任务页`
            : `查询旅行状态异常：${statusFail.msg}`,
        data: Number.isFinite(left) ? { tokenDaysLeft: left } : {},
      };
    }

    const snap = parseTravel(statusRes.json.data);
    const plan = planFor(snap);
    log(`当前状态 ${snap.state}${snap.dailyLimitReached ? '（今日已派满）' : ''}`);

    const data = {
      state: snap.state,
      dailyLimitReached: snap.dailyLimitReached,
    };
    if (Number.isFinite(left)) data.tokenDaysLeft = left;
    if (snap.location?.name) data.locationName = snap.location.name;
    if (snap.arriveAt) data.arriveAtLabel = clockText(snap.arriveAt);

    let credit = 0;
    let claimedSomething = false;
    let departNote = '';
    let alreadyReason = '';

    /* ── 2. 先领：条款要求「下次派出之前」领，所以顺序不能反 ── */
    if (plan.needClaim) {
      let claimRes;
      try {
        claimRes = await api(request, token, CLAIM_PATH, { method: 'POST', body: {} });
      } catch (err) {
        return { status: STATUS.NETWORK, message: `领取奖励请求失败：${err.message}`, data };
      }
      const claimFail = failureOf(claimRes);
      if (claimFail?.kind === 'unauthorized') {
        return { status: STATUS.CONFIG, message: '凭据已失效（HTTP 401），请重新获取 WB_ACCESS_TOKEN', data };
      }
      if (claimFail?.kind === 'nothing-to-claim') {
        // 服务端认为还没到/没有可领的：不是错误，继续走派出
        log('暂无可领取的奖励（可能刚回来，状态还没落库）');
      } else if (claimFail) {
        // 领取失败不该拦住派出，但要如实记下来
        log(`⚠️ 领取失败：${claimFail.msg}`);
      } else {
        const d = claimRes.json.data ?? {};
        credit = Number.isFinite(Number(d.reward_credit)) ? Number(d.reward_credit) : 0;
        claimedSomething = true;
        data.credit = credit;
        data.state = TRAVEL_IDLE;
        // 领取不重置每日次数：今天派过就还是派过，plan.canDepart 已在领取前算好
        log(`已领取 ${credit} 积分`);
      }
    }

    /* ── 3. 再派：只在 idle 且今天还没派过时 ── */
    if (plan.canDepart) {
      let configRes;
      try {
        configRes = await api(request, token, CONFIG_PATH);
      } catch (err) {
        return {
          status: claimedSomething ? STATUS.SUCCESS : STATUS.NETWORK,
          message: claimedSomething
            ? `已领取 ${credit} 积分，但查询旅行地点失败：${err.message}`
            : `查询旅行地点失败：${err.message}`,
          data,
        };
      }
      const configFail = failureOf(configRes);
      const locations = configFail ? [] : (configRes.json.data?.locations ?? []);
      const place = pickLocation(locations);

      if (!place) {
        return {
          status: claimedSomething ? STATUS.SUCCESS : STATUS.BLOCKED,
          message: claimedSomething
            ? `已领取 ${credit} 积分，但旅行功能当前不可用（没有可选地点）`
            : '旅行功能当前不可用：地点列表为空（活动可能未向你开放）',
          data,
        };
      }

      let departRes;
      try {
        departRes = await api(request, token, DEPART_PATH, {
          method: 'POST',
          body: { location_id: place.id },
        });
      } catch (err) {
        return {
          status: claimedSomething ? STATUS.SUCCESS : STATUS.NETWORK,
          message: claimedSomething
            ? `已领取 ${credit} 积分，但派出失败：${err.message}`
            : `派出请求失败：${err.message}`,
          data,
        };
      }

      const departFail = failureOf(departRes);
      if (departFail?.kind === 'daily-limit') {
        alreadyReason = '今日已派过 Buddy（每日 1 次）';
        data.dailyLimitReached = true;
      } else if (departFail?.kind === 'traveling') {
        alreadyReason = 'Buddy 还在路上，今天无法再派';
      } else if (departFail?.kind === 'no-buddy') {
        return {
          status: claimedSomething ? STATUS.SUCCESS : STATUS.BLOCKED,
          message: claimedSomething
            ? `已领取 ${credit} 积分，但还没有 Buddy 可以派出（先去开盲盒领一只）`
            : '还没有 Buddy 可以派出（先去成长空间开盲盒领一只）',
          data,
        };
      } else if (departFail) {
        return {
          status: claimedSomething ? STATUS.SUCCESS : STATUS.FAILED,
          message: claimedSomething
            ? `已领取 ${credit} 积分，但派出失败：${departFail.msg}`
            : `派出失败：${departFail.msg}`,
          data,
        };
      } else {
        const after = parseTravel(departRes.json.data);
        data.locationName = after.location?.name ?? place.name ?? '';
        data.arriveAtLabel = clockText(after.arriveAt);
        data.state = after.state || TRAVELING;
        data.dailyLimitReached = after.dailyLimitReached;
        departNote = `已派 ${data.locationName || 'Buddy'} 出门${data.arriveAtLabel ? `，预计 ${data.arriveAtLabel} 归来` : ''}`;
        log(departNote);
      }
    }

    /* ── 4. 组装结论 ── */
    const parts = [];
    if (claimedSomething) parts.push(`领取 ${credit} 积分`);
    if (departNote) parts.push(departNote);
    if (!claimedSomething && !departNote) {
      if (snap.state === TRAVELING) parts.push(`Buddy 还在路上${data.arriveAtLabel ? `，预计 ${data.arriveAtLabel} 归来` : ''}`);
      else if (alreadyReason) parts.push(alreadyReason);
      else if (snap.dailyLimitReached) parts.push('今日已派过且已领取');
      else parts.push('无需操作');
    }

    const status = claimedSomething || departNote ? STATUS.SUCCESS : STATUS.ALREADY;
    const tail = Number.isFinite(left) && left <= WARN_DAYS ? `；凭据 ${left} 天后过期，请更新` : '';

    return { status, message: `${parts.join('；')}${tail}`, data };
  },
};
