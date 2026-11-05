import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

export class BrowserError extends Error {
  constructor(message, status = 'config-error') {
    super(message);
    this.status = status;
  }
}

export function validateBrowserEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new BrowserError('浏览器调试地址必须是受信的本机回环 HTTP 地址');
  }
  return url.origin;
}

export function createBrowserProvider({ endpoint, profileDir, userId, credentialId, groupName,
  connect = (url) => chromium.connectOverCDP(url, { timeout: 15_000 }) }) {
  const address = validateBrowserEndpoint(endpoint);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(credentialId) || credentialId <= 0 || !groupName) {
    throw new BrowserError('浏览器必须绑定明确的用户和站点账号');
  }
  const directory = fs.realpathSync(profileDir);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new BrowserError('浏览器 profile 必须由当前运行用户独占，目录权限为 700');
  }
  const identity = { userId, credentialId, groupName };
  const bindingFile = path.join(directory, '.weauto-binding.json');
  try {
    fs.writeFileSync(bindingFile, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw new BrowserError('无法保存浏览器账号绑定');
    let stored;
    try { stored = JSON.parse(fs.readFileSync(bindingFile, 'utf8')); } catch {
      throw new BrowserError('浏览器账号绑定不可读取');
    }
    if (stored.userId !== userId || stored.credentialId !== credentialId || stored.groupName !== groupName) {
      throw new BrowserError('浏览器 profile 已绑定其他账号，拒绝复用');
    }
  }
  const lockFile = path.join(directory, '.weauto-browser.lock');
  let busy = false;
  let connection;
  return {
    matches(args) {
      return args.userId === userId && args.credentialId === credentialId && args.groupName === groupName;
    },
    async acquire({ signal, ...args }) {
      if (!this.matches(args)) throw new BrowserError('浏览器账号与任务凭据不匹配');
      signal.throwIfAborted();
      if (busy) throw new BrowserError('浏览器账号正在执行其他任务', 'blocked');
      let fd;
      try { fd = fs.openSync(lockFile, 'wx', 0o600); } catch {
        throw new BrowserError('浏览器 profile 被占用；需确认旧执行已结束', 'blocked');
      }
      fs.writeSync(fd, String(process.pid));
      busy = true;
      let browser;
      let page;
      let closing;
      const release = () => {
        if (closing) return closing;
        closing = (async () => {
          try { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); } catch {}
          signal.removeEventListener('abort', onAbort);
          fs.closeSync(fd);
          fs.unlinkSync(lockFile);
          busy = false;
        })();
        return closing;
      };
      const onAbort = () => {
        if (page && !page.isClosed()) page.close({ runBeforeUnload: false }).catch(() => {});
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        connection ??= Promise.resolve().then(() => connect(address)).catch(() => {
          connection = null;
          throw new BrowserError('无法连接受信浏览器', 'network-error');
        });
        browser = await connection;
        if (browser.isConnected && !browser.isConnected()) {
          connection = null;
          throw new BrowserError('浏览器连接已中断', 'network-error');
        }
        signal.throwIfAborted();
        const contexts = browser.contexts();
        if (contexts.length !== 1) throw new BrowserError('浏览器必须只有一个独立 profile');
        page = await contexts[0].newPage();
        signal.throwIfAborted();
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(45_000);
        return { page, release };
      } catch (err) {
        await release();
        if (err instanceof BrowserError) throw err;
        throw new BrowserError(signal.aborted ? '浏览器执行已取消' : '无法连接受信浏览器', 'network-error');
      }
    },
  };
}
