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
import { CookieJar, readJson, request as defaultRequest } from '../src/http.mjs';
import { formatBytes } from '../src/format.mjs';

const BASE = 'https://v2free.net';

/** 1024 进制，与 src/format.mjs 的 formatBytes 保持一致 */
const UNIT_BYTES = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 };

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

/**
 * 站点流量字符串 → 字节数。支持 "485.94MB" / "1.02 GB" / "0B" / 纯数字（按字节，契约里
 * bytes 类型的语义）。
 *
 * 解析不了返回 null 而不是 0 —— 猜错的单位会显示成一个像真的假数字，比空着更糟。
 */
export function parseTraffic(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|PB)?$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'B').toUpperCase();
  return n * (UNIT_BYTES[unit] ?? 1);
}

/**
 * 从签到接口文案里提取获得的流量（如「获得了 1.5GB 流量」）。
 *
 * 先只认「获得」附近的数字，避免把「连续签到 3 天」这类数字当成流量；
 * 「获得」附近没有才退到全句找带单位的数字。
 */
export function parseGainFromMessage(msg) {
  const s = String(msg ?? '');
  if (!s) return null;
  const m =
    /获得[^，。；]{0,12}?(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB|PB)/i.exec(s) ??
    /(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB|PB)\b/i.exec(s);
  if (!m) return null;
  const unit = m[2].toUpperCase();
  return Number(m[1]) * (UNIT_BYTES[unit] ?? 1);
}

/**
 * 本次签到实际领到多少流量：接口文案优先，拿不到再用签到前后的剩余量差值。
 *
 * 差值为负说明期间有消耗（签到没给或给得比用的少），此时返回 null ——
 * 「本次获得」不该出现负数。
 */
export function gainedTraffic({ msg, before, after }) {
  const fromMsg = parseGainFromMessage(msg);
  if (fromMsg) return fromMsg;
  const b = parseTraffic(before);
  const a = parseTraffic(after);
  if (b == null || a == null) return null;
  const diff = a - b;
  return diff > 0 ? diff : null;
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

  /**
   * 北京时间窗口，实际执行时刻由种子化随机决定（种子含账号，见 src/schedule.mjs）。
   *
   * 窗口从 50 分钟拉长到 120 分钟：出口 IP 只有一个（N150），同一站点的多个账号
   * 必须靠时间拉开，而不是靠调度器「同一用户只许一个在飞」那 30 秒兜底。
   * 3 个账号在 120 分钟里的平均间隔约 40 分钟。
   */
  schedule: { window: { start: '08:30', end: '10:30' } },

  /**
   * 登录 + 读两次账户页 + 签到，请求本身实测数秒。
   * 45s 而非 30s：每个请求之间还有 1~3 秒的同域名节流（见 src/http.mjs），
   * 4 个请求最坏要额外等 9 秒，30 秒的预算会被吃掉三分之一。
   */
  timeoutMs: 45_000,

  /**
   * 结果字段声明 —— 界面照这个渲染，**因此以后再加任务不需要改界面代码**。
   * 只列真正要看的三项：签到领到多少、还剩多少、上次签到是何时。
   *
   * 未声明的字段（trafficMain / trafficPackage / balance / lastUsed / expire / plan）
   * 仍然落库，只是页面不展示 —— 需要时能从执行历史的记录里查到。
   */
  view: [
    { key: 'gainedTraffic', label: '本次获得', type: 'bytes' },
    { key: 'remainTraffic', label: '剩余流量', type: 'bytes' },
    { key: 'lastCheckin', label: '上次签到', type: 'datetime' },
  ],

  /*
   * request 由执行器注入（绑定到本账号的 UA），默认值只为「直接调 task.run」的场景兜底。
   * 不要在这里 import 模块级 request 来用——那样多个账号会共用同一个 UA。
   */
  async run({ secrets, log, request = defaultRequest }) {
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
      // 只有真的签到成功才有「本次获得」；其余分支留空，界面显示「—」
      const gain = gainedTraffic({
        msg: checkJson.msg,
        before: info?.remainTraffic,
        after: latest?.remainTraffic,
      });
      // message 里必须带上获得的流量：概览页「最近执行」只渲染 message，不渲染 view 行，
      // 写「签到成功」等于那一行什么都没说。数字宁可在详情页与「本次获得」重复一次，
      // 也不能在最常被看到的那一屏里缺失。
      // 拿不到数字（站点文案没给、签到前后差值也没变）时退回短句，不编一个数字出来。
      return {
        status: 'success',
        message: gain ? `签到成功，获得了 ${formatBytes(gain)} 流量` : '签到成功',
        data: gain ? { ...data, gainedTraffic: gain } : data,
      };
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
