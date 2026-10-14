/**
 * 任务契约测试
 *
 * 这些断言守的是「加任务不改框架」这条长期判据的**前提**：契约本身稳定、
 * 结构错误在加载期就暴露、未知语义保守降级。
 *
 * 两类错误的处理方式刻意不同，测试也分开写：
 *   · **结构错误**（缺 key、类型不对）→ 加载期抛错
 *   · **未知语义**（不认识的 view type / 未知顶层字段）→ 不报错，降级
 * 反过来做就会出现「任务写错却静默不生效」或「框架旧一点就加载不了任务」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_STATUSES,
  DEFAULT_RETENTION,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  STATUS,
  VIEW_TYPES,
  assertValidTask,
  describeTask,
  isKnownViewType,
  isSuccess,
  normalizeTask,
} from '../src/task-contract.mjs';

const base = { name: 'demo', run: async () => ({ status: 'success' }) };
const norm = (extra = {}) => normalizeTask({ ...base, ...extra }, 'demo.mjs');

describe('状态口径', () => {
  it('success 与 already-signed 都算「今天这件事办成了」', () => {
    assert.equal(isSuccess(STATUS.SUCCESS), true);
    assert.equal(isSuccess(STATUS.ALREADY), true);
    for (const s of [STATUS.FAILED, STATUS.BLOCKED, STATUS.NETWORK, STATUS.CONFIG, STATUS.SKIPPED]) {
      assert.equal(isSuccess(s), false, `${s} 不应算成功`);
    }
  });

  it('锁定的状态取值不能悄悄改名（改名会打断已上线的记录与消费方面板）', () => {
    for (const s of [
      'success',
      'already-signed',
      'skipped',
      'failed',
      'blocked',
      'network-error',
      'config-error',
    ]) {
      assert.ok(ALL_STATUSES.includes(s), `状态枚举缺少 ${s}`);
    }
  });
});

describe('view：任务自己声明结果字段', () => {
  it('省略时为空数组（界面退化为「原始数据」展示）', () => {
    assert.deepEqual(norm().view, []);
  });

  it('label 缺省时用 key 兜底', () => {
    assert.deepEqual(norm({ view: [{ key: 'foo' }] }).view, [
      { key: 'foo', label: 'foo', type: 'text' },
    ]);
  });

  it('未知 type 保留原值，不报错（由渲染层按 text 兜底）', () => {
    const view = norm({ view: [{ key: 'a', label: 'A', type: 'temperature' }] }).view;
    assert.deepEqual(view, [{ key: 'a', label: 'A', type: 'temperature' }]);
    assert.equal(isKnownViewType('temperature'), false);
    // 反过来：已知类型必须全部被认出来，否则渲染层会白降级
    for (const t of VIEW_TYPES) assert.equal(isKnownViewType(t), true);
  });

  it('结构错误必须报错：不是数组 / 缺 key / label 不是字符串', () => {
    assert.throws(() => norm({ view: { key: 'a' } }), /view 必须是数组/);
    assert.throws(() => norm({ view: [{ label: 'A' }] }), /缺少 key/);
    assert.throws(() => norm({ view: [{ key: 'a', label: 1 }] }), /label 必须是字符串/);
    assert.throws(() => norm({ view: [null] }), /必须是对象/);
  });
});

describe('name：会进 URL 与数据库，必须限定字符集', () => {
  it('合法名通过', () => {
    for (const name of ['a', 'v2free-checkin', 'task-1']) {
      assert.doesNotThrow(() => assertValidTask({ ...base, name }, 'x.mjs'));
    }
  });

  it('大写 / 空格 / 中文 / 下划线 / 开头连字符 / 超长 一律拒绝', () => {
    for (const name of ['Demo', 'has space', '中文任务', 'a_b', '-lead', 'a'.repeat(65)]) {
      assert.throws(() => assertValidTask({ ...base, name }, 'x.mjs'), /name 非法/, `应拒绝 ${name}`);
    }
  });
});

describe('调度声明', () => {
  it('省略 = 不自动执行（只能手动触发），而不是「每次都执行」', () => {
    assert.equal(norm().schedule, null);
    assert.equal(norm({ schedule: null }).schedule, null);
  });

  it('window 被规范化为 { kind, window }', () => {
    assert.deepEqual(norm({ schedule: { window: { start: '09:00', end: '09:50' } } }).schedule, {
      kind: 'window',
      window: { start: '09:00', end: '09:50' },
    });
  });

  it('schedule 内的未知字段必须报错（否则会「配了却永远不执行」）', () => {
    assert.throws(() => norm({ schedule: { cron: '*/5 * * * *' } }), /schedule 含未知字段/);
  });

  it('空对象报错，而不是静默变成「不调度」', () => {
    assert.throws(() => norm({ schedule: {} }), /空对象/);
  });

  it('同时声明两种调度方式必须报错', () => {
    assert.throws(
      () =>
        norm({
          schedule: {
            window: { start: '09:00', end: '09:50' },
            every: { minutes: 30 },
          },
        }),
      /只能选一种/,
    );
  });

  it('every：按分钟间隔，抖动必须小于间隔', () => {
    assert.deepEqual(norm({ schedule: { every: { minutes: 30 } } }).schedule, {
      kind: 'every',
      every: { minutes: 30, jitterSec: 0 },
    });
    assert.equal(norm({ schedule: { every: { minutes: 5, jitterSec: 60 } } }).schedule.every.jitterSec, 60);

    assert.throws(() => norm({ schedule: { every: { minutes: 0 } } }), /minutes/);
    assert.throws(() => norm({ schedule: { every: { minutes: 1.5 } } }), /minutes/);
    assert.throws(() => norm({ schedule: { every: { minutes: 5, jitterSec: 300 } } }), /小于间隔/);
    assert.throws(() => norm({ schedule: { every: { minutes: 5, hours: 1 } } }), /未知字段/);
  });

  it('once：把「北京时间字符串」解析成绝对时刻，并在加载期就报格式错误', () => {
    const s = norm({ schedule: { once: { at: '2026-11-01 09:00' } } }).schedule;
    assert.equal(s.kind, 'once');
    // 2026-11-01 09:00 北京时间 == 01:00 UTC
    assert.equal(new Date(s.once.atMs).toISOString(), '2026-11-01T01:00:00.000Z');
    assert.equal(s.once.atLabel, '2026-11-01 09:00:00');

    // 带显式时区则按其解释
    const iso = norm({ schedule: { once: { at: '2026-11-01T09:00:00Z' } } }).schedule;
    assert.equal(new Date(iso.once.atMs).toISOString(), '2026-11-01T09:00:00.000Z');

    for (const bad of ['2026/11/01 09:00', '2026-11-01', '', null, 123]) {
      assert.throws(() => norm({ schedule: { once: { at: bad } } }), /时间/, `应拒绝 ${bad}`);
    }
    assert.throws(() => norm({ schedule: { once: { at: '2026-11-01 09:00', tz: 'UTC' } } }), /未知字段/);
  });
});

