/**
 * 结果格式化测试
 *
 * 两条契约级的承诺在这里兑现：
 *   · 未知类型按 text 渲染（新类型不需要框架先升级）
 *   · 解析失败回退为原值（绝不能让「站点改版」显示成「Invalid Date」）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MISSING, formatBytes, formatDate, formatValue, renderView } from '../src/format.mjs';

describe('formatBytes', () => {
  it('按量级选择单位，小数量保留一位小数', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(12 * 1024 ** 3), '12 GB');
    // 站点给的确实是字节整数，几万 GB 也要算得出来
    assert.equal(formatBytes(5 * 1024 ** 4), '5.0 TB');
  });

  it('非数字原样返回，不产生 NaN', () => {
    assert.equal(formatBytes('不限量'), '不限量');
  });
});

describe('formatValue', () => {
  it('空值统一显示为占位符', () => {
    for (const v of [null, undefined, '']) {
      assert.equal(formatValue('text', v), MISSING);
      assert.equal(formatValue('bytes', v), MISSING);
    }
  });

  it('各类型的渲染', () => {
    assert.equal(formatValue('bytes', 2048), '2.0 KB');
    assert.equal(formatValue('number', 1234567), '1,234,567');
    assert.equal(formatValue('percent', 0.87), '87%');
    assert.equal(formatValue('percent', 87), '87%');
    assert.equal(formatValue('bool', true), '是');
    assert.equal(formatValue('bool', false), '否');
    assert.equal(formatValue('list', ['a', 'b']), 'a、b');
    assert.equal(formatValue('json', { a: 1 }), '{"a":1}');
    assert.equal(formatValue('duration', 1500), '1.5s');
  });

  it('日期：北京时间显示，且解析不了就原样返回', () => {
    assert.equal(formatValue('date', '2026-11-01'), '2026-11-01');
    assert.equal(formatValue('datetime', '2026-11-01 09:30:00'), '2026-11-01 09:30:00');
    // 站点常给时间戳：10 位按秒、13 位按毫秒
    assert.equal(formatDate(1780000000), formatDate(1780000000000));

    // 关键：不能出现 Invalid Date，也不能把未知格式吞掉
    assert.equal(formatValue('date', '长期有效'), '长期有效');
    assert.equal(formatValue('datetime', 'never'), 'never');
  });

  it('未知类型按 text 渲染（向前兼容）', () => {
    assert.equal(formatValue('temperature', '36.5'), '36.5');
    assert.equal(formatValue(undefined, 'abc'), 'abc');
  });
});

describe('renderView', () => {
  const view = [
    { key: 'remainTraffic', label: '剩余流量', type: 'bytes' },
    { key: 'expire', label: '到期时间', type: 'date' },
  ];

  it('按声明顺序渲染，并标出缺失字段', () => {
    const { rows, remaining } = renderView(view, { remainTraffic: 2048, other: 'x' });
    assert.deepEqual(rows.map((r) => r.label), ['剩余流量', '到期时间']);
    assert.equal(rows[0].value, '2.0 KB');
    assert.equal(rows[0].missing, false);
    assert.equal(rows[1].value, MISSING);
    assert.equal(rows[1].missing, true);
    assert.deepEqual(remaining, [{ key: 'other', value: 'x' }]);
  });

  it('未声明的字段不丢，进「原始数据」区', () => {
    const { remaining } = renderView(view, { remainTraffic: 1, plan: '年付', nested: { a: 1 } });
    assert.deepEqual(
      remaining.map((r) => r.key),
      ['plan', 'nested'],
    );
    assert.equal(remaining[1].value, '{"a":1}');
  });

  it('data 为 null 时不炸', () => {
    const { rows, remaining } = renderView(view, null);
    assert.equal(rows.length, 2);
    assert.deepEqual(remaining, []);
  });
});
