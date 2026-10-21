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
import { pickNewest, windowsCandidates } from '../scripts/grab-workbuddy-token.mjs';

/** 假的目录列表：把 dirs 变成 readdirSync 的返回值 */
const fakeReaddir = (map) => (root) => {
  if (!(root in map)) throw new Error(`ENOENT: ${root}`);
  return map[root].map((name) => ({ name, isDirectory: () => !name.includes('.') }));
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
