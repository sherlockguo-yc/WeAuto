/**
 * v2free 任务的页面解析函数单元测试
 *
 * 这三个函数（parseSessionData / parseLastCheckin / hasSignedToday）是本任务最脆
 * 的一环：站点改版不会报错，只会让解析静默返回 null 或 false —— 表现为「记 success
 * 但数据全空」，或更糟：明明已签到却重复请求接口而撞限流（见功能规格 §11.7）。
 *
 * 因此断言基于 tests/fixtures/v2free-user-signed.html（从真实页面脱敏而来），
 * 而不是凭想象构造的字符串。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  gainedTraffic,
  hasSignedToday,
  parseGainFromMessage,
  parseLastCheckin,
  parseSessionData,
  parseTraffic,
  remainFromCheckin,
  successMessage,
} from '../tasks/v2free-checkin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIGNED_HTML = fs.readFileSync(path.join(HERE, 'fixtures', 'v2free-user-signed.html'), 'utf8');

describe('parseSessionData', () => {
  it('从真实页面的 crispSessionData 取到结构化账户数据', () => {
    const d = parseSessionData(SIGNED_HTML);
    assert.ok(d, '应解析成功');
    assert.equal(d.remainTraffic, '485.94MB');
    assert.equal(d.trafficMain, '485.94MB');
    assert.equal(d.trafficPackage, '0B');
    assert.equal(d.plan, '无套餐');
    assert.equal(d.expire, '2026-10-25 15:33:37');
    assert.equal(d.lastUsed, '2026-10-10 03:30:59');
    assert.equal(d.balance, '0.00');
  });

  it('页面没有内嵌数据时返回 null，而不是抛错', () => {
    assert.equal(parseSessionData('<html><body>没有内嵌数据</body></html>'), null);
  });

  it('内嵌数组被截断时返回 null', () => {
    assert.equal(parseSessionData('crispSessionData = [[["traffic","1MB"]]; '), null);
  });
});

describe('parseLastCheckin', () => {
  it('从 <b>上次签到</b>:<时间> 取到时间（标签夹在中间，不能邻接匹配）', () => {
    assert.equal(parseLastCheckin(SIGNED_HTML), '2026-10-13 12:18:43');
  });

  it('没有该字段时返回 null', () => {
    assert.equal(parseLastCheckin('<html></html>'), null);
  });

  it('标签与时间距离过远时不误匹配（限定 40 字符内）', () => {
    assert.equal(parseLastCheckin(`上次签到${'x'.repeat(100)}2026-10-13 12:18:43`), null);
  });
});

describe('hasSignedToday', () => {
  it('已签到的页面 → true（据此跳过重复的签到请求）', () => {
    assert.equal(hasSignedToday(SIGNED_HTML), true);
  });

  it('未签到的页面 → false', () => {
    assert.equal(hasSignedToday('<a class="btn btn-brand">立即签到</a>'), false);
  });
});

/**
 * 「本次获得」是签到唯一能体现收益的数字，错一个数量级就会把 512MB 显示成 0.5GB
 * 这种看着像回事的假数据，所以单位换算必须逐档断言。
 */
describe('parseTraffic', () => {
  it('带单位的字符串按 1024 进制换算', () => {
    assert.equal(parseTraffic('0B'), 0);
    assert.equal(parseTraffic('2KB'), 2048);
    assert.equal(parseTraffic('1.5GB'), 1.5 * 1024 ** 3);
    assert.equal(parseTraffic('1.02 GB'), 1.02 * 1024 ** 3);
  });

  it('纯数字按字节（契约里 bytes 类型的语义）', () => {
    assert.equal(parseTraffic('12345678'), 12345678);
    assert.equal(parseTraffic(1024), 1024);
  });

  it('解析不了返回 null，而不是 0', () => {
    assert.equal(parseTraffic('485.94MB 左右'), null);
    assert.equal(parseTraffic('不适用.'), null);
    assert.equal(parseTraffic(null), null);
  });
});

