/**
 * 运行期配置
 *
 * 两项配置刻意放在 `data/` 而不是仓库或环境变量里：
 *
 *   1. **`.env`** —— deploy-agent 用 `rsync -a --delete --exclude data --exclude .env`
 *      同步部署目录。放 data/ 下既不会被部署覆盖，也不会进 Git。
 *   2. **`jwt-secret`** —— 首次启动自动生成并落盘。
 *      · 不能放进 Git（泄漏即等于所有人的会话可被伪造）
 *      · 也不能每次部署重新生成（那会让所有登录态被动失效）
 *      所以必须持久化在「跟机器绑定、不随部署变化」的位置。data/ 正好是它。
 *
 * 环境变量仍然优先（便于临时覆盖与测试）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, parseDotenv } from './util.mjs';

export const ENV_FILE = path.join(DATA_DIR, '.env');
export const SECRET_FILE = path.join(DATA_DIR, 'jwt-secret');

export const DEFAULT_PORT = 18991;

/** 读取 KEY=VALUE 文件；不存在或读不了都返回空对象（降级而不是报错） */
export function readEnvFile(file = ENV_FILE) {
  try {
    return parseDotenv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 取 JWT secret：环境变量 > 文件 > 首次生成。
 * 生成的文件权限收到 600（同机器上的其它用户读不到）。
 */
export function loadJwtSecret({ env = process.env, file = SECRET_FILE } = {}) {
  if (env.WEAUTO_JWT_SECRET) return env.WEAUTO_JWT_SECRET;

  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* 不存在 → 下面生成 */
  }

  const secret = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

/**
 * 登录限速参数。登录口是公网可达的，必须有兜底。
 * 内存实现即可：常驻单进程，重启后计数清零是可以接受的代价。
 */
export const LOGIN_RATE_LIMIT = { windowMs: 15 * 60_000, maxFailures: 10 };

export function loadConfig({ env = process.env } = {}) {
  const fileEnv = readEnvFile(env.WEAUTO_ENV_FILE || ENV_FILE);
  const pick = (key, fallback) => env[key] ?? fileEnv[key] ?? fallback;

  const port = Number(pick('WEAUTO_PORT', DEFAULT_PORT));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    // 端口写错会让服务在部署后完全连不上，宁可在启动时报错
    throw new Error(`WEAUTO_PORT 非法：${pick('WEAUTO_PORT', DEFAULT_PORT)}`);
  }

  return {
    port,
    host: pick('WEAUTO_HOST', '0.0.0.0'),
    jwtSecret: loadJwtSecret({ env }),
    tokenTtl: pick('WEAUTO_TOKEN_TTL', '7d'),
    /** 是否只在 HTTPS 下带 cookie。经 Cloudflare Tunnel 时由代理头判断 */
    trustProxy: true,
    envFile: ENV_FILE,
  };
}
