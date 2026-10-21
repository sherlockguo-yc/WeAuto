/**
 * 找 WorkBuddy 客户端的纯函数测试
 *
 * 这段逻辑只在 Windows 上真正跑，开发机是 macOS——**改坏了本地发现不了**，
 * 用户那边看到的是「✗ 没找到 WorkBuddy 客户端」，而客户端其实好好装在 D 盘。
 * 所以候选列表与「多份安装挑哪个」都做成可注入的纯函数，在这里钉住：
 *   · 盘符必须真的被枚举（以前只有 C 盘，D 盘用户直接卡死）
 *   · 自定义目录靠「一级目录 × WorkBuddy」兜住（D:\Soft\WorkBuddy）
 *   · 卸不干净的旧安装不能抢走启动权（按 mtime 取最新）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hintsFromOutput, PS_HINTS, pickNewest, scanTree, windowsCandidates } from '../scripts/grab-workbuddy-token.mjs';

/** 假的目录列表：把 dirs 变成 readdirSync 的返回值 */
const fakeReaddir = (map) => (root) => {
  if (!(root in map)) throw new Error(`ENOENT: ${root}`);
  return map[root].map((name) => ({ name, isDirectory: () => !name.includes('.') }));
};

/* 递归扫描用的假条目：名字决定它是目录还是文件，目录可以显式标成链接 */
const dirEntry = (name, { link = false } = {}) => ({
  name,
  isDirectory: () => true,
  isSymbolicLink: () => link,
});
const fileEntry = (name) => ({ name, isDirectory: () => false, isSymbolicLink: () => false });

/** 递归扫描用的假目录：值本身就是条目对象数组 */
const fakeEntries = (map) => (root) => {
  if (!(root in map)) throw new Error(`ENOENT: ${root}`);
  return map[root];
};

const DRIVES = ['C:\\', 'D:\\'];

describe('windowsCandidates', () => {
  it('每个存在的盘都试常见目录，不再只有 C 盘', () => {
    const list = windowsCandidates({ drives: DRIVES, readdir: fakeReaddir({}) });

    for (const drive of ['C:', 'D:']) {
      assert.ok(list.includes(`${drive}\\WorkBuddy\\WorkBuddy.exe`), `${drive} 盘根目录`);
      assert.ok(list.includes(`${drive}\\Program Files\\WorkBuddy\\WorkBuddy.exe`), `${drive} Program Files`);
      assert.ok(list.includes(`${drive}\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe`), `${drive} Program Files (x86)`);
      assert.ok(list.includes(`${drive}\\Programs\\WorkBuddy\\WorkBuddy.exe`), `${drive} Programs`);
    }
  });

  it('自定义目录靠一级通配兜住：D:\\Soft\\WorkBuddy', () => {
    const list = windowsCandidates({
      drives: ['D:\\'],
      readdir: fakeReaddir({ 'D:\\': ['Soft', 'Games', 'note.txt'] }),
    });

    assert.ok(list.includes('D:\\Soft\\WorkBuddy\\WorkBuddy.exe'));
    assert.ok(list.includes('D:\\Games\\WorkBuddy\\WorkBuddy.exe'));
    assert.ok(
      !list.some((p) => p.includes('note.txt')),
      '文件不是目录，不该被当成候选',
    );
  });

  it('同一个位置只出现一次（标准目录与通配会重叠）', () => {
    const list = windowsCandidates({
      drives: ['D:\\'],
      readdir: fakeReaddir({ 'D:\\': ['Apps'] }), // Apps 同时在标准目录里
    });

    const hits = list.filter((p) => p === 'D:\\Apps\\WorkBuddy\\WorkBuddy.exe');
    assert.equal(hits.length, 1);
  });

  it('盘读不出来（空光驱、拔掉的 U 盘）时只跳过该盘，不抛错', () => {
    const list = windowsCandidates({
      drives: ['E:\\'],
      readdir: () => {
        throw new Error('EBUSY');
      },
    });

    assert.ok(list.includes('E:\\WorkBuddy\\WorkBuddy.exe'), '标准目录仍然要试');
    assert.equal(list.length, 5, '没有通配结果，只剩 5 条标准目录');
  });

  it('没有盘符时返回空列表，而不是 undefined', () => {
    assert.deepEqual(windowsCandidates({ drives: [], readdir: fakeReaddir({}) }), []);
  });
});

