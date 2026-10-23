/**
 * 最小 HTTP 能力：CookieJar + fetch 封装（零依赖）
 *
 * Node 原生 fetch 不维护 Cookie，故自行实现：只需覆盖同名 cookie 的 Map。
 *
 * 三类「看起来像机器」的特征在这一层统一处理，任务作者不需要知道：
 *   · **UA**：全站一个固定值会让目标站把不同账号看成同一个人。createRequester
 *     按 seed 选一个固定 UA —— 同一账号永远同一个（每次换浏览器才不正常），
 *     不同账号互不相同。
 *   · **附带请求头**：Node 的 fetch 只发 UA + Cookie，连 Accept 都不发。真实的
 *     Chrome 会带 8~10 个头，缺了它们比 UA 固定更容易被设备指纹识别。
 *   · **节奏**：同一域名连续请求至少间隔 1~3 秒。「4 个请求 2 秒打完」是自动化
 *     最容易被识别的特征，真实用户点完登录不会在 200ms 内点签到。
 */
import crypto from 'node:crypto';

/** 兜底 UA：没有 seed 的调用（旧路径、手动脚本）仍用它 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 常见桌面浏览器 UA 池。
 *
 * 只收真实存在过的版本组合——编一个不存在的版本号（比如 Chrome/999）比固定 UA
 * 更容易被识别。Chrome 占多数是刻意的：真实用户里 Chrome 就是过半，
 * 池子该像人群，而不是像抽奖箱。
 *
 * 8 个而不是 3~5 个：3 个账号全撞到同一个 UA 的概率从 4% 降到 1.5% 左右。
 */
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
];

/**
 * 按 seed 选 UA。同一 seed 恒定 —— 这是幂等要求，不是偷懒：
 * 同一账号昨天 Chrome/131 今天 Firefox/132，比固定 UA 更像机器。
 */
export function userAgentFor(seed) {
  if (!seed) return DEFAULT_UA;
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  return UA_POOL[digest[0] % UA_POOL.length];
}

/* ───────────────────── 浏览器附带请求头 ───────────────────── */

/** 大小写不敏感地取 header（任务里可能写 'referer'，也可能写 'Referer'） */
function headerOf(headers, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * 从 UA 推断浏览器家族、版本与平台。
 *
 * 为什么要推断：附加头必须与 UA **自洽**。Safari 从不发 sec-ch-ua，
 * 一个自称 Safari 却带着 Chrome Client Hints 的请求，比不带更可疑。
 */
function browserProfile(ua) {
  const v = (re) => re.exec(ua)?.[1]?.split('.')[0] ?? '';
  const platform = /Windows/.test(ua) ? 'Windows' : 'macOS';
  if (ua.includes('Firefox/')) return { family: 'firefox', version: v(/Firefox\/([\d.]+)/), platform };
  if (ua.includes('Edg/')) return { family: 'edge', version: v(/Edg\/([\d.]+)/), platform };
  if (ua.includes('Chrome/')) return { family: 'chrome', version: v(/Chrome\/([\d.]+)/), platform };
  return { family: 'safari', version: v(/Version\/([\d.]+)/), platform };
}

/** Chrome / Edge 专有的 Client Hints；Safari 与 Firefox 一个都不发 */
function clientHints({ family, version, platform }) {
  if (family === 'safari' || family === 'firefox') return {};
  const brands =
    family === 'edge'
      ? `"Microsoft Edge";v="${version}", "Chromium";v="${version}", "Not_A Brand";v="24"`
      : `"Chromium";v="${version}", "Not_A Brand";v="24", "Google Chrome";v="${version}"`;
  return {
    'sec-ch-ua': brands,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform}"`,
  };
}

/** 地址栏导航（Chrome 131 的真实 Accept） */
const NAV_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
  'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
/** axios / fetch 发 JSON 时的默认值 */
const JSON_ACCEPT = 'application/json, text/plain, */*';
/** XMLHttpRequest 的默认值（jQuery ajax 也是它） */
const ANY_ACCEPT = '*/*';
/** 中文用户的实际值，与「深圳家宽」的地理位置一致 */
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

/**
 * Sec-Fetch-Site 由「Referer 与目标是否同源」推导。
 * none 只出现在地址栏直接输入，XHR 一定有来源，所以 XHR 缺 Referer 时按同源处理。
 */
function fetchSite(url, referer, kind) {
  if (!referer) return kind === 'navigate' ? 'none' : 'same-origin';
  try {
    return new URL(referer).host === new URL(url).host ? 'same-origin' : 'cross-site';
  } catch {
    return kind === 'navigate' ? 'none' : 'same-origin';
  }
}

/**
 * 生成「真实浏览器会发、而 Node fetch 默认不发」的请求头。
 *
 * 三条原则，缺一条就会帮倒忙：
 *   1. 必须与 UA 自洽（Safari 不发 sec-ch-ua；Windows 不发 macOS 平台）
 *   2. 只发浏览器真会发的头 —— 发明一个 no-such-header 只是自我安慰
 *   3. 任务显式传的 header 一律优先（见 request 里的展开顺序）
 *
 * 刻意**不发** zstd：Chrome 123+ 确实会带，但 Node 20 的 undici 解不了，
 * 服务器真按 zstd 返回时拿到的是乱码——省一个头换一次全站失败，不值得。
 */
