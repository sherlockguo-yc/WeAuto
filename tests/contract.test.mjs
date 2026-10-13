/**
 * 跨仓库契约测试 —— 与 WeMonitor 的接口边界
 *
 * WeMonitor 的 `lib/api/auto.js` 依赖本仓库的三样东西，全部无法在编译期校验：
 *   1. `weauto list --json` 的输出结构
 *   2. data/runs.jsonl 的字段（见 WeMonitor tests/auto-contract.test.mjs 的 fixture）
 *   3. status 的取值集合
 *
 * 改动任一侧都可能静默 break（面板空白 / 历史不显示 / 状态文案错乱），
 * 所以这里把契约钉成断言：违反即失败，并显式提示需要同步 WeMonitor。
 *
 * 对应的消费者侧断言在 WeMonitor/tests/auto-contract.test.mjs。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SUCCESS_STATUSES } from '../src/history.mjs';
import { STATUS } from '../src/runner.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'weauto.mjs');

/** WeMonitor `public/js/auto.js` 的 AUTO_STATUS 映射所覆盖的状态 */
const CONTRACT_STATUSES = [
  'success',
  'already-signed',
  'skipped',
  'failed',
  'blocked',
  'network-error',
  'config-error',
];

const runCli = (args) =>
  execFileAsync(process.execPath, [CLI, ...args], { cwd: ROOT, timeout: 30_000 });

describe('契约：status 取值集合', () => {
  it('STATUS 的每个取值都在契约清单内', () => {
    for (const value of Object.values(STATUS)) {
      assert.ok(
        CONTRACT_STATUSES.includes(value),
        `新增状态 ${value} 必须同步 WeMonitor 的 AUTO_STATUS 映射（public/js/auto.js）`,
      );
    }
  });

  it('契约清单恰好等于 STATUS 的取值集合（不多不少）', () => {
    assert.deepEqual([...new Set(Object.values(STATUS))].sort(), [...CONTRACT_STATUSES].sort());
  });

  it('成功状态集合与契约一致（决定 WeMonitor 统计口径）', () => {
    assert.deepEqual([...SUCCESS_STATUSES].sort(), ['already-signed', 'success']);
  });
});

describe('契约：`weauto list --json` 输出结构', () => {
  it('顶层为 { tasks: [...] }，且每个任务带 WeMonitor 依赖的字段', async () => {
    const { stdout } = await runCli(['list', '--json']);
    const parsed = JSON.parse(stdout);

    assert.ok(Array.isArray(parsed.tasks), 'tasks 必须是数组');
    assert.ok(parsed.tasks.length >= 1, '至少应有一个已注册任务');

    for (const t of parsed.tasks) {
      for (const key of ['name', 'displayName', 'requires', 'file', 'window', 'target']) {
        assert.ok(key in t, `任务条目缺少字段 ${key}（WeMonitor 依赖它渲染状态卡）`);
      }
      assert.equal(typeof t.name, 'string');
      assert.ok(Array.isArray(t.requires));
      if (t.window) assert.deepEqual(Object.keys(t.window).sort(), ['end', 'start']);
      if (t.target) assert.deepEqual(Object.keys(t.target).sort(), ['date', 'remaining', 'targetLabel']);
    }
  });

  it('stdout 是纯 JSON（不得混入日志，否则 WeMonitor 解析失败）', async () => {
    const { stdout } = await runCli(['list', '--json']);
    assert.doesNotThrow(() => JSON.parse(stdout));
  });
});

describe('契约：CLI 的退出码与错误输出', () => {
  it('未知命令以退出码 1 结束', async () => {
    await assert.rejects(
      () => runCli(['definitely-not-a-command']),
      (err) => err.code === 1,
    );
  });

  it('未知任务以退出码 1 + 单行错误结束，且不把堆栈写进日志', async () => {
    await assert.rejects(
      () => runCli(['run', 'no-such-task']),
      (err) =>
        err.code === 1 &&
        /未知任务/.test(err.stderr) &&
        !/\n\s+at /.test(err.stderr),
    );
  });
});
