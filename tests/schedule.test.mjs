/**
 * schedule.mjs 单元测试 —— 种子化随机调度
 *
 * 这里锁住的是「每天在窗口内、但每天时刻不同」这个对外承诺。它一旦被无意改动，
 * 症状很隐蔽：任务仍会执行，只是变成固定时刻（容易被站点识别为机器行为），
 * 所以必须有断言兜住。
 *
 * 注意 target 的精度：`targetLabel` 只到分钟（"09:21"），实际秒数落在
 * 09:21:00–09:21:59 之间。所以边界断言不能用分钟级时刻构造，
 * 必须建立在 `targetSecondsOfDay` 算出的真实秒数之上。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeWindow, shouldRunNow, targetSecondsOfDay } from '../src/schedule.mjs';
import { secondsToHHMM } from '../src/util.mjs';

const WINDOW = { start: '09:00', end: '09:50' };
const TASK = 'v2free-checkin';
const DATE = '2026-10-13';

/** 当日真实目标秒数（不是分钟标签） */
const TARGET = targetSecondsOfDay(TASK, WINDOW, DATE);

/**
 * 构造「北京时间为某日第 sec 秒」的时刻。
 * 北京 = UTC+8，故 UTC 时刻 = 当日 00:00 + sec - 8h；负数小时由 Date.UTC 正确回退。
 */
const bjAt = (sec, date = DATE) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + sec * 1000 - 8 * 3600 * 1000);
};

/** 2026-10 的各日日期串 */
const daysOf = (n) =>
  Array.from({ length: n }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);

describe('targetSecondsOfDay', () => {
  it('同一任务同一天结果恒定（幂等与可测试的基础）', () => {
    assert.equal(
      targetSecondsOfDay(TASK, WINDOW, DATE),
      targetSecondsOfDay(TASK, WINDOW, DATE),
    );
  });

  it('每一天都落在窗口 [start, end) 内', () => {
    const start = 9 * 3600;
    const end = start + 50 * 60;
    for (const date of daysOf(28)) {
      const t = targetSecondsOfDay(TASK, WINDOW, date);
      assert.ok(t >= start, `${date} 的目标时刻应 >= 09:00，实际 ${secondsToHHMM(t)}`);
      assert.ok(t < end, `${date} 的目标时刻应 < 09:50，实际 ${secondsToHHMM(t)}`);
    }
  });

  it('各日时刻足够分散（避免退化成固定时刻）', () => {
    const labels = new Set(daysOf(28).map((d) => secondsToHHMM(targetSecondsOfDay(TASK, WINDOW, d))));
    assert.ok(labels.size >= 20, `28 天中应有多样化的时刻，实际只有 ${labels.size} 种`);
  });

  it('不同任务在同一天相互独立', () => {
    assert.notEqual(
      targetSecondsOfDay('task-a', WINDOW, DATE),
      targetSecondsOfDay('task-b', WINDOW, DATE),
    );
  });

  it('已知取值锚点：与 N150 上 `weauto list --json` 的输出一致', () => {
    // 该值取自 N150 生产环境的实际输出（2026-10-13）。sha256 与 readUInt32BE
    // 都是跨平台确定的，所以这个断言在任何机器上都应成立；
    // 若它失败，说明种子口径被改动 —— 这是有意设置的告警。
    assert.equal(secondsToHHMM(TARGET), '09:21');
  });

  it('窗口非法时抛错，不静默退化成午夜', () => {
    assert.throws(() => targetSecondsOfDay('t', { start: '10:00', end: '09:00' }, DATE), /调度窗口非法/);
    assert.throws(() => targetSecondsOfDay('t', { start: '09:00', end: '09:00' }, DATE), /调度窗口非法/);
  });
});

describe('shouldRunNow', () => {
  it('未到目标时刻（差 1 秒）→ reached=false，且带回目标标签', () => {
    const r = shouldRunNow(TASK, WINDOW, bjAt(TARGET - 1));
    assert.equal(r.date, DATE);
    assert.equal(r.targetLabel, '09:21');
    assert.equal(r.reached, false);
  });

  it('恰好到点即算 reached（边界是 >= 而非 >）', () => {
    assert.equal(shouldRunNow(TASK, WINDOW, bjAt(TARGET)).reached, true);
  });

  it('已过目标时刻 → reached=true', () => {
    assert.equal(shouldRunNow(TASK, WINDOW, bjAt(TARGET + 60)).reached, true);
  });

  it('尚未进入窗口 → reached=false', () => {
    assert.equal(shouldRunNow(TASK, WINDOW, bjAt(7 * 3600)).reached, false);
  });

  it('跨日边界：日期按北京时间归属', () => {
    // 北京时间 2026-10-14 00:30 → 属于 10-14，且远未到点
    const r = shouldRunNow(TASK, WINDOW, bjAt(30 * 60, '2026-10-14'));
    assert.equal(r.date, '2026-10-14');
    assert.equal(r.reached, false);
  });
});

describe('describeWindow', () => {
  it('给出窗口、目标时刻与剩余时间', () => {
    const d = describeWindow(TASK, WINDOW, bjAt(9 * 3600)); // 北京 09:00
    assert.equal(d.date, DATE);
    assert.match(d.window, /^09:00.09:50$/);
    assert.equal(d.targetLabel, '09:21');
    assert.equal(d.remaining, secondsToHHMM(TARGET - 9 * 3600));
  });

  it('已过点则剩余归零，不会出现负值', () => {
    assert.equal(describeWindow(TASK, WINDOW, bjAt(TARGET)).remaining, '00:00');
    assert.equal(describeWindow(TASK, WINDOW, bjAt(TARGET + 3600)).remaining, '00:00');
  });
});
