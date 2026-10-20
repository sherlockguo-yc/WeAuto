/**
 * WorkBuddy 签到任务的纯函数测试
 *
 * 这几个函数是本任务最脆的一环：
 *   · tokenExpiryMs 解错 → 要么误报过期把能跑的任务拦住，要么放过期白跑一次
 *   · claimStatus 认错码 → 已签到的日子被记成 failed，统计口径全歪
 *   · summarizeClaim 编数字 → 界面出现「本次获得 0 积分」这种像真的假数据
 *
 * 断言基于 2026-10-20 实测到的真实响应，见任务文件头部注释。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claimStatus, daysLeft, summarizeClaim, tokenExpiryMs } from '../tasks/workbuddy-checkin.mjs';

/** 造一个只有 payload 有意义的假 JWT（不参与真实鉴权，只测解码） */
function fakeJwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.signature`;
}

const NOW = Date.UTC(2026, 9, 20, 6, 30); // 2026-10-20 14:30 北京时间
const DAY = 24 * 60 * 60 * 1000;

describe('tokenExpiryMs', () => {
  it('从标准 JWT 的 exp 取出毫秒时间戳', () => {
    const exp = Math.floor(NOW / 1000) + 28 * 86400;
    assert.equal(tokenExpiryMs(fakeJwt({ exp })), exp * 1000);
  });

  it('没有 exp 字段时返回 null', () => {
    assert.equal(tokenExpiryMs(fakeJwt({ sub: 'x' })), null);
  });

  it('不是 JWT（比如用户贴了 cookie）时返回 null，而不是抛错', () => {
    assert.equal(tokenExpiryMs('session=abc; other=1'), null);
    assert.equal(tokenExpiryMs(''), null);
    assert.equal(tokenExpiryMs(undefined), null);
  });

  it('payload 不是合法 base64/JSON 时返回 null', () => {
    assert.equal(tokenExpiryMs('a.%%%.c'), null);
  });
});

describe('daysLeft', () => {
  it('剩余 28 天时返回 28', () => {
    assert.equal(daysLeft(NOW + 28 * DAY, NOW), 28);
  });

  it('不足一天向下取整（不到最后一天不报 1）', () => {
    assert.equal(daysLeft(NOW + 0.9 * DAY, NOW), 0);
  });

  it('已过期返回负数', () => {
    assert.equal(daysLeft(NOW - 3 * DAY, NOW), -3);
  });

  it('expMs 无法解析时返回 null', () => {
    assert.equal(daysLeft(null, NOW), null);
    assert.equal(daysLeft(undefined, NOW), null);
  });
});

describe('claimStatus', () => {
  it('code 0 记为 success', () => {
    assert.equal(claimStatus(0), 'success');
  });

  it('code 10001 记为 already-signed（实测的「今天已签到」码）', () => {
    assert.equal(claimStatus(10001), 'already-signed');
  });

  it('未知码记为 failed，不猜成成功', () => {
    assert.equal(claimStatus(500), 'failed');
    assert.equal(claimStatus(undefined), 'failed');
  });
});

describe('summarizeClaim', () => {
  const expMs = NOW + 28 * DAY;

  it('成功响应取到积分、连续天数、是否连签日', () => {
    const json = {
      code: 0,
      msg: 'OK',
      data: { credit: 100, streak_days: 1, is_streak_day: false },
    };
    assert.deepEqual(summarizeClaim(json, expMs, NOW), {
      credit: 100,
      streakDays: 1,
      isStreakDay: false,
      tokenDaysLeft: 28,
    });
  });

  it('已签响应没有 data 时只留凭据天数，不编 credit:0', () => {
    const json = { code: 10001, msg: '今天已签到，请明天再来' };
    assert.deepEqual(summarizeClaim(json, expMs, NOW), { tokenDaysLeft: 28 });
  });

  it('字段缺失/类型不对时跳过，不用 0 或 null 冒充数据', () => {
    const json = { code: 0, data: { credit: null, streak_days: '1' } };
    assert.deepEqual(summarizeClaim(json, expMs, NOW), { tokenDaysLeft: 28 });
  });

  it('凭据过期时间未知时不写 tokenDaysLeft', () => {
    assert.deepEqual(summarizeClaim({ code: 0, data: { credit: 50 } }, null, NOW), { credit: 50 });
  });
});
