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
 *     ret=1 时还带 trafficInfo.unUsedTraffic（签到后的剩余流量）。站点前端就是拿
 *     这个字段刷新页面上那个「剩余」数字的（见 data/probe-user.html 的签到回调），
 *     所以它是签到之后的口径，比再读一次账户页更可信。
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

/**
 * 签到接口返回的「当前剩余流量」。
 *
 * 站点自己的前端签到成功后就拿这个字段刷新页面上的「剩余」
 * （`$$.getElementById('remain').innerHTML = data.trafficInfo['unUsedTraffic']`），
 * 所以它一定落在签到之后；回读的账户页则可能被限流、命中缓存，甚至直接失败。
 *
 * 解析不成流量的值一律丢掉：宁可显示「—」，也不把一个像流量的字符串当真数字。
 */
export function remainFromCheckin(json) {
  const v = json?.trafficInfo?.unUsedTraffic;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const text = typeof v === 'string' ? v.trim() : '';
  return text !== '' && parseTraffic(text) != null ? text : null;
}

/**
 * 成功签到的那一句话。
 *
 * 两个数字都要塞进 message：概览「最近执行」、执行历史、任务页副标题都只渲染
 * message，不渲染 view 行——只写「签到成功」等于最常被看到的那一屏什么都没说。
 * 拿不到的数字直接省略，不编一个出来。
 */
export function successMessage({ gain, remain } = {}) {
  const parts = [];
  if (Number.isFinite(gain) && gain > 0) parts.push(`获得了 ${formatBytes(gain)} 流量`);
  if (remain != null && remain !== '') parts.push(`剩余 ${formatBytes(remain)}`);
  return parts.length ? `签到成功，${parts.join('，')}` : '签到成功';
}

async function browserState(page, signal, operation) {
  signal.throwIfAborted();
  try {
    await operation('wait_ready', () => page.waitForFunction(() =>
      (location.pathname.startsWith('/user') && (document.querySelector('#checkin') || /今日已签到/.test(document.body.innerText))) ||
      (location.pathname === '/auth/login' && document.querySelector('#login') && document.querySelector('#passwd')),
    null, { timeout: 35_000 }));
  } catch {
    signal.throwIfAborted();
    return null;
  }
  signal.throwIfAborted();
  return new URL(page.url()).pathname.startsWith('/user') ? 'user' : 'login';
}

async function browserJson(response) {
  const headers = await response.allHeaders();
  if (headers['cf-mitigated'] === 'challenge') return { challenge: true, httpStatus: response.status() };
  let json;
  try { json = await response.json(); } catch {}
  return { json, httpStatus: response.status() };
}

function browserResponse(path) {
  return (response) => {
    const url = new URL(response.url());
    return url.origin === BASE && url.pathname === path && response.request().method() === 'POST';
  };
}

/**
 * 表单步骤之间的固定停顿（毫秒）。
 *
 * 为什么要有：2026-11-09 的执行日志里，填邮箱 50ms、填密码 22ms、点登录 82ms —— 一整串
 * 操作挤在几十毫秒内，这不是人手的速度。这里只做「把间隔拉开」这一件事，用固定值而不是
 * 随机值、不模拟鼠标轨迹或逐字符输入：随机化与行为合成是为了骗过行为检测，不在这个任务的范围内。
 *
 * 四个停顿时长按「人看页面 → 填两项 → 确认」的粗略节奏取，总和约 3.2 秒（签到前再加 1.5 秒），
 * 相对 180 秒的执行预算可以忽略；全部响应取消信号，退出时不会卡住。
 */
export const STEP_PAUSE_MS = Object.freeze({
  beforeFill: 1_200,
  betweenFields: 900,
  beforeSubmit: 1_100,
  beforeCheckin: 1_500,
});