describe('执行参数', () => {
  it('补默认值', () => {
    const t = norm();
    assert.equal(t.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.deepEqual(t.retention, DEFAULT_RETENTION);
    assert.equal(t.group, '未分组');
    assert.equal(t.accounts, false);
    assert.equal(t.displayName, 'demo'); // 缺省时用 name，界面不必到处判空
    assert.deepEqual(t.tags, []);
  });

  it('timeoutMs 必须是正整数且不超上限', () => {
    assert.throws(() => norm({ timeoutMs: 0 }), /timeoutMs/);
    assert.throws(() => norm({ timeoutMs: -1 }), /timeoutMs/);
    assert.throws(() => norm({ timeoutMs: 1.5 }), /timeoutMs/);
    assert.throws(() => norm({ timeoutMs: MAX_TIMEOUT_MS + 1 }), /上限/);
    assert.equal(norm({ timeoutMs: 5_000 }).timeoutMs, 5_000);
  });

  it('retention 支持局部覆盖', () => {
    assert.deepEqual(norm({ retention: { days: 7 } }).retention, {
      ...DEFAULT_RETENTION,
      days: 7,
    });
    assert.throws(() => norm({ retention: { days: 0 } }), /retention/);
    assert.throws(() => norm({ retention: 30 }), /retention/);
  });

  it('accounts 必须是布尔值', () => {
    assert.equal(norm({ accounts: true }).accounts, true);
    assert.throws(() => norm({ accounts: 'yes' }), /accounts/);
  });
});

describe('向前兼容', () => {
  it('未知的顶层字段原样保留（任务可以先写将来才会用到的字段）', () => {
    const t = norm({ futureField: { anything: 1 } });
    assert.deepEqual(t.futureField, { anything: 1 });
    // 且不影响已知字段的规范化
    assert.equal(t.timeoutMs, DEFAULT_TIMEOUT_MS);
  });
});

describe('describeTask：给接口/CLI 用的摘要', () => {
  it('不含 run 函数（函数既无法序列化，也容易顺手泄漏内部实现）', () => {
    const d = describeTask(norm({ requires: ['A'], group: '签到' }));
    assert.equal('run' in d, false);
    assert.equal(d.group, '签到');
    assert.deepEqual(d.requires, ['A']);
    // 必须能安全 JSON 序列化
    assert.doesNotThrow(() => JSON.stringify(d));
  });
});
