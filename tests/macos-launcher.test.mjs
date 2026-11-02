/**
 * macOS 启动器（`scripts/grab-workbuddy-token.sh`）的测试。
 *
 * 和 Windows 那份不同，这个脚本**能在本机真跑**（bash + curl 都是系统自带的），
 * 所以除了静态检查，还起一个假服务器把「取脚本 → 透传参数 → 跑起来 → 删临时文件」
 * 整条链路走一遍。只有「真的去下载 50MB Node」那一步没法测，用假 node 顶替。
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/grab-workbuddy-token.sh', import.meta.url));
const SRC = fs.readFileSync(SCRIPT, 'utf8');
/** 脚本里声明的自举版本：测试不要自己再抄一份，否则改版本就得改两处 */
const NODE_VER = /^NODE_VER="(.+)"$/m.exec(SRC)[1];
/** 解压目录名里的架构（与脚本里 uname -m 的映射一致） */
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

/** 把脚本的三个锚点替换成测试用的值，得到一份可直接跑的副本 */
function stage({ server, pushToken = '', grabber = 'stub.mjs' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-sh-'));
  const file = path.join(dir, 'update-workbuddy-token.sh');
  const text = SRC.replace('SERVER=""', `SERVER="${server}"`)
    .replace('PUSH_TOKEN=""', `PUSH_TOKEN="${pushToken}"`)
    .replace('GRABBER=""', `GRABBER="${grabber}"`);
  fs.writeFileSync(file, text);
  return { dir, file };
}

/** 假服务器：不管请求什么，都返回一个「只把参数打出来」的脚本 */
async function stubServer() {
  const body = "console.log('ARGS ' + JSON.stringify(process.argv.slice(2)));\n";
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

function run(file, args = [], env = process.env) {
  return new Promise((resolve) => {
    execFile('bash', [file, ...args], { env, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

describe('macOS 启动器（shell 脚本）', () => {
  it('bash 语法正确，且是 LF', () => {
    // CRLF 会让 bash 报 bad interpreter——这个文件不是批处理，不能跟着 Windows 走
    assert.doesNotMatch(SRC, /\r/);
    execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' });
    assert.match(SRC, /^#!\/usr\/bin\/env bash\n/);
  });

  it('三个注入锚点各出现一次（服务端按它替换，重复就注错行）', () => {
    for (const anchor of ['SERVER=""', 'PUSH_TOKEN=""', 'GRABBER=""']) {
      assert.equal(SRC.split(anchor).length - 1, 1, `${anchor} 必须恰好出现一次`);
    }
  });

  it('自举 Node：镜像优先、官方兜底、解压后还要试跑一次', () => {
    const mirror = SRC.indexOf('npmmirror.com');
    const official = SRC.indexOf('nodejs.org/dist');
    assert.ok(mirror > 0 && official > 0, '两个源都要有');
    assert.ok(mirror < official, '大陆优先镜像');
    assert.match(SRC, /tar -xzf/);
    // 装到用户自己的目录：不要 sudo、不写 /usr/local
    assert.match(SRC, /NODE_ROOT="\$HOME\/\.weauto"/);
    assert.doesNotMatch(SRC, /^\s*sudo\b/m, '不该要求管理员权限（说明文字里提 sudo 没关系）');
    assert.match(SRC, /\[ "\$v" -ge 18 \]/, '18 以下的老版本没有全局 fetch');
  });

  it('本机 node 能用就直接用：取脚本、透传参数、跑完删临时文件', async () => {
    const srv = await stubServer();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-tmp-'));
    const { dir, file } = stage({ server: srv.url, pushToken: 'wt2_1_2_token' });
    try {
      const out = await run(file, ['--print'], { ...process.env, TMPDIR: tmp });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /ARGS \["--print"\]/);
      assert.deepEqual(fs.readdirSync(tmp), [], '临时脚本用完必须删掉');
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('不带参数时用内嵌的服务器与令牌（页面上的「双击式」体验）', async () => {
    const srv = await stubServer();
    const { dir, file } = stage({ server: srv.url, pushToken: 'wt2_1_2_token' });
    try {
      const out = await run(file);
      assert.equal(out.code, 0, out.stderr);
      assert.ok(out.stdout.includes(`"--push","${srv.url}","--push-token","wt2_1_2_token"`), out.stdout);
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PATH 上的 node 太旧时，改用之前自举的那份（不再下载）', async () => {
    const srv = await stubServer();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-home-'));
    // 假的便携版：真的去下载 50MB 没法在测试里做，用一个转发到当前 node 的壳
    const bin = path.join(home, '.weauto', `node-${NODE_VER}-darwin-${ARCH}`, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    // 伪装成老版本：node_ok 必须认出版本不够，否则会拿它去跑抓取脚本
    const shim = path.join(home, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'node'), '#!/bin/sh\necho v14.21.3\n', { mode: 0o755 });

    const { dir, file } = stage({ server: srv.url });
    try {
      const out = await run(file, [], {
        ...process.env,
        HOME: home,
        PATH: `${shim}:/usr/bin:/bin:/usr/sbin:/sbin`,
      });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /ARGS \[\]/);
      assert.doesNotMatch(out.stdout, /下载 Node\.js|准备一份 Node\.js/, '不该再下载一份');
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('没有内嵌服务器地址时明确报错，而不是静默失败', async () => {
    const { dir, file } = stage({ server: '' });
    try {
      const out = await run(file);
      assert.equal(out.code, 1);
      assert.match(out.stdout, /没有内嵌服务器地址/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
