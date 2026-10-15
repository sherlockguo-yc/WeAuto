/**
 * v2free 机场每日签到
 *
 * 以下行为均来自 2026-10-13 的接口探针实测（非推测）：
 *   · POST /auth/login  form-urlencoded，字段 agree/email/passwd/remember_me
 *     返回 {"ret":1,"msg":"登录成功"}；无需 CSRF token；账号未开启两步验证
 *   · 登录成功后写入自定义 Cookie（uid/email/key/ip/expire_in），Max-Age=3600
 *     → session 仅 1 小时，故每次执行都必须重新登录（remember_me 实测无效）
 *   · POST /user/checkin  {"ret":1,...} 签到成功
 *                         {"ret":0,"msg":"您似乎已经签到过了..."} 今日已签
 *                         {"ret":0,"msg":"请求过于频繁，请稍后再试"} 站点限流
 *   · 账户页内嵌 crispSessionData 结构化数组，含 traffic / expire / plan 等字段，
 *     比正则解析 HTML 更可靠，作为面板取数的数据源
 */
import { CookieJar, readJson, request } from '../src/http.mjs';

const BASE = 'https://v2free.net';

/** 从页面内嵌的 crispSessionData 提取结构化账户数据 */
export function parseSessionData(html) {
  const m = /crispSessionData\s*=\s*(\[[\s\S]*?\]\])\s*;/.exec(html);
  if (!m) return null;
  try {
    const pairs = JSON.parse(m[1])[0];
    if (!Array.isArray(pairs)) return null;
    const raw = Object.fromEntries(pairs);
    return {
      remainTraffic: raw.traffic ?? null,
      trafficMain: raw.traffic_main ?? null,
      trafficPackage: raw.traffic_package ?? null,
      plan: raw.plan ?? null,
      expire: raw.expire ?? null,
      lastUsed: raw.last_used ?? null,
      balance: raw.balance ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * 页面上的「上次签到」时间
 * 页面实际结构为 `<b>上次签到</b>:2026-10-13 12:18:43`，标签夹在中间，故不能直接邻接匹配
 */
export function parseLastCheckin(html) {
  const m = /上次签到[\s\S]{0,40}?(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/.exec(html);
  return m ? m[1] : null;
}

/** 页面是否已标记今日签到（用于跳过无谓的签到请求，避免撞站点频率限制） */
export function hasSignedToday(html) {
  return /今日已签到/.test(html);
}

export default {
  name: 'v2free-checkin',
  displayName: 'v2free 机场每日签到',
  description: '登录 v2free 领取当日免费流量',
  group: '签到',
  tags: ['签到', '机场'],
  requires: ['V2FREE_EMAIL', 'V2FREE_PASSWORD'],

  /** 允许一个人配多个 v2free 账号，各自独立签到 */
  accounts: true,

  /** 北京时间窗口；实际执行时刻由种子化随机决定，每天不同 */
  schedule: { window: { start: '09:00', end: '09:50' } },

  /** 登录 + 读两次账户页 + 签到，实测数秒内完成 */
  timeoutMs: 30_000,

  /**
   * 结果字段声明 —— 界面照这个渲染，**因此以后再加任务不需要改界面代码**。
   * 未声明的字段（trafficMain / trafficPackage / balance / lastUsed）仍会出现在
   * 「原始数据」折叠区，不会丢。
   */
  view: [
    { key: 'remainTraffic', label: '剩余流量', type: 'bytes' },
    { key: 'expire', label: '到期时间', type: 'date' },
    { key: 'plan', label: '套餐', type: 'text' },
    { key: 'lastCheckin', label: '上次签到', type: 'datetime' },
  ],

  async run({ secrets, log }) {
    const jar = new CookieJar();

    /* ── 1. 登录 ── */
    const loginRes = await request(`${BASE}/auth/login`, {
      jar,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE}/auth/login`,
        Origin: BASE,
      },
      body: new URLSearchParams({
        agree: '1',
        email: secrets.V2FREE_EMAIL,
        passwd: secrets.V2FREE_PASSWORD,
        remember_me: 'on',
      }),
    });

    const { json: loginJson, text: loginText } = await readJson(loginRes);
    if (!loginJson) {
      return {
        status: 'blocked',
        message: `登录返回非 JSON（HTTP ${loginRes.status}），可能被风控拦截或站点改版`,
        data: { snippet: loginText.slice(0, 300) },
      };
    }
    if (loginJson.ret !== 1) {
      return { status: 'failed', message: `登录失败：${loginJson.msg ?? '未知原因'}` };
    }
    log(`登录成功，取得 ${jar.size} 个 Cookie`);

    /* ── 2. 读账户页：取状态，并判断今日是否已签到 ── */
    const userRes = await request(`${BASE}/user`, {
      jar,
      headers: { Referer: `${BASE}/auth/login` },
    });
    if (userRes.status === 302) {
      return { status: 'failed', message: '登录后访问 /user 被重定向，会话未生效' };
    }
    const html = await userRes.text();
    const info = parseSessionData(html);
    const lastCheckin = parseLastCheckin(html);

    if (hasSignedToday(html)) {
      return {
        status: 'already-signed',
        message: `今日已签到（上次签到 ${lastCheckin ?? '未知'}），未重复请求签到接口`,
        data: { ...info, lastCheckin },
      };
    }

    /* ── 3. 签到 ── */
    const checkRes = await request(`${BASE}/user/checkin`, {
      jar,
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE}/user`,
        Origin: BASE,
      },
    });
    const { json: checkJson, text: checkText } = await readJson(checkRes);
    if (!checkJson) {
      return {
        status: 'blocked',
        message: `签到返回非 JSON（HTTP ${checkRes.status}）`,
        data: { snippet: checkText.slice(0, 300), ...info, lastCheckin },
      };
    }

    /* ── 4. 回读页面，取签到后的最新流量 ── */
    let latest = info;
    try {
      const after = await request(`${BASE}/user`, { jar, headers: { Referer: `${BASE}/user` } });
      latest = parseSessionData(await after.text()) ?? info;
    } catch {
      /* 回读失败不影响签到结论 */
    }
    const data = { ...latest, lastCheckin: parseLastCheckin(html) };

    if (checkJson.ret === 1) {
      return { status: 'success', message: checkJson.msg ?? '签到成功', data };
    }
    if (/已经签到|已签到/.test(checkJson.msg ?? '')) {
      return { status: 'already-signed', message: checkJson.msg, data };
    }
    if (/频繁/.test(checkJson.msg ?? '')) {
      return {
        status: 'failed',
        message: `${checkJson.msg}——站点限流，本轮不重试，等待下次触发`,
        data,
      };
    }
    return { status: 'failed', message: checkJson.msg ?? '签到失败（未知原因）', data };
  },
};
