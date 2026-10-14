/**
 * 凭据读写测试（用真实的 age 二进制跑，不是模拟）
 *
 * 这里守的是「网页改密码」这条路的正确性：
 *   · 合并写入 —— 改一个字段不能把别的字段弄丢
 *   · 空值不修改 —— 界面上留空的输入框不能把已有凭据清空
 *   · 原子写 —— 失败时不能留下半个密文文件（那会让所有任务同时 config-error）
 *
 * 若环境里没有 age，整组跳过（CI 上不保证装了 age，但本机必须跑过）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

function has(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const AGE_OK = has('age') && has('age-keygen');

let dir;
let keyFile;
let secretsFile;
let cred;
let saveEnv;

before(async () => {
  if (!AGE_OK) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-creds-'));
  keyFile = path.join(dir, 'key');
  execFileSync('age-keygen', ['-o', keyFile], { stdio: 'ignore' });

  const pub = execFileSync('age-keygen', ['-y', keyFile], { encoding: 'utf8' }).trim();
  secretsFile = path.join(dir, 'secrets.age');
  // -r 是收件人字符串；-R 是收件人文件，用错会报 failed to parse recipient file
  execFileSync('age', ['-e', '-r', pub, '-o', secretsFile], {
    input: 'A=1\nB=two\n',
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  // 这两个常量在模块加载时就读环境变量，所以必须在 import 之前设置好
  saveEnv = { WEAUTO_AGE_KEY: process.env.WEAUTO_AGE_KEY, WEAUTO_SECRETS: process.env.WEAUTO_SECRETS };
  process.env.WEAUTO_AGE_KEY = keyFile;
  process.env.WEAUTO_SECRETS = secretsFile;
  cred = await import('../src/credentials.mjs');
});

after(() => {
  // before 若中途失败，saveEnv 可能还没赋值 —— 清理钩子不该再抛错掩盖真正的失败原因
  if (!AGE_OK || !saveEnv) return;
  for (const [k, v] of Object.entries(saveEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('凭据读写', { skip: AGE_OK ? false : '环境缺少 age，跳过' }, () => {
  it('读出字段（值只在服务端内存里）', () => {
    assert.deepEqual(cred.readSecrets(), { A: '1', B: 'two' });
    assert.deepEqual(cred.listFieldNames(), ['A', 'B']);
  });

  it('改一个字段做合并，不丢其它字段', () => {
    const keys = cred.writeSecrets({ A: '9' });
    assert.deepEqual(keys.sort(), ['A', 'B']);
    assert.deepEqual(cred.readSecrets(), { A: '9', B: 'two' });
  });

  it('空值表示不修改（界面上留空不能把凭据清掉）', () => {
    cred.writeSecrets({ A: 'keep-me' });
    cred.writeSecrets({ A: '', B: '' });
    assert.equal(cred.readSecrets().A, 'keep-me');
  });

  it('可以新增字段', () => {
    cred.writeSecrets({ C: 'three' });
    assert.deepEqual(cred.readSecrets(), { A: 'keep-me', B: 'two', C: 'three' });
  });

  it('写入后不留临时文件（原子替换）', () => {
    cred.writeSecrets({ A: 'x' });
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('密文缺失时报的是可读原因，而不是一堆堆栈', () => {
    // 注意：私钥路径（AGE_KEY_FILE）在模块加载时就定下来了，运行时改环境变量无效；
    // 而密文路径是每次调用时解析的，所以这条路径可以在测试里触发。
    const prev = process.env.WEAUTO_SECRETS;
    process.env.WEAUTO_SECRETS = path.join(dir, 'nope.age');
    try {
      assert.throws(() => cred.readSecrets(), /找不到密文文件/);
    } finally {
      process.env.WEAUTO_SECRETS = prev;
    }
  });
});