describe('pickNewest', () => {
  const mtime = (map) => (p) => map[p] ?? 0;

  it('多份安装取修改时间最新的那份', () => {
    const old = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
    const fresh = 'D:\\Soft\\WorkBuddy\\WorkBuddy.exe';
    const chosen = pickNewest([old, fresh], mtime({ [old]: 1000, [fresh]: 2000 }));
    assert.equal(chosen, fresh);
  });

  it('只有一份时原样返回', () => {
    assert.equal(pickNewest(['only'], () => 0), 'only');
  });

  it('不修改传入的数组', () => {
    const input = ['a', 'b'];
    pickNewest(input, (p) => (p === 'a' ? 1 : 2));
    assert.deepEqual(input, ['a', 'b']);
  });
});

describe('PS_HINTS（模板字符串的转义）', () => {
  // 反斜杠在「JS 模板 → PowerShell 源码」这一层要转义一次，
  // 写多写少都不会报错，只会让这段脚本在 Windows 上静默失效——所以在这里钉死。
  const BS = String.fromCharCode(92);
  const regPath = (parts) => parts.join(BS);

  it('注册表键是单反斜杠路径（不是双写）', () => {
    const common = ['SOFTWARE', 'Microsoft', 'Windows', 'CurrentVersion', 'App Paths', 'WorkBuddy.exe'];
    for (const root of ['HKLM:', 'HKCU:']) {
      assert.ok(PS_HINTS.includes(`'${regPath([root, ...common])}'`), `${root} App Paths`);
    }
    assert.ok(
      PS_HINTS.includes(`'${regPath(['HKLM:', 'SOFTWARE', 'WOW6432Node', ...common.slice(1)])}'`),
      'WOW6432Node',
    );
    assert.ok(!PS_HINTS.includes(`${BS}${BS}SOFTWARE`), '键路径里不该出现双反斜杠');
  });

  it('文件名匹配用 Split-Path，不依赖正则转义', () => {
    assert.ok(PS_HINTS.includes("-eq 'WorkBuddy.exe'"), '按叶子文件名比对');
    assert.ok(!PS_HINTS.includes('-match'), '不该再用正则匹配路径');
  });

  it('快捷方式目录走 [Environment]::GetFolderPath，不拼死路径', () => {
    assert.ok(PS_HINTS.includes("[Environment]::GetFolderPath('CommonStartMenu')"));
    assert.ok(PS_HINTS.includes("[Environment]::GetFolderPath('CommonDesktopDirectory')"));
  });

  it('最后一定产出 JSON（Node 侧按 JSON 解析）', () => {
    assert.match(PS_HINTS, /ConvertTo-Json/);
  });
});

describe('hintsFromOutput', () => {
  it('数组形态（多数路径）', () => {
    const out = '["D:\\\\Soft\\\\WorkBuddy\\\\WorkBuddy.exe","C:\\\\WorkBuddy\\\\WorkBuddy.exe"]';
    assert.deepEqual(hintsFromOutput(out), [
      'D:\\Soft\\WorkBuddy\\WorkBuddy.exe',
      'C:\\WorkBuddy\\WorkBuddy.exe',
    ]);
  });

  it('只有一条时 PowerShell 会退化成字符串', () => {
    assert.deepEqual(hintsFromOutput('"D:\\\\WorkBuddy\\\\WorkBuddy.exe"'), ['D:\\WorkBuddy\\WorkBuddy.exe']);
  });

  it('没有命中时返回空数组', () => {
    assert.deepEqual(hintsFromOutput('[]'), []);
    assert.deepEqual(hintsFromOutput(''), []);
    assert.deepEqual(hintsFromOutput(undefined), []);
  });

  it('PowerShell 被策略拦掉时不抛错，只从错误文本里捡出可用路径', () => {
    const noisy = '无法加载文件，因为在此系统上禁止运行脚本\r\nD:\\Soft\\WorkBuddy\\WorkBuddy.exe\r\n';
    assert.deepEqual(hintsFromOutput(noisy), ['D:\\Soft\\WorkBuddy\\WorkBuddy.exe']);
  });
});

