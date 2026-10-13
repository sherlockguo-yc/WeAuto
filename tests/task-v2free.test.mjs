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
import { hasSignedToday, parseLastCheckin, parseSessionData } from '../tasks/v2free-checkin.mjs';

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