/** 可取消的停顿：取消时立即结束，不会让退出等待整个间隔。 */
export async function pauseFor(signal, ms) {
  signal.throwIfAborted();
  if (!(ms > 0)) return;
  await new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('任务已取消'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runBrowser({ browser, secrets, signal, log, pause = (ms) => pauseFor(signal, ms) }) {
  const page = browser.page;
  const diagnostics = browser.diagnostics;
  let stage = '打开登录页';
  let failure = { reason: 'page_not_ready' };
  let checkinSubmitted = false;
  const operation = (op, fn, attempt) => diagnostics ? diagnostics.operation(stage, op, fn, attempt) : fn();
  const ready = async () => {
    const state = await browserState(page, signal, operation);
    if (!state) failure = await diagnostics?.snapshot(stage) ?? { reason: 'page_not_ready' };
    return state;
  };
  const jsonResponse = async (pending, op) => {
    const response = await operation(op, async () => browserJson(await pending));
    diagnostics?.record({ event: 'response', stage, op, httpStatus: response.httpStatus,
      challenge: response.challenge === true, jsonParsed: !!response.json, retOk: response.json?.ret === 1 });
    if (response.challenge || !response.json) failure = { reason: response.challenge ? 'cf_challenge' : 'json_decode_failed' };
    return response;
  };
  const blocked = (stage, httpStatus = failure.httpStatus) => ({
    status: 'blocked',
    message: `${stage}${failure.reason === 'cf_challenge' ? '遇到 Cloudflare 挑战且未通过' : failure.reason === 'json_decode_failed' ? '响应不是有效 JSON' : '页面未就绪'}，本轮停止`,
    data: { transport: 'browser', stage, reason: failure.reason, checkinSubmitted, ...(httpStatus ? { httpStatus } : {}) },
  });
  try {
    signal.throwIfAborted();
    if (page.url() !== `${BASE}/auth/login`) await operation('open_login', () => page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' }));
    if (!await ready()) {
      signal.throwIfAborted();
      await operation('reload_login', () => page.reload({ waitUntil: 'domcontentloaded' }));
      if (!await ready()) return blocked(stage);
    }
    stage = '访问账户页';
    signal.throwIfAborted();
    await operation('open_user', () => page.goto(`${BASE}/user`, { waitUntil: 'domcontentloaded' }));
    let state = await ready();
    if (!state) return blocked(stage);
    if (state === 'login') {
      for (let attempt = 0; attempt < 2; attempt++) {
        stage = '登录';
        signal.throwIfAborted();
        await operation('pause_before_fill', () => pause(STEP_PAUSE_MS.beforeFill), attempt + 1);
        await operation('fill_email', () => page.locator('#email').fill(secrets.V2FREE_EMAIL), attempt + 1);
        await operation('pause_between_fields', () => pause(STEP_PAUSE_MS.betweenFields), attempt + 1);
        await operation('fill_password', () => page.locator('#passwd').fill(secrets.V2FREE_PASSWORD), attempt + 1);
        signal.throwIfAborted();
        await operation('pause_before_submit', () => pause(STEP_PAUSE_MS.beforeSubmit), attempt + 1);
        const pending = page.waitForResponse(browserResponse('/auth/login'), { timeout: 30_000 });
        pending.catch(() => {});
        await operation('click_login', () => page.locator('#login').click(), attempt + 1);
        const response = await jsonResponse(pending, 'login_response');
        log(`浏览器登录响应 HTTP ${response.httpStatus}`);
        if (response.challenge) {
          if (attempt > 0) return blocked(stage, response.httpStatus);
          signal.throwIfAborted();
          await operation('reload_login', () => page.reload({ waitUntil: 'domcontentloaded' }));
          state = await ready();
          if (!state) return blocked(stage, response.httpStatus);
          if (state === 'user') break;
          continue;
        }
        if (!response.json) return blocked(stage, response.httpStatus);
        if (response.json.ret !== 1) return { status: 'failed', message: '浏览器登录未成功，请检查账号或站点提示', data: { transport: 'browser' } };
        stage = '等待登录跳转';
        await operation('login_redirect', () => page.waitForURL(`${BASE}/user**`, { waitUntil: 'domcontentloaded', timeout: 35_000 }));
        if (await ready() !== 'user') return blocked(stage);
        break;
      }
      log('浏览器登录成功');
    } else {
      log('浏览器登录态有效');
    }
    signal.throwIfAborted();
    const beforeHtml = await page.content();
    const info = parseSessionData(beforeHtml);
    const lastCheckin = parseLastCheckin(beforeHtml);
    if (hasSignedToday(beforeHtml)) return {
      status: 'already-signed', message: `今日已签到（上次签到 ${lastCheckin ?? '未知'}），未重复请求签到接口`,
      data: { ...info, lastCheckin, transport: 'browser' },
    };
    stage = '签到';
    signal.throwIfAborted();
    const pending = page.waitForResponse(browserResponse('/user/checkin'), { timeout: 30_000 });
    pending.catch(() => {});
    await operation('pause_before_checkin', () => pause(STEP_PAUSE_MS.beforeCheckin));
    await operation('click_checkin', () => page.locator('#checkin').click());
    checkinSubmitted = true;
    const response = await jsonResponse(pending, 'checkin_response');
    log(`浏览器签到响应 HTTP ${response.httpStatus}`);
    if (response.challenge || !response.json) return blocked(stage, response.httpStatus);
    const json = response.json;
    if (json.ret !== 1) return {
      status: /已经签到|已签到/.test(json.msg ?? '') ? 'already-signed' : 'failed',
      message: /已经签到|已签到/.test(json.msg ?? '') ? '今日已签到' : '签到未成功，本轮不重试',
      data: { ...info, lastCheckin, transport: 'browser' },
    };
    const fromCheckin = remainFromCheckin(json);
    let latest = info;
    let lastAfter = null;
    stage = '回读账户页';
    try {
      signal.throwIfAborted();
      await operation('reload_account', () => page.reload({ waitUntil: 'domcontentloaded' }));
      if (await ready() === 'user') {
        const html = await operation('readback', () => page.content());
        latest = parseSessionData(html) ?? info;
        lastAfter = parseLastCheckin(html);
      } else {
        diagnostics?.record({ event: 'operation_failed', stage, op: 'readback', reason: 'readback_not_user' });
      }
    } catch {
      await diagnostics?.snapshot(stage);
    }
    const remain = fromCheckin ?? latest?.remainTraffic;
    const gain = gainedTraffic({ msg: json.msg, before: info?.remainTraffic, after: latest?.remainTraffic });
    return {
      status: 'success', message: successMessage({ gain, remain }),
      data: { ...latest, ...(remain != null ? { remainTraffic: remain } : {}),
        ...(gain ? { gainedTraffic: gain } : {}), lastCheckin: lastAfter ?? lastCheckin, transport: 'browser' },
    };
  } catch {
    await diagnostics?.snapshot(stage);
    return signal.aborted ? { status: 'network-error', message: '浏览器任务已取消' } :
      { status: 'network-error', message: `${stage}浏览器操作失败，未自动重试`, data: { transport: 'browser', stage, checkinSubmitted } };
  }
}

export default {
  name: 'v2free-checkin',
  browser: true,
  displayName: 'v2free 机场每日签到',
  description: '登录 v2free 领取当日免费流量',
  group: '签到',
  tags: ['签到', '机场'],
  requires: ['V2FREE_EMAIL', 'V2FREE_PASSWORD'],

  /** 允许一个人配多个 v2free 账号，各自独立签到 */
  accounts: true,

  /**
   * 账号按「站点」归属：一个 v2free 账号在「账号」页存一次，可以被多个 v2free
   * 任务引用（比如以后加的「v2free 流量查询」）。不写这一行就会退回「一个模板一个
   * 组」，换密码时每个任务都要改一遍。
   */
  credentialGroup: 'v2free',

  /**
   * 账号页「站点」下拉里显示的名字。
   * 不写会退回模板名「v2free 机场每日签到」——那个位置填的是站点账号，
   * 不是某个具体任务，带上「每日签到」会让人以为账号只服务于签到。
   */
  credentialGroupLabel: 'v2free 机场',

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
  async run({ secrets, log, request = defaultRequest, browser, signal, pause }) {
    if (browser) return runBrowser({ secrets, log, browser, signal, pause });
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
    let lastCheckinAfter = null;
    try {
      const after = await request(`${BASE}/user`, { jar, headers: { Referer: `${BASE}/user` } });
      const afterHtml = await after.text();
      latest = parseSessionData(afterHtml) ?? info;
      lastCheckinAfter = parseLastCheckin(afterHtml);
    } catch {
      /* 回读失败不影响签到结论：签到接口自己带着剩余流量，见下 */
    }

    /*
     * 剩余流量优先取签到接口的 trafficInfo.unUsedTraffic —— 站点前端签到成功后
     * 就是拿它刷新页面上的「剩余」，所以它一定落在签到之后；
     * 回读的页面拿不到有效值时，自然退回回读值，再退回签到前的值。
     */
    const fromCheckin = remainFromCheckin(checkJson);
    const data = {
      ...latest,
      ...(fromCheckin != null ? { remainTraffic: fromCheckin } : null),
      // 签到成功后页面上的「上次签到」已经翻成今天；沿用签到前那一份会让这行停在昨天
      lastCheckin: lastCheckinAfter ?? lastCheckin,
    };

    if (checkJson.ret === 1) {
      // 只有真的签到成功才有「本次获得」；其余分支留空，界面显示「—」。
      // 差值仍用回读页面的数字（与签到前同源），不拿接口值去和页面值相减。
      const gain = gainedTraffic({
        msg: checkJson.msg,
        before: info?.remainTraffic,
        after: latest?.remainTraffic,
      });
      return {
        status: 'success',
        message: successMessage({ gain, remain: data.remainTraffic }),
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
