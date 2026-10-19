#!/usr/bin/env node
/**
 * WeAuto —— WorkBuddy 签到接口探针（一次性验证脚本，不进任务注册表）
 *
 * 正式写 tasks/ 之前，用真实凭据确认四件事：
 *   1. API host 到底是哪个（网文口径互相打架：www.codebuddy.cn / copilot.tencent.com / tencent.sso.codebuddy.cn）
 *   2. 鉴权头的完整组合（Authorization 够不够？要不要 X-User-Id / X-Domain）
 *   3. 响应结构（是否双层 {code,data}；成功与「今日已签」分别是什么 code）
 *   4. refresh_token 能否续期（决定任务要不要做凭据回写）
 *
 * 【默认只读】只调状态查询接口。真的领取积分必须显式加 --claim。
 * 【不打印凭据】token 一律 mask；dump 文件里不写入任何凭据原文。
 *
 * 【两种鉴权都支持】桌面客户端用 `Authorization: Bearer`，网页端很可能用 `Cookie`。
 *   两者任选其一提供即可，也可以同时给（脚本会把它们一起带上）。
 *
 * 用法：
 *   node scripts/probe-workbuddy.mjs --token-file ~/.ssh/wb_token.txt
 *   node scripts/probe-workbuddy.mjs --cookie-file ~/.ssh/wb_cookie.txt
 *   WB_ACCESS_TOKEN=eyJ... node scripts/probe-workbuddy.mjs
 *   WB_ACCESS_TOKEN=eyJ... WB_REFRESH_TOKEN=eyJ... node scripts/probe-workbuddy.mjs --claim
 * 选项：
 *   --token-file <path>   从文件读 accessToken（推荐，避免进 shell 历史）
 *   --cookie-file <path>  从文件读 Cookie 串（网页端鉴权）
 *   --refresh-file <path> 从文件读 refreshToken
 *   --host <url>          只测指定 host，可重复
 *   --claim               真正执行签到（默认只查询）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 20_000;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 候选 API host（按网文出现频率排序，逐个实测） */
const DEFAULT_HOSTS = [
  'https://www.codebuddy.cn',
  'https://copilot.tencent.com',
  'https://tencent.sso.codebuddy.cn',
];

const STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';

/* ───────────────────────── 参数与凭据 ───────────────────────── */

