import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { BrowserError, prepareBrowserProfile } from './browser.mjs';
import { browserErrorKind, createDiagnosticLogger } from './browser-diagnostics.mjs';

export function browserProfilePath(root, { userId, credentialId, groupName }) {
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(credentialId) || credentialId <= 0 ||
      typeof groupName !== 'string' || !groupName) throw new BrowserError('浏览器必须绑定明确的用户和站点账号');
  const key = crypto.createHash('sha256').update(JSON.stringify([userId, groupName, credentialId])).digest('hex');
  return path.join(path.resolve(root), key);
}

function groupAlive(pid) {
  if (!pid) return false;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0])) return true;
    } catch {}
  }
  return false;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
}

function chromeProfileOccupied(directory) {
  try {
    const lock = fs.readlinkSync(path.join(directory, 'SingletonLock'));
    const separator = lock.lastIndexOf('-');
    if (lock.slice(0, separator) !== os.hostname()) return true;
    return processAlive(Number(lock.slice(separator + 1)));
  } catch (err) { return err.code !== 'ENOENT'; }
}

export function seedBrowserProfile({ source, profileRoot, ...identity }) {
  const sourceDir = fs.realpathSync(source);
  const existing = JSON.parse(fs.readFileSync(path.join(sourceDir, '.weauto-binding.json'), 'utf8'));
  if (existing.userId !== identity.userId || existing.credentialId !== identity.credentialId || existing.groupName !== identity.groupName) {
    throw new BrowserError('初始浏览器 profile 与指定站点账号不匹配');
  }
  prepareBrowserProfile({ profileDir: sourceDir, ...identity });
  if (chromeProfileOccupied(sourceDir) || fs.existsSync(path.join(sourceDir, '.weauto-browser.lock'))) {
    throw new BrowserError('初始浏览器仍在使用，请先结束该测试会话', 'blocked');
  }
  const destination = browserProfilePath(profileRoot, identity);
  fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(profileRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) ||
      (process.getuid && rootStat.uid !== process.getuid())) throw new BrowserError('初始化目标必须是当前用户私有目录');
  if (sourceDir === destination) throw new BrowserError('初始与目标 profile 不能是同一个目录');
  if (fs.existsSync(destination)) {
    prepareBrowserProfile({ profileDir: destination, ...identity });
    if (chromeProfileOccupied(destination) || fs.existsSync(path.join(destination, '.weauto-browser.lock'))) throw new BrowserError('目标 profile 正在执行，拒绝初始化', 'blocked');
    fs.renameSync(destination, `${destination}.backup-${Date.now()}`);
  }
  const temporary = fs.mkdtempSync(path.join(profileRoot, '.seed-'));
  fs.cpSync(sourceDir, temporary, { recursive: true, filter: (file) => {
    const name = path.basename(file);
    return !fs.lstatSync(file).isSymbolicLink() && !['DevToolsActivePort', '.weauto-browser.lock', 'Cache', 'Code Cache', 'GPUCache', 'ShaderCache'].includes(name) && !name.startsWith('Singleton');
  } });
  fs.chmodSync(temporary, 0o700);
  fs.renameSync(temporary, destination);
  return destination;
}

function takeLock(directory) {
  const file = path.join(directory, '.weauto-browser.lock');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); } catch (err) {
    if (err.code !== 'EEXIST') throw new BrowserError('无法锁定浏览器 profile');
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
      throw new BrowserError('浏览器 profile 锁无法校验，拒绝复用', 'blocked');
    }
    if (processAlive(previous.pid) || (previous.groupPid && groupAlive(previous.groupPid)) || chromeProfileOccupied(directory)) {
      throw new BrowserError('浏览器 profile 正在使用，未启动重复浏览器', 'blocked');
    }
    fs.unlinkSync(file);
    try { fd = fs.openSync(file, 'wx', 0o600); } catch {
      throw new BrowserError('浏览器 profile 被其他执行占用', 'blocked');
    }
  }
  const update = (groupPid = null) => {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, groupPid }), 0, 'utf8');
  };
  update();
  return { update, release: () => { fs.closeSync(fd); fs.unlinkSync(file); } };
}

