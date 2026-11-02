/**
 * Windows 启动器（`src/launcher.mjs` 生成的批处理）的静态检查。
 *
 * CI 跑在 Linux 上，这份 `.cmd` 没法真的执行，所以只能把「不该出现的东西」钉成
 * 断言。踩过的雷都在这里：
 *   · 正文混进非 ASCII（`chcp 65001` 失败时中文变乱码，严重时连解析都错）
 *   · goto / call 指向不存在的标签（批处理不会报错，只会静默跑到文件尾）
 *   · 本机没装 Node 就直接退出，把用户堵死在第一步
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAUNCHER_FILE, NODE_BOOTSTRAP_VER, launcherCmd } from '../src/launcher.mjs';

const SERVER = 'https://weauto.example.com';
const PAIRING = {
  server: SERVER,
  pushToken: 'wt2_1_2_abcdefghijklmnopqrstuv',
  helper: { download: 'grab-workbuddy-token.mjs' },
};

describe('Windows 启动器（批处理正文）', () => {
  const cmd = launcherCmd(PAIRING);

  it('纯 ASCII + CRLF', () => {
    assert.match(LAUNCHER_FILE, /\.cmd$/);
    assert.ok(/^[\x00-\x7f]*$/.test(cmd), '正文不许出现非 ASCII：chcp 65001 失败的机器会乱码');
    assert.ok(cmd.startsWith('@echo off\r\n'), '必须从 @echo off 开始');
    assert.doesNotMatch(cmd, /(?<!\r)\n/, '每一行都必须以 CRLF 结尾');
  });

  it('goto / call 指向的标签都存在，且标签不重复', () => {
    const labels = [...cmd.matchAll(/^:([a-z_0-9]+)[ \t]*$/gim)].map((m) => m[1]);
    assert.ok(labels.length >= 6, '自举逻辑应该有若干子过程');
    assert.equal(new Set(labels).size, labels.length, '标签重复会让 goto 跳到错误的位置');

    const known = new Set([...labels, 'eof']);
    for (const target of [...cmd.matchAll(/\b(?:goto|call)[ \t]+:([a-z_0-9]+)/gi)].map((m) => m[1])) {
      assert.ok(known.has(target), `:${target} 没有定义——批处理不会报错，只会静默跑飞`);
    }
  });

  it('没装 Node 时自举一份便携版，而不是报错退出', () => {
    // 这是这条需求的全部要点：以前这里是一句 "Node.js 18+ is required" + exit /b 1
    assert.doesNotMatch(cmd, /Node\.js 18\+ is required/, '不许再把用户堵在这一步');
    assert.match(cmd, /^call :ensure_node$/m);
    assert.match(cmd, /^:install_node$/m);

    // 便携版只落在用户自己的目录：不需要管理员，也不动 PATH
    assert.match(cmd, /set "NODE_HOME=%LOCALAPPDATA%\\WeAuto\\node"/);
    assert.match(cmd, /set "NODE_CACHED=%NODE_HOME%\\%NODE_PKG%\\node.exe"/);
    assert.doesNotMatch(cmd, /msiexec/i, 'MSI 要提权，装不上就是死路');
    assert.doesNotMatch(cmd, /setx |set PATH=/i, '不许改用户环境变量');
  });

  it('自举走压缩包：镜像优先、官方兜底、解压不了还有 tar', () => {
    const mirror = cmd.indexOf('npmmirror.com');
    const official = cmd.indexOf('nodejs.org/dist');
    assert.ok(mirror > 0, '要有国内镜像');
    assert.ok(official > 0, '要有官方源兜底');
    assert.ok(mirror < official, '大陆优先镜像：官方源经常几十 KB/s');

    // URL 由 %NODE_VER% 拼出来，所以「版本常量」和「下载路径」天然只有一处
    assert.ok(cmd.includes(`set "NODE_VER=${NODE_BOOTSTRAP_VER}"`), '版本常量要写进文件');
    assert.match(cmd, /dist\/%NODE_VER%\/%NODE_PKG%\.zip/);
    assert.match(cmd, /Expand-Archive/);
    assert.match(cmd, /tar\.exe -xf/);
    // 下载失败必须删掉半截文件，否则下一个源会被"文件已存在"骗过去
    assert.match(cmd, /del "%DL_OUT%"/);
  });

  it('已经能用的 Node 就复用，版本不够才自举', () => {
    assert.match(cmd, /^for \/f "delims=" %%v in \('node -v 2\^>nul'\) do set "VER=%%v"$/m);
    assert.match(cmd, /if %MAJOR% LSS 18 goto :eof/);
    // 校验大版本号是数字：`node -v` 被 Store 占位程序污染时会输出非数字
    assert.match(cmd, /findstr \/r \/c:"\^\[0-9\]\[0-9\]\*\$"/);
  });

  it('有令牌就自动推送；没令牌只抓不推，留给网页粘贴', () => {
    assert.match(cmd, /^set "PUSH_TOKEN=wt2_1_2_[A-Za-z0-9_-]+"$/m);
    assert.match(cmd, /^"%NODE_EXE%" "%TMPFILE%" --push "%SERVER%" --push-token "%PUSH_TOKEN%"$/m);

    const loose = launcherCmd({ ...PAIRING, pushToken: null });
    assert.doesNotMatch(loose, /PUSH_TOKEN/, '没令牌就不该出现推送参数');
    assert.match(loose, /^"%NODE_EXE%" "%TMPFILE%"$/m);
  });

  it('脚本本体不塞进批处理，运行时从公开端点现取', () => {
    assert.ok(cmd.includes(`${SERVER}/api/tools/grab-workbuddy-token.mjs`));
    // PowerShell 被组策略压死（AllSigned）时退到 curl.exe
    assert.match(cmd, /curl\.exe -fsS -o "%TMPFILE%"/);
    // 自举彻底失败时给的是下一步怎么做，不是一句 error
    assert.match(cmd, /Install the LTS from https:\/\/nodejs\.org\//);
  });
});
