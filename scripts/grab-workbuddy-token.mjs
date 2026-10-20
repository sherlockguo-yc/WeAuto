#!/usr/bin/env node
/**
 * WeAuto —— WorkBuddy accessToken 一键抓取（macOS / Windows）
 *
 * 背景：WorkBuddy 的 accessToken 只存在于客户端进程内存里（磁盘上是 keyblob 加密的，
 * 解不开也没必要解）。唯一稳定的取法是让客户端自己发一个请求，我们从 CDP 的
 * Network 事件里把 Authorization 头读出来——也就是这个脚本干的事。
 *
 * 流程：
 *   1. 退出 WorkBuddy
 *   2. 带 --remote-debugging-port 重新启动
 *   3. CDP 挂上 renderer，开 Network，reload 一次页面触发请求
 *   4. 从 Network.requestWillBeSent 里取 Authorization: Bearer
 *   5. 关掉调试实例，恢复正常启动（回到你原来的状态）
 *   6. token 复制到剪贴板 + 打印到期时间
 *
 * 【不做的事】
 *   · 不打印完整 token 到终端（除非显式 --print），避免留在 shell 历史与日志里
 *   · 不写任何文件（--out 显式指定才写）
 *   · 不联网上传，token 只去剪贴板
 *
 * 用法：
 *   node scripts/grab-workbuddy-token.mjs --push https://weauto.example.com --code ABCD-1234
 *       从任务页「一键生成」拿到的命令。跑完直接把 token 写进 WeAuto，不用复制粘贴。
 *   node scripts/grab-workbuddy-token.mjs
 *       已经配对过（~/.weauto/bind.json 存在）时，自动推送，不带任何参数。
 *   node scripts/grab-workbuddy-token.mjs --print          # 同时打印完整 token（不进剪贴板）
 *   node scripts/grab-workbuddy-token.mjs --app /path/to/WorkBuddy.app
 *   node scripts/grab-workbuddy-token.mjs --keep           # 抓完不恢复正常启动（调试用）
 *
 * 退出码：0 成功 / 1 失败 / 2 参数或环境不支持
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const DEFAULT_PORT = 9333;

/**
 * 配对信息。仓库里的这份是 null；从任务页「下载脚本」拿到的那份，服务端会把这一行
 * 替换成 { server, taskId, pushToken }，于是运行时**不需要任何参数**。
 *
 * 这就是"下载完直接执行"的全部秘密：把原来要人工生成、粘贴的命令参数，
 * 提前写进文件里。
 */
const EMBEDDED_PAIRING = null;
/** 等客户端起来并出现 page target 的上限 */
const BOOT_TIMEOUT_MS = 45_000;
/** 挂上 CDP 后等 Authorization 头上限 */
const CAPTURE_TIMEOUT_MS = 25_000;
/** 等进程退出的上限 */
const QUIT_TIMEOUT_MS = 15_000;

/* ───────────────────────── 参数 ───────────────────────── */

function parseArgs(argv) {
  const out = {
    port: DEFAULT_PORT,
    app: null,
    appName: IS_MAC ? 'WorkBuddy' : null,
    print: false,
    keep: false,
    out: null,
    timeout: CAPTURE_TIMEOUT_MS,
    push: null,
    code: null,
    pushToken: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--app') out.app = argv[++i];
    else if (a === '--app-name') out.appName = argv[++i];
    else if (a === '--print') out.print = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--push') out.push = argv[++i];
    else if (a === '--code') out.code = argv[++i];
    // Windows 的 .cmd 启动器用它把令牌直接传给脚本，不必落地任何文件
    else if (a === '--push-token') out.pushToken = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]) * 1000;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const mask = (v) =>
  !v ? '(空)' : v.length <= 12 ? '*'.repeat(v.length) : `${v.slice(0, 6)}…${v.slice(-4)} (len=${v.length})`;

function die(msg, code = 1) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(code);
}

/* ───────────────────────── 定位与启停客户端 ───────────────────────── */

/** 各平台常见的安装位置。找不到就让用户用 --app 指定，不去全盘扫描 */
function candidateApps() {
  if (IS_MAC) {
    return [
      '/Applications/WorkBuddy.app',
      path.join(os.homedir(), 'Applications', 'WorkBuddy.app'),
    ];
  }
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? '';
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return [
      path.join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      path.join(local, 'WorkBuddy', 'WorkBuddy.exe'),
      path.join(pf, 'WorkBuddy', 'WorkBuddy.exe'),
      path.join(pf86, 'WorkBuddy', 'WorkBuddy.exe'),
    ];
  }
  return [];
}

