/**
 * 最小 HTTP 能力：CookieJar + fetch 封装（零依赖）
 *
 * Node 原生 fetch 不维护 Cookie，故自行实现：只需覆盖同名 cookie 的 Map。
 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
 * @param {{jar?: CookieJar, method?: string, headers?: Record<string,string>, body?: any, timeout?: number}} opts
 */
export async function request(url, opts = {}) {
  const { jar, method = 'GET', headers = {}, body, timeout = 30_000 } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);

  try {
    const finalHeaders = { 'User-Agent': DEFAULT_UA, ...headers };
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

/** 读取响应体并尽力解析为 JSON */
export async function readJson(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text, ok: true };
  } catch {
    return { json: null, text, ok: false };
  }
}
