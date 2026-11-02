#!/usr/bin/env node
/**
 * WeAuto —— WorkBuddy「派 Buddy 旅行」接口探针（一次性验证脚本，不进任务注册表）
 *
 * 正式上线 tasks/workbuddy-buddy-travel.mjs 之前，用真实凭据确认四件事：
 *   1. **前缀**到底是 /activity 还是 /v2/activity（网页端用前者、桌面客户端用后者）
 *   2. **鉴权头**：只有 Bearer 够不够？要不要 X-User-Id / X-Domain / Referer
 *   3. **响应结构**：state / arrive_at / daily_limit_reached / reward_credit 是否与
 *      前端映射函数 nt() 里读到的一致（见任务文件头部注释）
 *   4. **出错文案**：daily limit / already traveling 的真实 msg（模板靠它判幂等）
 *
 * 【默认只读】只调 status / config / records。真的派出或领取必须显式加
 *           --depart / --claim —— 旅行一天只能派一次，误触发会浪费用户当天的机会。
 * 【不打印凭据】token 一律 mask；dump 文件里不写入任何凭据原文。
 *
 * 用法：
 *   node scripts/probe-workbuddy-travel.mjs --from-weauto ~/weauto     # 从部署目录解密取 token
 *   node scripts/probe-workbuddy-travel.mjs --token-file ~/.ssh/wb.txt
 *   WB_ACCESS_TOKEN=eyJ... node scripts/probe-workbuddy-travel.mjs
 *   node scripts/probe-workbuddy-travel.mjs --from-weauto ~/weauto --depart --claim
 * 选项：
 *   --from-weauto <dir>  读 <dir>/data/weauto.db + master-key 解出 WB_ACCESS_TOKEN
 *   --token-file <path>  从文件读 accessToken（避免进 shell 历史）
 *   --prefix <path>      只测指定前缀，可重复（默认 /activity 与 /v2/activity 都测）
 *   --depart             真的派出（会消耗当日唯一一次机会）
 *   --claim              真的领取（有未领奖励时才有意义）
 *
 * 退出码：0 正常 / 1 没有可用前缀 / 2 参数或凭据缺失
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 20_000;
const BASE = 'https://www.workbuddy.cn';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 候选前缀：网页端 bundle 用第一个，桌面客户端 GrowthFacade 用第二个 */
const DEFAULT_PREFIXES = ['/activity/growth/buddy', '/v2/activity/growth/buddy'];