function findApp(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) die(`--app 指定的路径不存在：${explicit}`, 2);
    return explicit;
  }
  for (const p of candidateApps()) {
    if (fs.existsSync(p)) return p;
  }
  die(
    `没找到 WorkBuddy 客户端。请用 --app 指定安装路径。\n  已尝试：\n${candidateApps()
      .map((p) => `    · ${p}`)
      .join('\n')}`,
    2,
  );
}

/** 进程是否在跑。用包路径/镜像名匹配，避免误伤其它 Electron 应用 */
async function isAppRunning(appPath) {
  try {
    if (IS_MAC) {
      await execFileP('pgrep', ['-f', `${appPath}/Contents/MacOS/`]);
    } else {
      const exe = path.basename(appPath);
      const { stdout } = await execFileP('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH']);
      // Windows 找不到时会输出「信息: 没有运行的任务…」，不能只看退出码
      if (!stdout.toLowerCase().includes(exe.toLowerCase())) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(fn, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function quitApp(appPath, appName) {
  if (!(await isAppRunning(appPath))) return false;
  if (IS_MAC) {
    await execFileP('osascript', ['-e', `quit app "${appName}"`]).catch(() => {});
  } else {
    await execFileP('taskkill', ['/IM', path.basename(appPath)]).catch(() => {});
  }
  const gone = await waitUntil(async () => !(await isAppRunning(appPath)), QUIT_TIMEOUT_MS);
  if (!gone) {
    die('客户端没有退出（可能有未保存内容弹窗）。请手动退出 WorkBuddy 后重试。');
  }
  return true;
}

async function launchWithDebug(appPath, port) {
  const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
  if (IS_MAC) {
    await execFileP('open', ['-a', appPath, '--args', ...args]);
  } else {
    spawn(appPath, args, { detached: true, stdio: 'ignore' }).unref();
  }
}

async function launchNormal(appPath) {
  if (IS_MAC) await execFileP('open', ['-a', appPath]);
  else spawn(appPath, [], { detached: true, stdio: 'ignore' }).unref();
}

/* ───────────────────────── CDP over 最小 WebSocket ───────────────────────── */

/**
 * 最小 WebSocket 客户端（只用 text frame）。
 *
 * 为什么不直接用全局 WebSocket：那是 Node 22+ 才有的。这个脚本要给朋友跑，
 * Node 18/20 很常见，为一个握手引入依赖又不划算，所以自己实现收发。
 * 只覆盖 CDP 用到的部分：文本帧、ping/pong、close、分片重组。
 */
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = randomBytes(16).toString('base64');
    const sock = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let fragments = [];
    const listeners = [];

    const fail = (err) => {
      sock.destroy();
      reject(err);
    };

    sock.on('error', (err) => (handshakeDone ? listeners.forEach((l) => l.onError?.(err)) : fail(err)));
    sock.on('close', () => listeners.forEach((l) => l.onClose?.()));

    sock.on('connect', () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!handshakeDone) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        if (!/^HTTP\/1\.1 101/i.test(head)) return fail(new Error(`WebSocket 握手失败：${head.split('\r\n')[0]}`));
        handshakeDone = true;
        resolve(api);
      }

      // 解析所有完整帧
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < offset + 2) return;
          len = buf.readUInt16BE(offset);
          offset += 2;
        } else if (len === 127) {
          if (buf.length < offset + 8) return;
          len = Number(buf.readBigUInt64BE(offset));
          offset += 8;
        }
        const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (buf.length < offset + len) return;

        let payload = buf.subarray(offset, offset + len);
        buf = buf.subarray(offset + len);
        if (masked) payload = Buffer.from(payload.map((b, i) => b ^ maskKey[i % 4]));

        if (opcode === 0x9) {
          sock.write(encodeFrame(payload, 0xa)); // ping → pong
          continue;
        }
        if (opcode === 0xa) continue; // pong
        if (opcode === 0x8) {
          sock.end();
          return;
        }
        if (opcode === 0x0) {
          fragments.push(payload);
          if (!fin) continue;
          payload = Buffer.concat(fragments);
          fragments = [];
        } else if (opcode === 0x1) {
          if (!fin) {
            fragments = [payload];
            continue;
          }
        } else continue;

        let msg;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          continue;
        }
        listeners.forEach((l) => l.onMessage?.(msg));
      }
    });

    const api = {
      send: (obj) => {
        if (sock.writable) sock.write(encodeFrame(Buffer.from(JSON.stringify(obj))));
      },
      onMessage: (fn) => listeners.push({ onMessage: fn }),
      onError: (fn) => listeners.push({ onError: fn }),
      onClose: (fn) => listeners.push({ onClose: fn }),
      close: () => sock.end(),
    };
  });
}

