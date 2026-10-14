/**
 * 凭据加载：调用 age 二进制解密 secrets.age 到内存，明文不落盘
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AGE_KEY_FILE, parseDotenv, resolveSecretsFile } from './util.mjs';

/**
 * 解析 age 可执行文件路径
 *
 * 不能只依赖 PATH：cron 与非交互式 shell 的 PATH 通常不含 ~/.local/bin，
 * 而 restart.sh 正是把 age 装在那里（首次部署即因此报 config-error）。
 * 故按「环境变量 → PATH → 常见安装位置」依次探测。
 */
export function resolveAgeBin() {
  if (process.env.WEAUTO_AGE_BIN) return process.env.WEAUTO_AGE_BIN;
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = path.join(dir, 'age');
    if (isFile(candidate)) return candidate;
  }
  for (const candidate of [
    path.join(process.env.HOME ?? '', '.local', 'bin', 'age'),
    '/usr/local/bin/age',
    '/opt/homebrew/bin/age',
  ]) {
    if (isFile(candidate)) return candidate;
  }
  return 'age'; // 兜底：交给 execFileSync 抛 ENOENT，由上层转成清晰的错误
}

export class SecretsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretsError';
  }
}

/**
 * 解密并校验凭据
 * @param {string[]} required 必需字段名
 * @returns {Record<string, string>}
 */
export function loadSecrets(required = []) {
  // 权威在 data/，仓库根目录那份只是首次部署的种子（详见 util.resolveSecretsFile）
  const secretsFile = resolveSecretsFile();
  if (!fs.existsSync(secretsFile)) {
    throw new SecretsError(`找不到密文文件 ${secretsFile}（请先执行 age 加密流程）`);
  }
  if (!fs.existsSync(AGE_KEY_FILE)) {
    throw new SecretsError(`找不到 age 私钥 ${AGE_KEY_FILE}`);
  }

  let plain;
  try {
    plain = execFileSync(resolveAgeBin(), ['-d', '-i', AGE_KEY_FILE, secretsFile], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new SecretsError('未找到 age 命令，请先安装（见 README「安装 age」）');
    }
    const detail = (err.stderr || '').toString().trim() || err.message;
    throw new SecretsError(`age 解密失败：${detail}`);
  }

  const secrets = parseDotenv(plain);
  const missing = required.filter((k) => !secrets[k]);
  if (missing.length) {
    throw new SecretsError(`凭据缺少必需字段：${missing.join(', ')}`);
  }
  return secrets;
}
