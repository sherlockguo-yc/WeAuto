#!/usr/bin/env node
/**
 * WeAuto —— v2free 接口探针（一次性验证脚本）
 *
 * 目的：正式实现前，用真实凭据确认三件事
 *   1. POST /auth/login 的参数与返回（含是否开启 2FA）
 *   2. POST /user/checkin 的返回格式与状态码（含是否需要 CSRF）
 *   3. Set-Cookie 属性（Session 有效期，决定重登频率）
 *
 * 注意：会真实执行登录与签到，不是 dry-run。
 * 用法：npm run probe
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://v2free.net';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30_000;

/* ───────────────────────── 小工具 ───────────────────────── */

function loadEnv(file) {
  if (!fs.existsSync(file)) return null;
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const mask = (v) =>
  !v
    ? '(空)'
    : v.length <= 4
      ? '*'.repeat(v.length)
      : v.slice(0, 2) + '*'.repeat(8) + v.slice(-2);

function rule(title) {
  console.log('\n' + '━'.repeat(66));
  console.log('▌ ' + title);
  console.log('━'.repeat(66));
}

function makeJar() {
  const store = new Map();
  return {
    absorb(list) {
      for (const raw of list) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        if (i > 0) store.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) {
      return store.get(name);
    },
  };
}

function showSetCookie(res, label) {
  const list = res.headers.getSetCookie?.() ?? [];
  if (!list.length) return console.log(`  ${label}: (无 Set-Cookie)`);
  for (const raw of list) {
    const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
    const [name, value = ''] = pair.split('=');
    console.log(`  ${label}: ${name}=${value.slice(0, 8)}…`);
    if (attrs.length) console.log(`    属性 → ${attrs.join('; ')}`);
  }
}

async function req(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ac.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = A.indexOf(ch);
    if (idx === -1) throw new Error(`非法的 base32 字符: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP（自研，避免引入 otplib 依赖） */
function totp(secret, { step = 30, digits = 6 } = {}) {
  const counter = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/* ───────────────────────── 主流程 ───────────────────────── */

const env = loadEnv(path.join(ROOT, '.env.local'));
if (!env) {
  console.error('✗ 找不到 .env.local');
  process.exit(2);
}
const EMAIL = env.V2FREE_EMAIL;
const PASSWD = env.V2FREE_PASSWORD;
const TOTP_SECRET = env.V2FREE_TOTP_SECRET || '';

if (!EMAIL || !PASSWD) {
  console.error('✗ .env.local 缺少 V2FREE_EMAIL 或 V2FREE_PASSWORD');
  process.exit(2);
}

rule('0. 凭据加载');
console.log('  email       :', EMAIL);
console.log('  password    :', mask(PASSWD));
console.log('  totp secret :', TOTP_SECRET ? mask(TOTP_SECRET) : '(未配置 → 登录不携带 code 字段)');

const jar = makeJar();
const jarHeaders = () => (jar.header() ? { Cookie: jar.header() } : {});

/* ── 1. 预热 ── */
rule('1. GET /auth/login （预热，获取初始 Session）');
const warm = await req(`${BASE}/auth/login`, { headers: { 'User-Agent': UA } });
console.log('  status      :', warm.status);
showSetCookie(warm, 'set-cookie');
jar.absorb(warm.headers.getSetCookie?.() ?? []);
await warm.text();

/* ── 2. 登录 ── */
rule('2. POST /auth/login');
const loginForm = new URLSearchParams({
  agree: '1',
  email: EMAIL,
  passwd: PASSWD,
  remember_me: 'on',
});
let totpUsed = null;
if (TOTP_SECRET) {
  totpUsed = totp(TOTP_SECRET);
  loginForm.set('code', totpUsed);
}

const t2 = Date.now();
const loginRes = await req(`${BASE}/auth/login`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': UA,
    Referer: `${BASE}/auth/login`,
    Origin: BASE,
    ...jarHeaders(),
  },
  body: loginForm,
});
console.log('  status      :', loginRes.status, `(${Date.now() - t2}ms)`);
console.log('  content-type:', loginRes.headers.get('content-type'));
if (totpUsed) console.log('  已携带 code :', totpUsed);
console.log('  location    :', loginRes.headers.get('location') ?? '(无)');
showSetCookie(loginRes, 'set-cookie');
jar.absorb(loginRes.headers.getSetCookie?.() ?? []);

const rawLogin = await loginRes.text();
let loginJson = null;
try {
  loginJson = JSON.parse(rawLogin);
} catch {
  /* 非 JSON */
}
if (loginJson) console.log('  body        :', JSON.stringify(loginJson));
else console.log('  body(前300) :', rawLogin.slice(0, 300).replace(/\s+/g, ' '));

const loggedIn = loginJson?.ret === 1;
console.log('\n  ══> 登录结论:', loggedIn ? '✅ 成功' : '❌ 失败');

if (!loggedIn) {
  rule('诊断');
  const msg = loginJson?.msg ?? '';
  if (/两步|验证|code|令牌/i.test(msg)) {
    console.log('  服务端提示与两步验证相关 → 账号【可能已开启 2FA】，需配置 V2FREE_TOTP_SECRET');
  } else if (/密码|password/i.test(msg)) {
    console.log('  服务端提示密码错误 → 请核对 .env.local 的 V2FREE_PASSWORD');
  } else {
    console.log('  服务端 msg =', msg || '(无法解析响应)');
  }
  console.log('\n  登录未通过，后续步骤无法验证。');
  process.exit(1);
}

/* ── 3. 验证会话 ── */
rule('3. GET /user （确认会话有效 + 提取页面签到状态）');
const t3 = Date.now();
const userRes = await req(`${BASE}/user`, {
  headers: { 'User-Agent': UA, Referer: `${BASE}/auth/login`, ...jarHeaders() },
});
const loc3 = userRes.headers.get('location');
console.log('  status      :', userRes.status, `(${Date.now() - t3}ms)`, loc3 ? `→ ${loc3}` : '');
const userHtml = await userRes.text();
console.log('  html 长度   :', userHtml.length);
if (userRes.status === 302) console.log('  ⚠️ 会话未被识别（被重定向回登录页）→ cookie 传递方式有误');

const btn = userHtml.match(/id="checkin"[^>]*>([\s\S]{0,60}?)</i);
console.log('  #checkin    :', btn ? btn[1].replace(/\s+/g, ' ').trim() : '(未找到 #checkin 元素)');
for (const kw of ['今日已签到', '上次签到']) {
  const i = userHtml.indexOf(kw);
  if (i >= 0) {
    const snippet = userHtml
      .slice(i, i + 160)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(`  含「${kw}」:`, snippet);
  }
}

/* 页面结构探索：为面板取数定位 DOM */
console.log('\n  ── 页面结构探索 ──');
const ci = userHtml.indexOf('/user/checkin');
console.log('  「/user/checkin」出现次数:', (userHtml.match(/\/user\/checkin/g) || []).length);
if (ci >= 0) {
  console.log(
    '    上下文 →',
    userHtml
      .slice(Math.max(0, ci - 300), ci + 180)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}
const flowIdx = [...userHtml.matchAll(/流量/g)].map((m) => m.index);
console.log('  「流量」出现次数:', flowIdx.length);
for (const i of flowIdx.slice(0, 6)) {
  console.log(
    '    →',
    userHtml
      .slice(Math.max(0, i - 130), i + 130)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}
const sizeHits = [...new Set([...userHtml.matchAll(/>\s*([\d.]+\s*(?:GB|MB|TB))\s*</gi)].map((m) => m[1]))];
console.log('  页面中的容量数值:', sizeHits.join(' | ') || '(未匹配到)');

/* 保存 HTML 供离线分析（data/ 已 gitignore） */
const dumpPath = path.join(ROOT, 'data', 'probe-user.html');
fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
fs.writeFileSync(dumpPath, userHtml);
console.log('  已保存页面  :', path.relative(ROOT, dumpPath));

/* ── 4. 签到 ── */
if (process.env.PROBE_SKIP_CHECKIN === '1') {
  rule('4. 签到（已跳过）');
  console.log('  PROBE_SKIP_CHECKIN=1 → 跳过签到请求，避免触发站点频率限制');
  rule('探针完成');
  process.exit(0);
}

rule('4. POST /user/checkin');
const t4 = Date.now();
const checkRes = await req(`${BASE}/user/checkin`, {
  method: 'POST',
  headers: {
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': UA,
    Referer: `${BASE}/user`,
    Origin: BASE,
    ...jarHeaders(),
  },
});
console.log('  status      :', checkRes.status, `(${Date.now() - t4}ms)`);
console.log('  content-type:', checkRes.headers.get('content-type'));
const rawCheck = await checkRes.text();
try {
  console.log('  body        :', JSON.stringify(JSON.parse(rawCheck)));
} catch {
  console.log('  body(前300) :', rawCheck.slice(0, 300).replace(/\s+/g, ' '));
}

if (checkRes.status === 419) {
  const xsrf = jar.get('XSRF-TOKEN');
  console.log('\n  ⚠️ 419 CSRF token mismatch');
  if (xsrf) {
    console.log('  检测到 XSRF-TOKEN cookie，按 Laravel 约定解码后用 X-XSRF-TOKEN 头重试…');
    const retry = await req(`${BASE}/user/checkin`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': decodeURIComponent(xsrf),
        'User-Agent': UA,
        Referer: `${BASE}/user`,
        Origin: BASE,
        ...jarHeaders(),
      },
    });
    console.log('  重试 status :', retry.status);
    const rawRetry = await retry.text();
    try {
      console.log('  重试 body   :', JSON.stringify(JSON.parse(rawRetry)));
    } catch {
      console.log('  重试 body   :', rawRetry.slice(0, 300).replace(/\s+/g, ' '));
    }
    if (retry.status === 200) {
      console.log('\n  ══> 结论：签到需要 X-XSRF-TOKEN 请求头（由 XSRF-TOKEN cookie 解码而来）');
    }
  } else {
    console.log('  未发现 XSRF-TOKEN cookie → 可能需要从页面 meta 标签读取 _token');
  }
}
if (checkRes.status === 405) console.log('  ⚠️ 405 → 接口路径或方法已变更');
if (checkRes.status === 302) console.log('  ⚠️ 302 → 会话失效被重定向（检查 cookie 传递）');

rule('探针完成');
console.log('  请把以上完整输出反馈给 Agent 以确定实现细节。\n');