export async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BrowserError(message, 'network-error')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function browserEnvironment(env = process.env, runtimeDir = `/run/user/${process.getuid?.()}`) {
  const out = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'XDG_RUNTIME_DIR',
    'XDG_SESSION_TYPE', 'XDG_SESSION_CLASS', 'XDG_SESSION_ID', 'DBUS_SESSION_BUS_ADDRESS']
    .filter((key) => env[key] != null).map((key) => [key, env[key]]));
  try {
    if (fs.statSync(path.join(runtimeDir, 'bus')).isSocket()) {
      out.XDG_RUNTIME_DIR ??= runtimeDir;
      out.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${runtimeDir}/bus`;
    }
  } catch {}
  return out;
}

/**
 * 选一个当前空闲的回环端口作为 Chrome 调试端口。
 *
 * 为什么不用 `--remote-debugging-port=0`：2026-11-06 在 N150 上做了单因素对照，
 * 其它条件（profile、窗口、环境变量、VNC、父进程）都不影响结果，只有「端口 0」与
 * 「具体端口」不同——端口 0 启动的 Chrome 14 次中 14 次停在 Cloudflare 挑战页，
 * 具体端口 12 次中 12 次进入登录页（含固定 19222 与随机 20000-50000）。
 * 原因没有查明，这是经验性结论；仍用随机端口而不是固定端口，避免调试入口可预测。
 */
export async function pickLoopbackPort({ attempts = 20, random = Math.random, listen = net.createServer } = {}) {
  for (let i = 0; i < attempts; i++) {
    const port = 20_000 + Math.floor(random() * 30_000);
    const free = await new Promise((resolve) => {
      const server = listen();
      server.once('error', () => resolve(false));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new BrowserError('找不到可用的浏览器调试端口', 'network-error');
}

export async function launchManagedChrome({ executablePath, xvfbPath, profileDir, signal, deadlineAt, log, port: requestedPort }) {
  const emit = createDiagnosticLogger(log);
  const port = requestedPort ?? await pickLoopbackPort();
  for (const file of [executablePath, xvfbPath]) {
    try { fs.accessSync(file, fs.constants.X_OK); } catch { throw new BrowserError('浏览器或虚拟屏幕依赖不可用'); }
  }
  if (chromeProfileOccupied(profileDir)) throw new BrowserError('Chrome 正在使用该 profile', 'blocked');
  // 清掉上一轮遗留的端口文件，避免其他逻辑把旧端口当成这一轮的
  try { fs.unlinkSync(path.join(profileDir, 'DevToolsActivePort')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const child = spawn(xvfbPath, ['-a', '-s', '-screen 0 1280x900x24 -nolisten tcp', executablePath,
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--lang=en-US',
    '--window-size=1280,900', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, 'https://v2free.net/auth/login'],
  { detached: true, stdio: 'ignore', env: browserEnvironment() });
  let failed = false;
  child.on('error', (error) => { failed = true; emit({ event: 'lifecycle', phase: 'spawn_error', errorKind: browserErrorKind(error) }); });
  child.on('exit', (exitCode, exitSignal) => emit({ event: 'lifecycle', phase: 'startup_exit', exitCode, exitSignal }));
  let closing;
  const terminate = () => {
    if (closing) return closing;
    closing = (async () => {
      if (!child.pid) return;
      const send = (sig) => { try { process.kill(-child.pid, sig); } catch (err) { if (err.code !== 'ESRCH') throw err; } };
      send('SIGTERM');
      for (let i = 0; i < 20 && groupAlive(child.pid); i++) await delay(100);
      const forcedKill = groupAlive(child.pid);
      if (forcedKill) send('SIGKILL');
      for (let i = 0; i < 20 && groupAlive(child.pid); i++) await delay(100);
      emit({ event: 'lifecycle', phase: 'terminate', forcedKill });
      if (groupAlive(child.pid)) throw new BrowserError('浏览器进程清理未完成，保留 profile 锁', 'network-error');
    })();
    return closing;
  };
  return {
    pid: child.pid,
    async ready() {
      const until = Math.min(deadlineAt, Date.now() + 30_000);
      while (Date.now() < until) {
        signal.throwIfAborted();
        if (failed || child.exitCode !== null || child.signalCode !== null) throw new BrowserError('浏览器启动失败', 'network-error');
        try {
          /*
           * 指定具体端口时 Chrome 不会写 DevToolsActivePort（2026-11-06 实测：HTTP 端点 1 秒内可用、
           * 文件始终不出现），所以以调试 HTTP 端点是否应答为就绪信号——这也正是 Playwright 要连的地方。
           * 必须是 Chrome 的应答，且我们自己启动的进程仍活着。
           */
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
          const info = response.ok ? await response.json() : null;
          if (typeof info?.Browser === 'string' && info.Browser.startsWith('Chrome/')) {
            await delay(Math.max(0, Math.min(8000, until - Date.now())), undefined, { signal });
            signal.throwIfAborted();
            if (failed || child.exitCode !== null || child.signalCode !== null) throw new BrowserError('浏览器启动失败', 'network-error');
            return `http://127.0.0.1:${port}`;
          }
        } catch (error) {
          if (error instanceof BrowserError || signal.aborted) throw error;
        }
        await delay(100, undefined, { signal });
      }
      throw new BrowserError('等待浏览器启动超时', 'network-error');
    },
    async waitForExit() {
      const until = Date.now() + 2500;
      while (groupAlive(child.pid) && Date.now() < until) await delay(100);
    },
    terminate,
  };
}