const mask = (v) =>
  !v ? '(空)' : v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 6)}…${v.slice(-4)} (len=${v.length})`;

const ts = (sec) =>
  Number.isFinite(sec) && sec > 0
    ? new Date(sec * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '(无)';

function rule(title) {
  console.log('\n' + '━'.repeat(72));
  console.log('▌ ' + title);
  console.log('━'.repeat(72));
}

function parseArgs(argv) {
  const out = { prefixes: [], depart: false, claim: false, tokenFile: null, fromWeauto: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--depart') out.depart = true;
    else if (a === '--claim') out.claim = true;
    else if (a === '--prefix') out.prefixes.push(argv[++i]);
    else if (a === '--token-file') out.tokenFile = argv[++i];
    else if (a === '--from-weauto') out.fromWeauto = argv[++i];
  }
  return out;
}

/* ───────────────────────── 取凭据 ───────────────────────── */

/**
 * 从 WeAuto 部署目录里解出一枚 WorkBuddy token。
 *
 * 服务器上的 token 是 AES-256-GCM 加密存的（src/user-secrets.mjs），
 * 主密钥就在同一个 data/ 目录里。这条路径只为「在这台机器上直接探测」服务——
 * 它不增加任何风险，因为能读 data/ 的人本来就能读数据库。
 *
 * 两种表都认：v7 的 credentials/credential_fields，以及更早的 user_secrets。
 * 同一账号可能有好几份（签到/活跃分组前留下的），取 updated_at 最新的那份。
 */
async function tokenFromWeauto(dir) {
  const base = dir.replace(/^~/, process.env.HOME ?? '');
  const dbPath = path.join(base, 'data', 'weauto.db');
  const keyPath = path.join(base, 'data', 'master-key');
  if (!fs.existsSync(dbPath)) throw new Error(`找不到数据库：${dbPath}`);
  if (!fs.existsSync(keyPath)) throw new Error(`找不到主密钥：${keyPath}`);

  const [{ default: Database }, { decryptValue }] = await Promise.all([
    import('better-sqlite3'),
    import(path.join(ROOT, 'src', 'user-secrets.mjs')),
  ]);
  /*
   * 主密钥文件是 **base64 文本**（config.loadMasterKey 写入时就是
   * `${key.toString('base64')}\n`），不是 32 字节裸二进制。
   * 直接 readFileSync 拿到 44 字符，喂给 decryptValue 会被长度断言拒掉，
   * 而报错又被 catch 吞成「没有可解密的凭据」——一个格式问题伪装成数据问题。
   */
  const keyFile = fs.readFileSync(keyPath);
  const fromB64 = Buffer.from(keyFile.toString('utf8').trim(), 'base64');
  const key = fromB64.length === 32 ? fromB64 : keyFile;
  if (key.length !== 32) throw new Error(`主密钥长度不对：${key.length} 字节（应为 32）`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const candidates = [];
  try {
    const rows = db
      .prepare(
        `SELECT f.value_enc AS enc, c.updated_at AS ts
           FROM credential_fields f
           JOIN credentials c ON c.id = f.credential_id
          WHERE f.field = 'WB_ACCESS_TOKEN' AND c.group_name = 'workbuddy'`,
      )
      .all();
    for (const r of rows) candidates.push({ enc: r.enc, ts: r.ts });
  } catch {
    /* 旧库没有这两张表，走下面的 user_secrets */
  }
  try {
    const rows = db
      .prepare("SELECT value_enc AS enc, updated_at AS ts FROM user_secrets WHERE field = 'WB_ACCESS_TOKEN'")
      .all();
    for (const r of rows) candidates.push({ enc: r.enc, ts: r.ts });
  } catch {
    /* 新库没有旧表 */
  }
  db.close();

  candidates.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  for (const c of candidates) {
    try {
      const token = decryptValue(Buffer.from(c.enc), key);
      if (token) return { token, count: candidates.length };
    } catch {
      /* 解不开就试下一份 */
    }
  }
  throw new Error(`数据库里没有可解密的 WB_ACCESS_TOKEN（候选 ${candidates.length} 条）`);
}

/* ───────────────────────── 请求 ───────────────────────── */

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept-Language': 'zh-CN',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    return { status: res.status, json, text, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, error: err.message, text: '', json: null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const brief = (r) =>
  r.error
    ? `✗ ${r.error}`
    : `HTTP ${r.status} | ${JSON.stringify(r.json ?? {}).slice(0, 500) || r.text.slice(0, 200).replace(/\s+/g, ' ')}`;

/* ───────────────────────── 主流程 ───────────────────────── */

const args = parseArgs(process.argv.slice(2));

let token = '';
let tokenSource = '';
if (args.tokenFile) {
  token = fs.readFileSync(args.tokenFile.replace(/^~/, process.env.HOME ?? ''), 'utf8').trim();
  tokenSource = `--token-file ${args.tokenFile}`;
} else if (process.env.WB_ACCESS_TOKEN) {
  token = process.env.WB_ACCESS_TOKEN.trim();
  tokenSource = '环境变量 WB_ACCESS_TOKEN';
} else if (args.fromWeauto) {
  try {
    const r = await tokenFromWeauto(args.fromWeauto);
    token = r.token;
    tokenSource = `${args.fromWeauto}/data/weauto.db（候选 ${r.count} 条）`;
  } catch (err) {
    console.error(`✗ 从 WeAuto 取凭据失败：${err.message}`);
    process.exit(2);
  }
} else {
  console.error('✗ 缺少凭据：--from-weauto <部署目录> / --token-file <path> / 环境变量 WB_ACCESS_TOKEN');
  process.exit(2);
}

rule('0. 凭据');
console.log('  来源  :', tokenSource);
console.log('  token :', mask(token));
let uid = '';
try {
  const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  uid = claims.sub ?? '';
  console.log('  exp   :', ts(claims.exp), '（北京时间）');
} catch {
  console.log('  ⚠️ 不是可解析的 JWT，跳过 exp 检查');
}

/** 三档头组合：最小 / 带 uid / 网页端全量 */
const HEADER_SETS = [
  ['仅 Bearer', {}],
  ['+ Referer', { Referer: `${BASE}/profile/growth-center` }],
  [
    '+ X-User-Id / X-Domain / Referer',
    {
      ...(uid ? { 'X-User-Id': uid } : {}),
      'X-Domain': 'www.workbuddy.cn',
      Referer: `${BASE}/profile/growth-center`,
    },
  ],
];

/* ── 1. 前缀探测（GET status，只读） ── */
rule('1. 前缀探测 —— GET <prefix>/travel/status');
const prefixes = args.prefixes.length ? args.prefixes : DEFAULT_PREFIXES;
const prefixResults = [];
for (const prefix of prefixes) {
  const r = await call(`${BASE}${prefix}/travel/status`, {
    headers: { Authorization: `Bearer ${token}`, Referer: `${BASE}/profile/growth-center` },
  });
  const ok = r.status === 200 && r.json?.code === 0;
  console.log(`\n  [${prefix}]  ${ok ? '✅' : '❌'} ${brief(r)}`);
  if (r.json?.data?.state) {
    const d = r.json.data;
    console.log(`    state=${d.state}  depart_at=${ts(d.depart_at)}  arrive_at=${ts(d.arrive_at)}`);
    console.log(`    server_now=${ts(d.server_now)}  daily_limit_reached=${d.daily_limit_reached}  reward_credit=${d.reward_credit}`);
    if (d.location) console.log(`    location=${JSON.stringify(d.location).slice(0, 200)}`);
  }
  prefixResults.push({ prefix, status: r.status, ok, json: r.json });
}
const winner = prefixResults.find((x) => x.ok);
console.log(`\n  ══> 可用前缀：${winner ? winner.prefix : '（无，见上面各条状态）'}`);

/* ── 2. 头矩阵（在可用前缀上） ── */
if (winner) {
  rule('2. 鉴权头矩阵（' + winner.prefix + '/travel/status）');
  const matrix = [];
  for (const [label, extra] of HEADER_SETS) {
    const r = await call(`${BASE}${winner.prefix}/travel/status`, {
      headers: { Authorization: `Bearer ${token}`, ...extra },
    });
    const ok = r.status === 200 && r.json?.code === 0;
    console.log(`\n  [${label}] ${ok ? '✅' : '❌'} HTTP ${r.status} code=${r.json?.code ?? '(无)'} ${r.json?.msg ?? ''}`);
    matrix.push({ label, status: r.status, code: r.json?.code ?? null });
  }
  const minimal = matrix.find((m) => m.status === 200 && m.code === 0);
  console.log(`\n  ══> 最小可用头：${minimal ? minimal.label : '（未确认）'}`);

  /* ── 3. 只读接口全景 ── */
  rule('3. 只读接口全景');
  const configRes = await call(`${BASE}${winner.prefix}/travel/config`, {
    headers: { Authorization: `Bearer ${token}`, Referer: `${BASE}/profile/growth-center` },
  });
  console.log('\n  GET /travel/config :', brief(configRes));
  const locations = configRes.json?.data?.locations ?? [];
  console.log(`  地点数：${locations.length}`);
  for (const l of locations.slice(0, 8)) {
    console.log(`    id=${l?.id}  name=${l?.name}  photos=${(l?.traveling_photos ?? []).length}`);
  }
  if (locations.length === 0) console.log('  ⚠️ 地点为空 = 该账号还没开放旅行功能');
  console.log('  第一个地点的完整字段：', JSON.stringify(locations[0] ?? null).slice(0, 500));

  const recordsRes = await call(`${BASE}${winner.prefix}/travel/records?page=1&page_size=3`, {
    headers: { Authorization: `Bearer ${token}`, Referer: `${BASE}/profile/growth-center` },
  });
  console.log('\n  GET /travel/records :', brief(recordsRes));

  /* ── 4. 写操作（默认跳过） ── */
  rule('4. 写操作');
  const state = prefixResults.find((x) => x.ok)?.json?.data?.state ?? '(未知)';
  if (!args.depart && !args.claim) {
    console.log('  默认只读，未加 --depart / --claim。');
    console.log(`  当前 state=${state}；明天（自然日重置后）建议的完整验证顺序：`);
    console.log('    ① 先跑本脚本（只读）→ 确认 state=idle、daily_limit_reached=false');
    console.log('    ② 加 --depart → 观察返回的 arrive_at 与 daily_limit_reached 是否变 true');
    console.log('    ③ 再跑一次 --depart → 应拿到 daily limit / 429（模板的幂等信号）');
    console.log('    ④ 等 1~4 小时 Buddy 归来 → 只读确认 state=arrived');
    console.log('    ⑤ 加 --claim → 观察 reward_credit');
    console.log('    ⑥ 再跑一次 --claim → 应拿到 not arrived yet / no unclaimed travel');
  } else {
    if (args.claim) {
      const r = await call(`${BASE}${winner.prefix}/travel/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Referer: `${BASE}/profile/growth-center` },
        body: {},
      });
      console.log('\n  POST /travel/claim :', brief(r));
    }
    if (args.depart) {
      const place = locations.find((l) => l?.id != null);
      if (!place) {
        console.log('\n  ⚠️ 没有可选地点，跳过 --depart');
      } else {
        const r = await call(`${BASE}${winner.prefix}/travel/depart`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Referer: `${BASE}/profile/growth-center` },
          body: { location_id: place.id },
        });
        console.log(`\n  POST /travel/depart（location_id=${place.id}）:`, brief(r));
        if (r.json?.data?.arrive_at) console.log(`    arrive_at=${ts(r.json.data.arrive_at)}`);
        const again = await call(`${BASE}${winner.prefix}/travel/depart`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Referer: `${BASE}/profile/growth-center` },
          body: { location_id: place.id },
        });
        console.log('\n  POST /travel/depart（第二次，测幂等码）:', brief(again));
      }
    }
  }
}

/* ── 5. dump ── */
rule('5. 保存探测结果');
const dumpPath = path.join(ROOT, 'data', 'probe-workbuddy-travel.json');
fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
fs.writeFileSync(
  dumpPath,
  JSON.stringify(
    {
      probedAt: new Date().toISOString(),
      prefixes: prefixResults.map(({ prefix, status, ok, json }) => ({ prefix, status, ok, json })),
    },
    null,
    2,
  ),
);
console.log('  已保存:', path.relative(ROOT, dumpPath), '（data/ 已 gitignore，不含 token 原文）');

rule('探针完成');
console.log('  把以上完整输出反馈给 Agent，用以确定 HTTP 前缀与幂等判断码。\n');

process.exit(winner ? 0 : 1);
