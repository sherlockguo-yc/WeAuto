/**
 * 凭据读写（网页可写）
 *
 * 存储形式与命令行时代一致：`secrets.age` 密文，明文只在内存里出现一瞬。
 * 这样「改密码」不需要引入第二套凭据存储，**权威只有一份**。
 *
 * 加密用的「收件人公钥」不在任何配置里：直接由本机私钥推导
 * （age-keygen -y）。少一个要维护的配置项，也就少一处配错的可能。
 *
 * 写入是**原子**的：先写临时文件再 rename。中途失败不会留下半个密文文件 ——
 * 那会导致所有任务同时 config-error，是最难恢复的一类故障。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SecretsError, resolveAgeBin } from './secrets.mjs';
import { AGE_KEY_FILE, SECRETS_FILE, parseDotenv, resolveSecretsFile } from './util.mjs';

function ageKeygenBin() {
  const bin = resolveAgeBin();
  return bin.replace(/age$/, 'age-keygen');
}

/** 由私钥推导公钥（加密收件人） */
export function recipientFromKey() {
  if (!fs.existsSync(AGE_KEY_FILE)) {
    throw new SecretsError(`找不到 age 私钥 ${AGE_KEY_FILE}`);
  }
  try {
    return execFileSync(ageKeygenBin(), ['-y', AGE_KEY_FILE], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    throw new SecretsError(`推导 age 公钥失败：${(err.stderr || '').toString().trim() || err.message}`);
  }
}

/** 读取用：优先 data/ 里的权威副本，退化到仓库里的种子 */
function sourceFile() {
  return resolveSecretsFile();
}

/** 写入用：永远写 data/ 下的权威位置（或环境变量指定的路径） */
function targetFile() {
  return process.env.WEAUTO_SECRETS || SECRETS_FILE;
}

function decryptToText() {
  const file = sourceFile();
  if (!fs.existsSync(file)) {
    throw new SecretsError(`找不到密文文件 ${file}`);
  }
  try {
    return execFileSync(resolveAgeBin(), ['-d', '-i', AGE_KEY_FILE, file], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new SecretsError('未找到 age 命令，请先安装（见 README）');
    }
    throw new SecretsError(`age 解密失败：${(err.stderr || '').toString().trim() || err.message}`);
  }
}

/** 解出全部明文字段。**只应在服务端内部使用，绝不外传** */
export function readSecrets() {
  return parseDotenv(decryptToText());
}

/** 只给界面用的字段名清单（不含值） */
export function listFieldNames() {
  return Object.keys(readSecrets());
}

function serialize(values) {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n')
    .concat('\n');
}

/**
 * 合并写入若干字段。
 *
 * @param {Record<string,string>} patch 字段改动；**空字符串表示该字段不修改**，
 *        这样界面上「留空 = 不改」是安全的，不会因为一个空输入框把凭据清空。
 * @returns {string[]} 写入后的全部字段名
 */
export function writeSecrets(patch = {}) {
  const current = readSecrets();
  let changed = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (value === '' || value === undefined || value === null) continue;
    if (current[key] !== value) changed += 1;
    current[key] = value;
  }
  if (!changed) return Object.keys(current);

  const recipient = recipientFromKey();
  const outFile = targetFile();
  const tmp = `${outFile}.tmp`;

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    // 注意是 -r（收件人字符串）而不是 -R（收件人文件路径）：
    // 混用会得到「failed to parse recipient file」这种指向错误的报错
    execFileSync(resolveAgeBin(), ['-e', '-r', recipient, '-o', tmp], {
      input: serialize(current),
      timeout: 10_000,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    // 原子替换：先写临时文件再 rename，中途失败不会留下半个密文
    fs.renameSync(tmp, outFile);
    fs.chmodSync(outFile, 0o600);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件本来就不存在 */
    }
    throw new SecretsError(`写入凭据失败：${(err.stderr || '').toString().trim() || err.message}`);
  }

  return Object.keys(current);
}