function parseArgs(argv) {
  const out = { hosts: [], claim: false, tokenFile: null, refreshFile: null, cookieFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claim') out.claim = true;
    else if (a === '--host') out.hosts.push(argv[++i]);
    else if (a === '--token-file') out.tokenFile = argv[++i];
    else if (a === '--cookie-file') out.cookieFile = argv[++i];
    else if (a === '--refresh-file') out.refreshFile = argv[++i];
  }
  return out;
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return {};
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

function readFileArg(p) {
  if (!p) return '';
  return fs.readFileSync(p.replace(/^~/, process.env.HOME ?? ''), 'utf8').trim();
}

const mask = (v) =>
  !v ? '(空)' : v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 6)}…${v.slice(-4)} (len=${v.length})`;

function rule(title) {
  console.log('\n' + '━'.repeat(70));
  console.log('▌ ' + title);
  console.log('━'.repeat(70));
}

/** 只看 payload 的几个字段，不回显 token 本身 */
function decodeJwt(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const ts = (sec) =>
  Number.isFinite(sec) ? new Date(sec * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '(无)';

/* ───────────────────────── 请求 ───────────────────────── */

async function post(url, { headers = {}, body = '{}' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...headers },
      body,
      redirect: 'manual',
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, text, ms: Date.now() - started, location: res.headers.get('location') };
  } catch (err) {
    return { status: 0, error: err.message, text: '', json: null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function summarize(r) {
  if (r.error) return `✗ 请求失败：${r.error}`;
  if (r.json) return JSON.stringify(r.json).slice(0, 400);
  return `非 JSON → ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`;
}

/** 双层结构的 code：兼容 {code} 与 {data:{code}} */
function codeOf(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.code !== undefined) return json.code;
  if (json.data && typeof json.data === 'object' && json.data.code !== undefined) return json.data.code;
  return null;
}

/* ───────────────────────── 主流程 ───────────────────────── */

const args = parseArgs(process.argv.slice(2));
const env = loadDotEnv(path.join(ROOT, '.env.local'));

const token =
  readFileArg(args.tokenFile) || process.env.WB_ACCESS_TOKEN || env.WB_ACCESS_TOKEN || '';
const cookie =
  readFileArg(args.cookieFile) || process.env.WB_COOKIE || env.WB_COOKIE || '';
const refreshToken =
  readFileArg(args.refreshFile) || process.env.WB_REFRESH_TOKEN || env.WB_REFRESH_TOKEN || '';
const envUserId = process.env.WB_USER_ID || env.WB_USER_ID || '';

if (!token && !cookie) {
  console.error('✗ 缺少凭据：--token-file（客户端 Bearer）与 --cookie-file（网页端 Cookie）至少给一个');
  process.exit(2);
}

/**
 * 基础鉴权头。空值项一律剔除，这样「头矩阵」才能测出到底哪一个是必需的，
 * 而不是因为带了个空头导致结论不可信。
 */
const baseAuth = {
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(cookie ? { Cookie: cookie } : {}),
};
function auth(extra = {}) {
  const h = { ...baseAuth, ...extra };
  for (const k of Object.keys(h)) if (h[k] === '' || h[k] == null) delete h[k];
  return h;
}

const hosts = args.hosts.length ? args.hosts : DEFAULT_HOSTS;

rule('0. 凭据');
console.log('  accessToken :', token ? mask(token) : '(未提供)');
console.log('  cookie      :', cookie ? mask(cookie) : '(未提供)');
console.log('  鉴权模式    :', token && cookie ? 'Bearer + Cookie 同时携带' : token ? 'Bearer' : 'Cookie');
console.log('  refreshToken:', refreshToken ? mask(refreshToken) : '(未提供 → 跳过续期探测)');
const jwt = decodeJwt(token);
if (jwt) {
  console.log('  JWT iss     :', jwt.iss ?? '(无)');
  console.log('  JWT azp     :', jwt.azp ?? jwt.client_id ?? '(无)');
  console.log('  JWT sub(uid):', jwt.sub ?? '(无)');
  console.log('  JWT exp     :', ts(jwt.exp), '（北京时间）');
} else {
  console.log('  ⚠️ 不是合法 JWT —— 确认复制的是完整 token（通常以 eyJ 开头）');
}
const userId = envUserId || jwt?.sub || '';
console.log('  X-User-Id   :', userId || '(无法推断，将在头矩阵中测试是否需要)');

/* ── 1. host 探测（只读） ── */
rule('1. host 探测 —— POST ' + STATUS_PATH);
const results = [];
for (const host of hosts) {
  const r = await post(host + STATUS_PATH, { headers: auth({ 'X-User-Id': userId }) });
  const code = codeOf(r.json);
  console.log(`\n  [${host}]`);
  console.log('    status  :', r.status || '(网络失败)', `${r.ms}ms`, r.location ? `→ ${r.location}` : '');
  console.log('    code    :', code ?? '(无)');
  console.log('    body    :', summarize(r));
  results.push({ host, r, code });
}

const ok = results.filter((x) => x.r.status === 200 && x.r.json);
if (!ok.length) {
  rule('诊断');
  const netFail = results.every((x) => x.r.error);
  if (netFail) console.log('  所有 host 网络不可达 → 检查网络/代理，或 host 已变更');
  else console.log('  没有 host 返回 200 JSON → 可能是鉴权失败(401/403)或路径已变，详见上面 body');
  console.log('\n  未找到可用 host，后续步骤跳过。');
  process.exit(1);
}
const winner = ok[0];
console.log('\n  ══> 可用 host:', winner.host);

/* ── 2. 鉴权头矩阵：确认哪些头是必需的 ── */
rule('2. 鉴权头矩阵（在 ' + winner.host + ' 上）');
const combos = [
  ['仅鉴权头', {}],
  ['+ X-User-Id', { 'X-User-Id': userId }],
  ['+ X-Domain', { 'X-Domain': 'www.codebuddy.cn' }],
  ['三者齐全', { 'X-User-Id': userId, 'X-Domain': 'www.codebuddy.cn' }],
].map(([label, extra]) => [label, auth(extra)]);
const matrix = [];
for (const [label, headers] of combos) {
  if (label.includes('X-User-Id') && !userId) {
    console.log(`\n  [${label}] 跳过（无 uid）`);
    continue;
  }
  const r = await post(winner.host + STATUS_PATH, { headers });
  console.log(`\n  [${label}]`);
  console.log('    status  :', r.status || '(网络失败)', `code=${codeOf(r.json) ?? '(无)'}`);
  if (r.status !== 200) console.log('    body    :', summarize(r));
  matrix.push({ label, status: r.status, code: codeOf(r.json) });
}
const working = matrix.find((m) => m.status === 200 && (m.code === 0 || m.code === undefined || m.code === 10001));
console.log('\n  ══> 最小可用头组合:', working ? working.label : '(未确认，见上面各组合的 status)');

/* ── 3. refresh 续期探测 ── */
if (refreshToken) {
  rule('3. refresh 续期探测 —— POST ' + REFRESH_PATH);
  const domainHost = winner.host.replace(/^https?:\/\//, '');
  const r = await post(winner.host + REFRESH_PATH, {
    headers: {
      'X-Refresh-Token': refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': domainHost,
    },
  });
  console.log('  status  :', r.status || '(网络失败)', `${r.ms}ms`);
  console.log('  body    :', summarize(r));
  const data = r.json?.data ?? r.json ?? {};
  console.log('\n  新 accessToken :', data.accessToken ? mask(data.accessToken) : '(未返回)');
  console.log('  新 refreshToken:', data.refreshToken ? mask(data.refreshToken) : '(未返回)');
  console.log('  是否发生轮换  :', data.refreshToken && data.refreshToken !== refreshToken ? '✅ 是（必须回写）' : '否');
  if (r.status === 200 && data.refreshToken) {
    console.log('\n  ══> 续期可用 → 任务需实现凭据回写，否则下次运行用的是已作废的旧 token');
  }
} else {
  rule('3. refresh 续期探测（跳过）');
  console.log('  未提供 refreshToken。');
  console.log('  若只能拿到 accessToken，则任务必须按 30 天有效期设计：到期前提醒用户重填。');
}

/* ── 4. 签到（默认不执行） ── */
if (!args.claim) {
  rule('4. 签到（已跳过）');
  console.log('  默认只读。加 --claim 才会真的领取积分。');
} else {
  rule('4. 签到 —— POST ' + CHECKIN_PATH);
  const r = await post(winner.host + CHECKIN_PATH, { headers: auth({ 'X-User-Id': userId }) });
  console.log('  status  :', r.status || '(网络失败)', `${r.ms}ms`);
  console.log('  code    :', codeOf(r.json) ?? '(无)');
  console.log('  body    :', summarize(r));
  const c = codeOf(r.json);
  if (c === 0) console.log('\n  ══> 签到成功');
  else if (c === 10001) console.log('\n  ══> 今日已签到（幂等分支，映射到 already-signed）');
  else console.log('\n  ══> 未识别的 code，需要按实际响应补充分支');
}

/* ── 5. dump（不含凭据） ── */
rule('5. 保存探测结果');
const dumpPath = path.join(ROOT, 'data', 'probe-workbuddy.json');
fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
fs.writeFileSync(
  dumpPath,
  JSON.stringify(
    {
      probedAt: new Date().toISOString(),
      jwt: jwt ? { iss: jwt.iss, azp: jwt.azp, exp: jwt.exp } : null,
      hosts: results.map(({ host, r, code }) => ({
        host,
        status: r.status,
        code,
        json: r.json ?? null,
        error: r.error ?? null,
      })),
      headerMatrix: matrix,
    },
    null,
    2,
  ),
);
console.log('  已保存:', path.relative(ROOT, dumpPath), '（data/ 已 gitignore，不含 token 原文）');

rule('探针完成');
console.log('  请把以上完整输出反馈给 Agent，用以确定 tasks/ 里的实现细节。\n');