/** 客户端→服务端必须掩码；只发文本帧，长度覆盖 7/16/64 位 */
function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  const maskKey = randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}

/* ───────────────────────── 抓取 ───────────────────────── */

async function cdpTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForPageTarget(port) {
  const ok = await waitUntil(async () => {
    const list = await cdpTargets(port);
    return Array.isArray(list) && list.some((t) => t.type === 'page');
  }, BOOT_TIMEOUT_MS);
  if (!ok) return null;
  const list = await cdpTargets(port);
  return list.find((t) => t.type === 'page');
}

/**
 * 挂上 renderer，开 Network，reload 一次，等第一个带 Authorization 的请求。
 *
 * 为什么必须 reload：脚本是在客户端已经启动完之后才挂上去的，启动阶段的请求
 * 已经发完了。reload 会让渲染层重新走一遍初始化，必然再发一次带鉴权的请求。
 */
function captureAuthHeader(wsUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    wsConnect(wsUrl)
      .then((ws) => {
        let id = 0;
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          ws.close();
          reject(new Error('等待 Authorization 头超时（reload 后仍没有带鉴权的请求）'));
        }, timeoutMs);

        ws.onMessage((msg) => {
          if (msg.method !== 'Network.requestWillBeSent' || done) return;
          const { request } = msg.params;
          const headers = request.headers ?? {};
          const key = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
          if (!key) return;
          const raw = headers[key];
          done = true;
          clearTimeout(timer);
          ws.close();
          resolve({
            url: request.url,
            header: raw,
            token: raw.replace(/^Bearer\s+/i, '').trim(),
          });
        });

        ws.onError((err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        });

        ws.send({ id: ++id, method: 'Network.enable' });
        ws.send({ id: ++id, method: 'Page.enable' });
        ws.send({ id: ++id, method: 'Page.reload', params: { ignoreCache: false } });
      })
      .catch(reject);
  });
}

/* ───────────────────────── 工具 ───────────────────────── */

