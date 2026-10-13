/**
 * 凭据加载：调用 age 二进制解密 secrets.age 到内存，明文不落盘
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { AGE_KEY_FILE, SECRETS_FILE, parseDotenv } from './util.mjs';

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
  if (!fs.existsSync(SECRETS_FILE)) {
    throw new SecretsError(`找不到密文文件 ${SECRETS_FILE}（请先执行 age 加密流程）`);
  }
  if (!fs.existsSync(AGE_KEY_FILE)) {
    throw new SecretsError(`找不到 age 私钥 ${AGE_KEY_FILE}`);
  }

  let plain;
  try {
    plain = execFileSync('age', ['-d', '-i', AGE_KEY_FILE, SECRETS_FILE], {
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
