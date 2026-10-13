/**
 * history.mjs 单元测试 —— 执行记录的读写与幂等判断
 *
 * `hasSuccessOn` 是幂等判断的唯一依据。它错一边都有实际代价：
 *   · 判松 → 同一任务当天重复请求站点 → 撞频率限制
 *   · 判严 → 当天该跑却没跑 → 漏签到
 *
 * 所有用例都写入临时目录（history 的读写函数支持注入文件路径），
 * 不会碰到真实的 data/runs.jsonl。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  SUCCESS_STATUSES,
  appendRun,
  hasSuccessOn,
  isSuccess,
  lastSuccessOf,
  readRuns,
} from '../src/history.mjs';

let dir;
let seq = 0;
const file = () => path.join(dir, `r${++seq}.jsonl`);

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-history-test-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isSuccess / SUCCESS_STATUSES', () => {
  it('只有 success 与 already-signed 算「今天这件事已办成」', () => {
    assert.deepEqual([...SUCCESS_STATUSES].sort(), ['already-signed', 'success']);
    assert.equal(isSuccess('success'), true);
    assert.equal(isSuccess('already-signed'), true);
  });

  it('失败、跳过与阻塞一律不计入幂等', () => {
    for (const s of ['skipped', 'failed', 'blocked', 'network-error', 'config-error']) {
      assert.equal(isSuccess(s), false, `${s} 不应算作成功`);
    }
  });
});

describe('appendRun / readRuns', () => {
  it('追加写入，读出为「最新在前」', () => {
    const f = file();
    appendRun({ ts: 1, task: 'a', status: 'success' }, f);
    appendRun({ ts: 2, task: 'a', status: 'failed' }, f);
    assert.deepEqual(readRuns(10, f).map((r) => r.ts), [2, 1]);
  });

  it('文件不存在时返回空数组而不是抛错', () => {
    assert.deepEqual(readRuns(10, path.join(dir, 'nope.jsonl')), []);
  });

  it('单行损坏不影响其余记录', () => {
    const f = file();
    fs.writeFileSync(f, '{"ts":1}\n{broken json\n{"ts":3}\n');
    assert.deepEqual(readRuns(10, f).map((r) => r.ts), [3, 1]);
  });

  it('limit 只取最近 N 条，且顺序仍是最新在前', () => {
    const f = file();
    for (let i = 1; i <= 5; i++) appendRun({ ts: i }, f);
    assert.deepEqual(readRuns(2, f).map((r) => r.ts), [5, 4]);
  });

  it('目录不存在时自动创建（首次部署时 data/ 可能还没生成）', () => {
    const f = path.join(dir, 'fresh', 'sub', 'runs.jsonl');
    appendRun({ ts: 7 }, f);
    assert.deepEqual(readRuns(10, f).map((r) => r.ts), [7]);
  });
});

describe('hasSuccessOn（幂等判断的唯一依据）', () => {
  it('同任务 + 同日期 + 成功 → 已完成', () => {
    const f = file();
    appendRun({ task: 't', date: '2026-10-13', status: 'success' }, f);
    assert.equal(hasSuccessOn('t', '2026-10-13', 500, f), true);
  });

  it('日期不同 → 不算已完成（跨日必须重新执行）', () => {
    const f = file();
    appendRun({ task: 't', date: '2026-10-12', status: 'success' }, f);
    assert.equal(hasSuccessOn('t', '2026-10-13', 500, f), false);
  });

  it('只有失败记录 → 不算已完成', () => {
    const f = file();
    appendRun({ task: 't', date: '2026-10-13', status: 'failed' }, f);
    assert.equal(hasSuccessOn('t', '2026-10-13', 500, f), false);
  });

  it('任务名不同 → 不算已完成（多任务共用同一个文件）', () => {
    const f = file();
    appendRun({ task: 'other', date: '2026-10-13', status: 'success' }, f);
    assert.equal(hasSuccessOn('t', '2026-10-13', 500, f), false);
  });

  it('already-signed 同样计入已完成（避免重复请求签到接口）', () => {
    const f = file();
    appendRun({ task: 't', date: '2026-10-13', status: 'already-signed' }, f);
    assert.equal(hasSuccessOn('t', '2026-10-13', 500, f), true);
  });
});

describe('lastSuccessOf', () => {
  it('取最近一次成功，忽略其后的失败', () => {
    const f = file();
    appendRun({ task: 't', status: 'success', ts: 1 }, f);
    appendRun({ task: 't', status: 'failed', ts: 2 }, f);
    assert.equal(lastSuccessOf('t', 500, f).ts, 1);
  });

  it('从未成功过时返回 null', () => {
    const f = file();
    appendRun({ task: 't', status: 'failed' }, f);
    assert.equal(lastSuccessOf('t', 500, f), null);
  });
});