/** 解 JWT exp，只用于告诉用户这把钥匙还能用几天 */
function tokenExpiry(token) {
  const part = String(token ?? '').split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function copyToClipboard(text) {
  const cmd = IS_MAC ? 'pbcopy' : 'clip';
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, [], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
      p.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/* ───────────────────────── 推送到 WeAuto ───────────────────────── */

/** 配对信息存这里：0600，只含服务器地址与长期 pushToken，不含 WorkBuddy 凭据 */
const BIND_FILE = path.join(os.homedir(), '.weauto', 'bind.json');

function readBind() {
  try {
    const raw = JSON.parse(fs.readFileSync(BIND_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeBind(data) {
  fs.mkdirSync(path.dirname(BIND_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(BIND_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * 把 token 推给 WeAuto。
 *
 * 两条路：带 code（首次配对，服务器会回一个长期 pushToken）或带 pushToken（之后每月）。
 * 不吞错误——推送失败必须让用户当场看见，否则他关掉终端会以为更新成功了。
 */
async function pushToWeAuto({ server, token, code, pushToken }) {
  const base = String(server).replace(/\/+$/, '');
  const body = { token };
  if (code) body.code = code;
  else if (pushToken) body.pushToken = pushToken;
  else throw new Error('缺少配对码，也没有可用的 pushToken');

  const res = await fetch(`${base}/api/tools/push-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON：下面按状态码报错 */
  }
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json ?? {};
}

const fmtLocal = (ms) =>
  new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    return;
  }
  if (!IS_MAC && !IS_WIN) die(`暂不支持 ${process.platform}，本脚本只覆盖 macOS 与 Windows`, 2);

  const appPath = findApp(args.app);
  const appName = args.appName ?? path.basename(appPath).replace(/\.(app|exe)$/i, '');
  console.log(`客户端：${appPath}`);

  let startedByUs = false;
  /*
   * 先做一次**立即**探测：端口没开是常态，不能用 waitForPageTarget —— 那里会
   * 老老实实等满 45 秒，让「什么都没发生」变成一次莫名其妙的卡顿。
   */
  const existing = await cdpTargets(args.port);
  let target = Array.isArray(existing) ? (existing.find((t) => t.type === 'page') ?? null) : null;
  const wasRunning = await isAppRunning(appPath);

  if (!target) {
    if (wasRunning) {
      console.log('→ 退出客户端…');
      await quitApp(appPath, appName);
    }
    console.log(`→ 带调试端口重启（${args.port}）…`);
    await launchWithDebug(appPath, args.port);
    startedByUs = true;
    target = await waitForPageTarget(args.port);
    if (!target) die('客户端起来了，但没等到可调试的页面。可能是版本禁用了 CDP，或启动很慢——把 --timeout 调大再试');
  } else {
    console.log(`→ 调试端口 ${args.port} 已经可用，直接复用`);
  }

  console.log('→ 挂上 CDP，reload 触发一次请求…');
  let captured;
  try {
    captured = await captureAuthHeader(target.webSocketDebuggerUrl, args.timeout);
  } finally {
    if (startedByUs && !args.keep) {
      console.log('→ 恢复：关掉调试实例，按原样重新启动…');
      await quitApp(appPath, appName).catch(() => {});
      if (wasRunning) await launchNormal(appPath).catch(() => {});
    }
  }

  const expMs = tokenExpiry(captured.token);
  const days = expMs === null ? null : Math.floor((expMs - Date.now()) / 86400000);

  /* ── 优先推送到 WeAuto：推成功就不用再碰剪贴板和网页 ── */
  const bind = readBind();
  // 优先级：命令行显式给的 > 服务端注入进本文件的 > 上次配对记下的
  const embedded = EMBEDDED_PAIRING?.server ? EMBEDDED_PAIRING : null;
  const server = args.push ? args.push.replace(/\/+$/, '') : (embedded?.server ?? bind?.server ?? null);
  const inherited = args.code
    ? null
    : (args.pushToken ?? embedded?.pushToken ?? bind?.pushToken ?? null);
  const canPush = Boolean(server && (args.code || inherited));

  let pushed = null;
  let pushError = null;
  if (canPush) {
    try {
      pushed = await pushToWeAuto({
        server,
        token: captured.token,
        code: args.code || null,
        pushToken: inherited,
      });
      // 首次配对成功时服务器回发长期 pushToken，存下来以后就不用再打开网页
      if (pushed.pushToken) {
        writeBind({
          server,
          taskId: pushed.taskId,
          pushToken: pushed.pushToken,
          savedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      pushError = err.message;
    }
  }

  // 推送成功就不再动剪贴板：覆盖用户剪贴板是没必要的副作用
  const copied = pushed ? false : await copyToClipboard(captured.token);
  if (args.out) {
    fs.writeFileSync(args.out, captured.token, { mode: 0o600 });
    console.log(`token 已写入 ${args.out}`);
  }

  console.log('\n' + '─'.repeat(64));
  console.log('✓ 抓取成功');
  console.log(`  token      : ${mask(captured.token)}`);
  if (expMs !== null) console.log(`  到期       : ${fmtLocal(expMs)}（还剩 ${days} 天）`);
  console.log(`  来源请求   : ${captured.url}`);
  if (pushed) console.log(`  WeAuto     : 已更新 ✓（${server}）`);
  if (pushError) console.log(`  WeAuto     : 推送失败 — ${pushError}`);
  if (!pushed) console.log(`  剪贴板     : ${copied ? '已复制 ✓' : '复制失败，请加 --print 手动复制'}`);
  console.log('─'.repeat(64));
  if (args.print) console.log(`\n${captured.token}\n`);

  if (pushed) {
    console.log('回去看一眼页面即可，它会自动刷新显示已更新。');
    if (args.pushToken) {
      // 从 Windows 启动器来的：脚本本体是临时文件，名字没有复用价值
      console.log('以后每月回任务页重新下载启动器、双击运行即可。');
    } else if (process.argv[1]) {
      console.log(`以后每月直接运行 node ${path.basename(process.argv[1])} 就行，不用带参数、也不用打开网页。`);
    }
  } else if (pushError) {
    console.log('token 已复制到剪贴板，可以到 WeAuto 任务页手动粘贴；');
    console.log('或者回任务页重新下载脚本（配对信息已内嵌，下载后直接运行即可）。');
  } else {
    console.log('下一步：打开 WeAuto 任务页，下载那份带配对信息的脚本重新运行；');
    console.log('或者把上面的 token 手动粘贴到凭据输入框。');
  }
  if (days !== null && days <= 7) console.log(`⚠️  这枚 token 只剩 ${days} 天，请尽快使用`);
}

main().catch((err) => die(err.message));