describe('parseGainFromMessage', () => {
  it('从「获得了 X 流量」里取到流量', () => {
    assert.equal(parseGainFromMessage('签到成功，获得了 1.5GB 流量'), 1.5 * 1024 ** 3);
  });

  it('文案里的其它数字不会被当成流量', () => {
    assert.equal(parseGainFromMessage('连续签到 3 天，获得了 512MB 流量'), 512 * 1024 ** 2);
  });

  it('没有流量数字时返回 null', () => {
    assert.equal(parseGainFromMessage('签到成功'), null);
    assert.equal(parseGainFromMessage(null), null);
  });
});

describe('gainedTraffic', () => {
  it('接口文案里有就用文案，不去算差值', () => {
    const g = gainedTraffic({
      msg: '获得了 1GB 流量',
      before: '100MB',
      after: '200MB',
    });
    assert.equal(g, 1024 ** 3);
  });

  it('文案没有时用签到前后的差值', () => {
    assert.equal(
      gainedTraffic({ msg: '签到成功', before: '100.00MB', after: '612.00MB' }),
      512 * 1024 ** 2,
    );
  });

  it('签到前后没变化 → 没领到，返回 null', () => {
    assert.equal(gainedTraffic({ msg: '签到成功', before: '485.94MB', after: '485.94MB' }), null);
  });

  it('期间有消耗（差值为负）时不显示负数', () => {
    assert.equal(gainedTraffic({ msg: null, before: '600MB', after: '500MB' }), null);
  });

  it('任一侧解析不了就返回 null', () => {
    assert.equal(gainedTraffic({ msg: null, before: null, after: '1GB' }), null);
  });
});

/**
 * 签到接口的 trafficInfo.unUsedTraffic 是「签到后还剩多少」的唯一权威来源
 * （站点前端签到后就用它刷页面上的「剩余」）。它缺失或解析不了时必须返回 null，
 * 让调用方退回回读页面的值——绝不能把一个非流量字符串塞进结果里冒充数字。
 */
describe('remainFromCheckin', () => {
  it('取签到成功响应里的 remaining', () => {
    assert.equal(remainFromCheckin({ ret: 1, trafficInfo: { unUsedTraffic: '1.97GB' } }), '1.97GB');
  });

  it('接口给字节数时原样返回数字', () => {
    assert.equal(remainFromCheckin({ ret: 1, trafficInfo: { unUsedTraffic: 12345678 } }), 12345678);
  });

  it('没有该字段（如已签到 / 限流的响应）返回 null', () => {
    assert.equal(remainFromCheckin({ ret: 0, msg: '您似乎已经签到过了...' }), null);
    assert.equal(remainFromCheckin({ ret: 1 }), null);
    assert.equal(remainFromCheckin(null), null);
  });

  it('字段值解析不成流量时返回 null，不当作数字', () => {
    assert.equal(remainFromCheckin({ trafficInfo: { unUsedTraffic: '不适用.' } }), null);
    assert.equal(remainFromCheckin({ trafficInfo: { unUsedTraffic: '' } }), null);
    assert.equal(remainFromCheckin({ trafficInfo: { unUsedTraffic: -1 } }), null);
  });
});

/**
 * message 是概览「最近执行」与执行历史里唯一可见的文字，签到后要一眼看到
 * 「领了多少 + 还剩多少」。缺哪个就省哪个，不能编。
 */
describe('successMessage', () => {
  it('获得量与剩余量都有时两个都写', () => {
    assert.equal(
      successMessage({ gain: 1.5 * 1024 ** 3, remain: '12.3GB' }),
      '签到成功，获得了 1.5 GB 流量，剩余 12.3GB',
    );
  });

  it('只有获得量时不多写一个「剩余」', () => {
    assert.equal(successMessage({ gain: 512 * 1024 ** 2 }), '签到成功，获得了 512 MB 流量');
  });

  it('只有剩余量（站点文案没给获得量）时也能看出还剩多少', () => {
    assert.equal(successMessage({ remain: '485.94MB' }), '签到成功，剩余 485.94MB');
  });

  it('两个都没有时退回短句', () => {
    assert.equal(successMessage({}), '签到成功');
    assert.equal(successMessage({ gain: null, remain: null }), '签到成功');
  });
});