function browserHeaders({ url, headers, ua }) {
  const xrw = headerOf(headers, 'x-requested-with');
  const contentType = String(headerOf(headers, 'content-type') ?? '');

  // 三类请求的头集不同：打开页面 / XHR / JSON API
  let kind = 'navigate';
  if (xrw) kind = 'xhr';
  else if (contentType.includes('application/json')) kind = 'json';

  const out = {
    Accept: kind === 'json' ? JSON_ACCEPT : kind === 'xhr' ? ANY_ACCEPT : NAV_ACCEPT,
    'Accept-Language': ACCEPT_LANGUAGE,
    'Accept-Encoding': 'gzip, deflate, br',
    ...clientHints(browserProfile(ua)),
    'Sec-Fetch-Site': fetchSite(url, headerOf(headers, 'referer'), kind),
  };

  if (kind === 'navigate') {
    out['Upgrade-Insecure-Requests'] = '1';
    out['Sec-Fetch-Dest'] = 'document';
    out['Sec-Fetch-Mode'] = 'navigate';
    out['Sec-Fetch-User'] = '?1';
  } else {
    // XHR 与 fetch 一律是 empty + cors，无论同域还是跨域
    out['Sec-Fetch-Dest'] = 'empty';
    out['Sec-Fetch-Mode'] = 'cors';
  }

  return out;
}

/** 同一域名两次请求的最小间隔基数 */
const DOMAIN_MIN_GAP_MS = 1_000;
/** 在基数之上再随机加 0~2 秒，避免所有间隔整齐地等于 1 秒 */
const DOMAIN_GAP_JITTER_MS = 2_000;
/** 等待上限：多任务撞车时不能无限排队，否则任务会撞上自己的 timeoutMs */
const MAX_THROTTLE_WAIT_MS = 8_000;

/** host → 该域名「下一个可用时刻」 */
const domainReadyAt = new Map();

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * 同一域名的请求节流。
 *
 * 放在 request 内部而不是各任务里 sleep，有两个理由：
 *   · 新加的任务自动获得保护，不依赖作者记得加
 *   · 闸门作用在**域名**维度，也就是目标站实际看到的那一层；多个账号同时到点时
 *     自然被拉开，而不是靠调度器的 30 秒 tick 兜底
 *
 * 先占位再等待：否则两个并发请求会读到同一个「上次时间」并同时放行。
 */
async function throttleDomain(host, random = Math.random) {
  if (!host) return;
  const nowMs = Date.now();
  const gap = DOMAIN_MIN_GAP_MS + Math.floor(random() * DOMAIN_GAP_JITTER_MS);
  const readyAt = Math.max(nowMs, (domainReadyAt.get(host) ?? 0) + gap);
  // 队列已经排到很远时不再往后加码，否则一次撞车会让后续请求越排越久
  const capped = Math.min(readyAt, nowMs + MAX_THROTTLE_WAIT_MS);

  domainReadyAt.set(host, capped);
  const wait = capped - nowMs;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** 仅供测试：清空域名节流状态，避免用例之间互相等待 */
export function resetDomainThrottle() {
  domainReadyAt.clear();
}

export class CookieJar {
  #store = new Map();

  /** 吸收响应中的 Set-Cookie（同名覆盖） */
  absorb(res) {
    const list = res.headers.getSetCookie?.() ?? [];
    for (const raw of list) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.#store.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return this;
  }

  get(name) {
    return this.#store.get(name);
  }

  get size() {
    return this.#store.size;
  }

  clear() {
    this.#store.clear();
  }

  header() {
    return [...this.#store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  toJSON() {
    return Object.fromEntries(this.#store);
  }

  static fromJSON(obj) {
    const jar = new CookieJar();
    for (const [k, v] of Object.entries(obj ?? {})) jar.#store.set(k, v);
    return jar;
  }
}

/**
 * 发起请求，自动带上 jar 中的 Cookie 并吸收新 Cookie
 * @param {string} url
 * @param {{jar?: CookieJar, method?: string, headers?: Record<string,string>, body?: any,
 *          timeout?: number, ua?: string, throttle?: boolean, impersonate?: boolean}} opts
 *   `ua` 由 createRequester 注入；`throttle:false` 仅供测试跳过节流等待；
 *   `impersonate:false` 关掉浏览器附带头（调试目标站原始响应时用）
 */
export async function request(url, opts = {}) {
  const {
    jar,
    method = 'GET',
    headers = {},
    body,
    timeout = 30_000,
    ua = DEFAULT_UA,
    throttle = true,
    impersonate = true,
  } = opts;

  // 节流必须在创建 AbortController 之前：排队等待不该消耗这次请求的超时预算
  if (throttle) await throttleDomain(hostOf(url));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);

  try {
    /*
     * 展开顺序即优先级：浏览器默认头 < UA < 调用方显式 header < Cookie。
     * UA 取调用方显式值优先，否则 browserHeaders 会按另一个 UA 生成
     * sec-ch-ua，出现「自称 Safari 却带 Chrome Client Hints」的自相矛盾。
     */
    const effectiveUa = headerOf(headers, 'user-agent') ?? ua;
    const finalHeaders = {
      ...(impersonate ? browserHeaders({ url, headers, ua: effectiveUa }) : {}),
      'User-Agent': effectiveUa,
      ...headers,
    };
    const cookieHeader = jar?.header();
    if (cookieHeader) finalHeaders.Cookie = cookieHeader;

    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body,
      redirect: 'manual',
      signal: ac.signal,
    });
    jar?.absorb(res);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 绑定「这次执行是谁」的 request。
 *
 * 任务拿到的 ctx.request 就是这个：同一账号的 UA 始终一致，不同账号不同。
 * 域名节流是模块级的，所有 requester 共用同一张时间表 —— 这正是需要的，
 * 闸门要作用在「目标站看到的出口」上，而不是每个账号各算各的。
 */
export function createRequester({ seed } = {}) {
  const ua = userAgentFor(seed);
  return (url, opts = {}) => request(url, { ...opts, ua });
}

/** 读取响应体并尽力解析为 JSON */
export async function readJson(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text, ok: true };
  } catch {
    return { json: null, text, ok: false };
  }
}