describe('scanTree（兜底递归）', () => {
  it('根目录下的客户端能直接找到', () => {
    const readdir = fakeEntries({
      'D:\\': [dirEntry('WorkBuddy')],
      'D:\\WorkBuddy': [fileEntry('WorkBuddy.exe')],
    });
    assert.equal(scanTree({ roots: ['D:\\'], readdir }), 'D:\\WorkBuddy\\WorkBuddy.exe');
  });

  it('不限深度：装在第三层目录也能找到', () => {
    const readdir = fakeEntries({
      'D:\\': [dirEntry('soft')],
      'D:\\soft': [dirEntry('tools')],
      'D:\\soft\\tools': [dirEntry('wb')],
      'D:\\soft\\tools\\wb': [fileEntry('WorkBuddy.exe')],
    });
    assert.equal(scanTree({ roots: ['D:\\'], readdir }), 'D:\\soft\\tools\\wb\\WorkBuddy.exe');
  });

  it('跳过系统目录与 node_modules，不进这些子树', () => {
    const visited = [];
    const readdir = (dir) => {
      visited.push(dir);
      const map = {
        'C:\\': [dirEntry('Windows'), dirEntry('$Recycle.Bin'), dirEntry('node_modules'), dirEntry('Apps')],
        'C:\\Apps': [dirEntry('WorkBuddy')],
        'C:\\Apps\\WorkBuddy': [fileEntry('WorkBuddy.exe')],
      };
      if (!(dir in map)) throw new Error('ENOENT');
      return map[dir];
    };

    assert.equal(scanTree({ roots: ['C:\\'], readdir }), 'C:\\Apps\\WorkBuddy\\WorkBuddy.exe');
    assert.ok(!visited.some((d) => /windows|recycle|node_modules/i.test(d)), `不该进入：${visited}`);
  });

  it('不跟符号链接（junction 会成环）', () => {
    const readdir = fakeEntries({
      'D:\\': [dirEntry('link', { link: true })],
      'D:\\link': [fileEntry('WorkBuddy.exe')],
    });
    assert.equal(scanTree({ roots: ['D:\\'], readdir }), null);
  });

  it('没权限的目录跳过，不中断整个扫描', () => {
    const readdir = (dir) => {
      if (dir === 'D:\\locked') throw new Error('EACCES');
      if (dir === 'D:\\') return [dirEntry('locked'), dirEntry('Apps')];
      if (dir === 'D:\\Apps') return [fileEntry('WorkBuddy.exe')];
      throw new Error('ENOENT');
    };
    assert.equal(scanTree({ roots: ['D:\\'], readdir }), 'D:\\Apps\\WorkBuddy.exe');
  });

  it('超时返回 null，把决定权交回给人', () => {
    let t = 0;
    const readdir = fakeEntries({ 'D:\\': [dirEntry('a')], 'D:\\a': [dirEntry('b')], 'D:\\a\\b': [dirEntry('c')] });
    const found = scanTree({ roots: ['D:\\'], readdir, maxMs: 100, now: () => (t += 60) });
    assert.equal(found, null);
  });

  it('扫完整棵树都没有时返回 null', () => {
    const readdir = fakeEntries({ 'D:\\': [dirEntry('a')], 'D:\\a': [fileEntry('readme.txt')] });
    assert.equal(scanTree({ roots: ['D:\\'], readdir }), null);
  });
});
