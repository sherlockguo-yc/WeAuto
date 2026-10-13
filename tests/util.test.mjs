/**
 * util.mjs 单元测试 —— dotenv 解析与日期/时区换算
 *
 * 时区函数是整个调度正确性的地基：窗口判断、当日目标时刻、幂等判断的日期归属
 * 全都建立在它们之上。断言一律以显式 UTC 时刻为输入，这样测试结果不随运行机器
 * 的系统时区变化。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dateInTZ,
  hhmmToSeconds,
  humanDuration,
  parseDotenv,
  secondsOfDayInTZ,
  secondsToHHMM,
  timestampInTZ,
} from '../src/util.mjs';

describe('parseDotenv', () => {
  it('解析 KEY=VALUE，跳过空行与注释，剥离成对引号', () => {
    const text = [
      '# 这是注释',
      '',
      'A=1',
      '  B = two words  ',
      'C="quoted"',
      "D='single'",
      'NOEQUAL',
    ].join('\n');
    assert.deepEqual(parseDotenv(text), {
      A: '1',
      B: 'two words',
      C: 'quoted',
      D: 'single',
    });
  });

  it('值中的 = 不被截断（密码里很常见）', () => {
    assert.deepEqual(parseDotenv('PASS=a=b=c'), { PASS: 'a=b=c' });
  });

  it('空输入返回空对象', () => {
    assert.deepEqual(parseDotenv(''), {});
  });
});

describe('时区换算（TZ = Asia/Shanghai）', () => {
  it('dateInTZ 在北京时间零点切换日期，而不是 UTC 零点', () => {
    assert.equal(dateInTZ(new Date('2025-12-31T15:59:59Z')), '2025-12-31');
    assert.equal(dateInTZ(new Date('2025-12-31T16:00:00Z')), '2026-01-01');
  });

  it('secondsOfDayInTZ 返回北京时间的当日秒数', () => {
    // 北京时间 2026-01-01 00:00:00
    assert.equal(secondsOfDayInTZ(new Date('2025-12-31T16:00:00Z')), 0);
    // 北京时间 2026-01-01 08:00:00
    assert.equal(secondsOfDayInTZ(new Date('2026-01-01T00:00:00Z')), 8 * 3600);
    // 北京时间 2026-01-01 17:21:30
    assert.equal(secondsOfDayInTZ(new Date('2026-01-01T09:21:30Z')), 17 * 3600 + 21 * 60 + 30);
  });

  it('timestampInTZ 输出可读的北京时间', () => {
    assert.equal(timestampInTZ(new Date('2026-01-01T00:00:00Z')), '2026-01-01 08:00:00');
    assert.equal(timestampInTZ(new Date('2025-12-31T16:00:00Z')), '2026-01-01 00:00:00');
  });
});

describe('hhmmToSeconds / secondsToHHMM', () => {
  it('往返一致', () => {
    for (const t of ['00:00', '09:00', '09:21', '09:50', '23:59']) {
      assert.equal(secondsToHHMM(hhmmToSeconds(t)), t);
    }
  });

  it('接受单位数小时', () => {
    assert.equal(hhmmToSeconds('9:00'), 9 * 3600);
  });

  it('非法格式一律抛错（不能静默算成 0，否则窗口会退化成午夜）', () => {
    for (const bad of ['9', '09:0', '09:000', '', 'abc', '09-00']) {
      assert.throws(() => hhmmToSeconds(bad), /非法的 HH:MM/, `应拒绝 ${JSON.stringify(bad)}`);
    }
  });
});

describe('humanDuration', () => {
  it('按量级选择单位', () => {
    assert.equal(humanDuration(500), '500ms');
    assert.equal(humanDuration(1500), '1.5s');
    assert.equal(humanDuration(60_000), '1m00s');
    assert.equal(humanDuration(65_000), '1m05s');
  });
});
