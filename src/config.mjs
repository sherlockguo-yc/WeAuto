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
import { KEY_LEN, generateMasterKey } from './user-secrets.mjs';

export const ENV_FILE = path.join(DATA_DIR, '.env');
export const SECRET_FILE = path.join(DATA_DIR, 'jwt-secret');
export const MASTER_KEY_FILE = path.join(DATA_DIR, 'master-key');

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
 * 取凭据主密钥：环境变量（base64）> 文件（base64）> 首次生成。
 *
 * 与 JWT secret 的区别在于**丢了会怎样**：
 *   · JWT secret 丢了 → 所有人重新登录，无持久损失
 *   · 主密钥丢了 → 所有用户的凭据永久解不开，只能让他们重填
 * 所以它和 data/ 一起受 rsync --exclude 保护，且权限 600。
 */
export function loadMasterKey({ env = process.env, file = MASTER_KEY_FILE } = {}) {
  const fromEnv = env.WEAUTO_MASTER_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== KEY_LEN) {
      throw new Error(`WEAUTO_MASTER_KEY 必须是 ${KEY_LEN} 字节的 base64`);
    }
    return buf;
  }

  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      const buf = Buffer.from(existing, 'base64');
      if (buf.length !== KEY_LEN) {
        throw new Error(`${file} 内容不是 ${KEY_LEN} 字节的 base64`);
      }
      return buf;
    }
  } catch (err) {
    // 文件不存在是正常情况（首次启动）；内容不合法必须炸掉，不能静默换新密钥
    if (err instanceof Error && !['ENOENT'].includes(err.code)) throw err;
  }

  const key = generateMasterKey();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600 });
  return key;
}

/**
 * 登录限速参数。登录口是公网可达的，必须有兜底。
 * 内存实现即可：常驻单进程，重启后计数清零是可以接受的代价。
 */
export const LOGIN_RATE_LIMIT = { windowMs: 15 * 60_000, maxFailures: 10 };

/**
 * 多租户下的资源上限（需求文档 §4.4，宽松档）。
 *
 * 存在这里的理由：这些是「运营参数」而不是「代码常量」，将来要调只需要改一处。
 * 由装配层（bin/weauto-serve.mjs）注入给 store / executor / scheduler，
 * 各模块自己不读环境变量。
 */
export const TENANT_LIMITS = {
  /** 每用户每天的执行次数上限（手动触发也算） */
  quotaPerDay: 100,
  /** 间隔任务的最小间隔，低于这个值拒绝保存 */
  minIntervalMinutes: 5,
  /** 每用户可订阅的模板数上限 */
  maxSubscriptions: 20,
  /** 全平台同时执行的任务数上限（保护 N150 出口 IP 不被一次打出几十路请求） */
  maxConcurrent: 4,
};

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
    masterKey: loadMasterKey({ env }),
    tokenTtl: pick('WEAUTO_TOKEN_TTL', '7d'),
    /** 是否只在 HTTPS 下带 cookie。经 Cloudflare Tunnel 时由代理头判断 */
    trustProxy: true,
    envFile: ENV_FILE,
  };
}
