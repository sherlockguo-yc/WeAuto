#!/usr/bin/env node
/**
 * WeAuto 常驻服务入口
 *
 *   node bin/weauto-serve.mjs
 *
 * 组件装配全部集中在这里（其余模块只暴露「创建函数」，自己不读环境变量）：
 *   数据库 → 任务注册表 → 账号 → 执行器 → 调度器 → HTTP 服务
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { DB_FILE, openDb } from '../src/db.mjs';
import { bootstrapTenancy, pickOwnerId } from '../src/bootstrap.mjs';
import { createExecutor } from '../src/executor.mjs';
import { loadTasks } from '../src/registry.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { createServer } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';
import { createUserSecrets } from '../src/user-secrets.mjs';
import { createAuth } from '../src/auth/index.mjs';
import { DATA_DIR, ROOT } from '../src/util.mjs';

const DAY_MS = 86_400_000;

function readVersion() {
  try {
    return fs.readFileSync(path.join(ROOT, '.version'), 'utf8').trim();
  } catch {
    return 'dev';
  }
}

/** 进程静默消失是这类常驻服务最难查的故障，所以异常要落盘而不只是进 stderr */
function installCrashLogger() {
  const file = path.join(DATA_DIR, 'crash.log');
  const write = (msg) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`);
    } catch {
      /* 连日志都写不进去就只能放弃 */
    }
  };
  process.on('uncaughtException', (err) => write(`uncaughtException: ${err?.stack || err}`));
  process.on('unhandledRejection', (err) => write(`unhandledRejection: ${err?.stack || err}`));
}

async function main() {
  installCrashLogger();
  process.env.WEAUTO_VERSION = process.env.WEAUTO_VERSION || readVersion();

  const config = loadConfig();
  const db = openDb();
  const store = createStore(db);
  const tasks = await loadTasks();

  const auth = createAuth({ db, jwtSecret: config.jwtSecret, tokenTtl: config.tokenTtl });

  // 每用户凭据：主密钥在 data/ 下，首次启动自动生成（丢了会让所有人重填凭据）
  const userSecrets = createUserSecrets(db, config.masterKey);

  // 首次升级到多租户时，把「这台机器」的历史数据归给第一个账号
  const ownerId = pickOwnerId(db);
  if (ownerId) {
    const migrated = bootstrapTenancy({
      db,
      store,
      userSecrets,
      tasks,
      ownerId,
      log: (m) => console.log(m),
    });
    if (migrated.notes?.length) {
      for (const n of migrated.notes) console.log(`[bootstrap] ${n}`);
    }
  }

  const scheduler = createScheduler({
    store,
    tasks,
    execute: createExecutor({ store, log: (m) => console.log(m) }),
    log: (m) => console.log(m),
  });
  const app = createServer({ store, auth, tasks, scheduler, config });

  const server = app.listen(config.port, config.host, () => {
    const users = auth.countUsers();
    console.log(`[weauto] HTTP 已启动 http://${config.host}:${config.port}`);
    console.log(`[weauto] 版本 ${process.env.WEAUTO_VERSION}，任务 ${tasks.size} 个，账号 ${users} 个`);
    console.log(`[weauto] 数据库 ${DB_FILE}`);
    if (users === 0) console.log('[weauto] 还没有账号：打开首页会引导创建第一个管理员');
  });

  scheduler.start();

  /** 保留策略：启动后半分钟跑一次，之后每天一次。多租户后要按用户分别清理 */
  const pruneAll = () => {
    for (const userId of store.allUserIds()) {
      for (const task of tasks.values()) {
        try {
          const res = store.forUser(userId).pruneTask(task.name, task.retention);
          if (res.dropped) {
            console.log(`[prune] #${userId} ${task.name} 清理 ${res.dropped} 条明细，聚合 ${res.aggregated} 天`);
          }
        } catch (err) {
          console.error(`[prune] #${userId} ${task.name} 清理失败：${err.message}`);
        }
      }
    }
  };
  setTimeout(pruneAll, 30_000).unref();
  setInterval(pruneAll, DAY_MS).unref();

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[weauto] 收到 ${signal}，正在退出`);
    scheduler.stop();
    server.close();
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`[weauto] 启动失败：${err.message}`);
  process.exit(1);
});