export function createManagedBrowserProvider({ profileRoot, executablePath = '/opt/google/chrome/chrome',
  xvfbPath = '/usr/bin/xvfb-run', maxConcurrent = 1,
  launch = launchManagedChrome, connect = (url, timeout) => chromium.connectOverCDP(url, { timeout }) }) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new BrowserError('浏览器并发必须为 1 到 4');
  const root = path.resolve(profileRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) ||
      (process.getuid && rootStat.uid !== process.getuid())) throw new BrowserError('浏览器 profile 根目录必须为当前用户私有目录');
  let active = 0;
  let stopped = false;
  const leases = new Set();
  return {
    matches({ groupName, userId, credentialId }) {
      return groupName === 'v2free' && Number.isInteger(userId) && userId > 0 && Number.isInteger(credentialId) && credentialId > 0;
    },
    async acquire({ signal, deadlineAt = Date.now() + 180_000, log, ...identity }) {
      const emit = createDiagnosticLogger(log);
      const started = Date.now();
      let phase = 'queue';
      const mark = (next) => { phase = next; emit({ event: 'lifecycle', phase, elapsedMs: Date.now() - started }); };
      mark('queue');
      if (!this.matches(identity)) throw new BrowserError('浏览器账号与任务凭据不匹配');
      while (active >= maxConcurrent && !stopped) {
        signal.throwIfAborted();
        if (Date.now() >= deadlineAt) throw new BrowserError('等待浏览器执行槽超时', 'network-error');
        await delay(100, undefined, { signal });
      }
      signal.throwIfAborted();
      if (stopped) throw new BrowserError('浏览器服务正在退出', 'network-error');
      active++;
      let lock;
      let session;
      let browser;
      let page;
      let closing;
      const release = () => {
        if (closing) return closing;
        closing = (async () => {
          const cleanupStarted = Date.now();
          emit({ event: 'lifecycle', phase: 'cleanup_start' });
          try {
            if (browser?.newBrowserCDPSession) {
              await within((async () => {
                const protocol = await browser.newBrowserCDPSession();
                await protocol.send('Browser.close');
              })(), 1500, '正常关闭 Chrome 超时').catch((error) => emit({ event: 'lifecycle', phase: 'chrome_close', errorKind: browserErrorKind(error) }));
              if (session?.waitForExit) await session.waitForExit();
            }
            if (browser) await within(browser.close(), 1500, '关闭浏览器连接超时').catch((error) => emit({ event: 'lifecycle', phase: 'disconnect', errorKind: browserErrorKind(error) }));
            if (session) await session.terminate();
            if (lock) lock.release();
            emit({ event: 'lifecycle', phase: 'cleanup_done', elapsedMs: Date.now() - cleanupStarted, lockReleased: !!lock });
          } catch (error) {
            emit({ event: 'lifecycle', phase: 'cleanup_failed', errorKind: browserErrorKind(error), lockReleased: false });
            throw error;
          } finally {
            signal.removeEventListener('abort', onAbort);
            leases.delete(release);
            active--;
          }
        })();
        return closing;
      };
      const onAbort = () => {
        emit({ event: 'lifecycle', phase: 'cancel', aborted: true });
        if (page && !page.isClosed()) page.close({ runBeforeUnload: false }).catch(() => {});
        if (!page && session) session.terminate().catch(() => {});
      };
      leases.add(release);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const directory = browserProfilePath(root, identity);
        emit({ event: 'lifecycle', phase: 'profile_lock', profileReused: fs.existsSync(directory) });
        mark('profile_lock');
        try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
        if (fs.lstatSync(directory).isSymbolicLink()) throw new BrowserError('浏览器 profile 不允许符号链接');
        prepareBrowserProfile({ profileDir: directory, ...identity });
        lock = takeLock(directory);
        signal.throwIfAborted();
        mark('launch');
        session = await launch({ executablePath, xvfbPath, profileDir: directory, signal, deadlineAt, log });
        lock.update(session.pid);
        signal.throwIfAborted();
        mark('ready');
        const endpoint = await session.ready();
        mark('connect');
        const remaining = () => Math.max(1, Math.min(15_000, deadlineAt - Date.now()));
        const connecting = connect(endpoint, remaining());
        connecting.then((value) => { if (signal.aborted || closing) value.close().catch(() => {}); }, () => {});
        browser = await within(connecting, remaining(), '连接浏览器超时');
        signal.throwIfAborted();
        browser.on?.('disconnected', () => emit({ event: 'browser_disconnected' }));
        mark('page');
        const contexts = browser.contexts();
        if (contexts.length !== 1) throw new BrowserError('浏览器必须只有一个独立 profile');
        page = contexts[0].pages?.()[0] ?? await within(contexts[0].newPage(), remaining(), '创建浏览器页面超时');
        signal.throwIfAborted();
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(45_000);
        return { page, release };
      } catch (err) {
        emit({ event: 'operation_failed', phase, errorKind: browserErrorKind(err, signal), elapsedMs: Date.now() - started });
        await release();
        if (err instanceof BrowserError) throw err;
        throw new BrowserError(signal.aborted ? '浏览器执行已取消' : '浏览器生命周期操作失败', 'network-error');
      }
    },
    async close() {
      stopped = true;
      return Promise.allSettled([...leases].map((release) => release()));
    },
  };
}

export function configureBrowserTasks(tasks, { mode }) {
  if (mode !== 'managed') return tasks;
  for (const [name, task] of tasks) {
    if (task.credentialGroup === 'v2free' && task.browser === true) tasks.set(name, { ...task, browserRequired: true, timeoutMs: 180_000 });
  }
  return tasks;
}
