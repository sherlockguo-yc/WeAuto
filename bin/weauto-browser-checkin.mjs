#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { BrowserError, createBrowserProvider } from '../src/browser.mjs';
import { loadConfig, MASTER_KEY_FILE } from '../src/config.mjs';
import { DB_FILE } from '../src/db.mjs';
import { createExecutor } from '../src/executor.mjs';
import { loadTasks } from '../src/registry.mjs';
import { createStore } from '../src/store.mjs';
import { createUserSecrets, secretsLoaderFor } from '../src/user-secrets.mjs';

export function resolveBrowserTarget(db, store, { username, label, task }) {
  const user = db.prepare('SELECT id FROM users WHERE username = ? AND status = ?').get(username, 'active');
  if (!user) throw new BrowserError('指定用户不存在或已停用');
  const credentials = db.prepare('SELECT id FROM credentials WHERE user_id = ? AND group_name = ? AND label = ?')
    .all(user.id, task.credentialGroup ?? task.name, label);
  if (credentials.length !== 1) throw new BrowserError('指定站点账号不存在或名称不唯一，未读取凭据');
  const credentialId = credentials[0].id;
  const tasks = store.forUser(user.id).tasksOfTemplate(task.name).filter((item) => item.credentialId === credentialId);
  if (tasks.length !== 1) throw new BrowserError('指定账号必须唯一绑定一个签到任务，未读取凭据');
  return { userId: user.id, credentialId, accountKey: tasks[0].accountKey };
}

async function main() {
  const { values } = parseArgs({ options: {
    user: { type: 'string' }, account: { type: 'string' },
    'profile-dir': { type: 'string' }, endpoint: { type: 'string', default: 'http://127.0.0.1:19222' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node bin/weauto-browser-checkin.mjs --user USER --account LABEL --profile-dir DIRECTORY');
    return 0;
  }
  if (!values.user || !values.account || !values['profile-dir']) throw new BrowserError('必须指定用户、站点账号名称和独立 profile 目录');
  if (!fs.existsSync(DB_FILE) || (!process.env.WEAUTO_MASTER_KEY && !fs.existsSync(MASTER_KEY_FILE))) {
    throw new BrowserError('仅允许使用已有的 WeAuto 数据库和凭据主密钥，不初始化新数据');
  }
  const db = new Database(DB_FILE, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const store = createStore(db);
    const tasks = await loadTasks();
    const task = tasks.get('v2free-checkin');
    if (!task) throw new BrowserError('未找到 v2free 签到模板');
    const target = resolveBrowserTarget(db, store, { username: values.user, label: values.account, task });
    const browserProvider = createBrowserProvider({
      endpoint: values.endpoint, profileDir: path.resolve(values['profile-dir']),
      ...target, groupName: task.credentialGroup,
    });
    const config = loadConfig();
    const userSecrets = createUserSecrets(db, config.masterKey);
    const execute = createExecutor({ store, secretsLoader: secretsLoaderFor(userSecrets), browserProvider });
    const run = await execute({ ...task, timeoutMs: 180_000 }, { ...target, trigger: 'manual' });
    console.log(JSON.stringify({ runId: run.id, status: run.status, message: run.message,
      date: run.date, transport: run.data?.transport ?? 'browser',
      lastCheckin: run.data?.lastCheckin ?? null }, null, 2));
    return ['success', 'already-signed'].includes(run.status) ? 0 : 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err instanceof BrowserError ? err.message : 'WeAuto 浏览器验证失败；未输出原始异常或凭据');
    process.exit(1);
  });
}
