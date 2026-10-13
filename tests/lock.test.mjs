/**
 * lock.mjs 单元测试 —— 进程锁
 *
 * 这是全项目最重要的一个不变量：同一任务绝不能并发执行。并发一次的后果是
 * 撞站点限流、记 failed 且当天不再重试（§11.2），等于白丢一天签到。
 *
 * 三个边界都是真实踩过的：
 *   · 空锁文件（openSync 与 writeSync 之间的窗口）曾被判为「陈旧锁」而回收，
 *     导致两个进程同时执行 —— 见 lock.mjs 顶部注释
 *   · 持有者进程消失后锁未清理
 *   · PID 被系统复用给无关进程，`kill(pid, 0)` 误判存活，锁永远回收不掉
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LOCK_MAX_AGE_MS, acquireLock, lockState } from '../src/lock.mjs';

/** 超过 pid_max 上限，`kill(pid, 0)` 必然 ESRCH */
const DEAD_PID = '999999999';

let dir;
const at = (name) => path.join(dir, name);

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-lock-test-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lockState', () => {
  it('文件不存在 → absent', () => {
    assert.equal(lockState(at('none.lock')), 'absent');
  });

  it('当前进程持有 → held', () => {
    const f = at('self.lock');
    fs.writeFileSync(f, String(process.pid));
    assert.equal(lockState(f), 'held');
  });

  it('持有者已消失 → stale', () => {
    const f = at('dead.lock');
    fs.writeFileSync(f, DEAD_PID);
    assert.equal(lockState(f), 'stale');
  });

  it('空文件 → held（绝不可判为可回收）', () => {
    const f = at('empty.lock');
    fs.writeFileSync(f, '');
    assert.equal(lockState(f), 'held');
  });

  it('内容非法 → held（保守，宁可拒绝也不冒并发的风险）', () => {
    const f = at('garbage.lock');
    fs.writeFileSync(f, 'not-a-pid');
    assert.equal(lockState(f), 'held');
  });

  it('超过最长寿命 → stale，即便 PID 仍然存活（PID 复用兜底）', () => {
    const f = at('old.lock');
    fs.writeFileSync(f, String(process.pid)); // 本进程 PID 当然存活
    const past = new Date(Date.now() - LOCK_MAX_AGE_MS - 1_000);
    fs.utimesSync(f, past, past);
    assert.equal(lockState(f), 'stale');
  });
});

describe('acquireLock', () => {
  it('获取成功并在释放后可再次获取', () => {
    const f = at('cycle.lock');
    const release = acquireLock(f);
    assert.equal(typeof release, 'function');
    assert.equal(lockState(f), 'held');
    release();
    assert.equal(lockState(f), 'absent');

    const again = acquireLock(f);
    assert.equal(typeof again, 'function');
    again();
    assert.equal(lockState(f), 'absent');
  });

  it('已被持有 → 返回 null，且不覆盖持有者写入的 PID', () => {
    const f = at('busy.lock');
    fs.writeFileSync(f, String(process.pid));
    assert.equal(acquireLock(f), null);
    assert.equal(fs.readFileSync(f, 'utf8'), String(process.pid));
  });

  it('空锁文件挡住第二个实例（回归：曾因此发生并发执行）', () => {
    const f = at('empty-busy.lock');
    fs.writeFileSync(f, '');
    assert.equal(acquireLock(f), null);
    assert.equal(fs.readFileSync(f, 'utf8'), '', '空锁文件应被原样保留');
  });

  it('陈旧锁被回收并成功夺取', () => {
    const f = at('stale.lock');
    fs.writeFileSync(f, DEAD_PID);
    const release = acquireLock(f);
    assert.equal(typeof release, 'function');
    assert.equal(fs.readFileSync(f, 'utf8'), String(process.pid));
    release();
  });

  it('过期的残留锁被回收（超龄兜底）', () => {
    const f = at('expired.lock');
    fs.writeFileSync(f, String(process.pid));
    const past = new Date(Date.now() - LOCK_MAX_AGE_MS - 1_000);
    fs.utimesSync(f, past, past);
    const release = acquireLock(f);
    assert.equal(typeof release, 'function');
    release();
  });

  it('目录不存在时抛错，而不是静默返回 null 掩盖配置问题', () => {
    assert.throws(() => acquireLock(path.join(dir, 'no-such-dir', 'x.lock')));
  });
});
