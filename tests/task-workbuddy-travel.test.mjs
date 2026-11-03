/**
 * WorkBuddy 派 Buddy 旅行任务的测试
 *
 * 这个任务最脆的三处：
 *   · planFor 判错 → 该领的没领（收益过期作废），或该派的没派（当天机会浪费）
 *   · classifyError 认不出 daily limit → 每天重复调用 depart，历史里一堆 failed
 *   · pickLocation 选中没有 id 的项 → 把「配置变了」伪装成「网络失败」
 *
 * 响应结构来自网页端 bundle 的映射函数（见任务文件头部注释），
 * 不是照着「可能的形状」编的。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyError,
  clockText,
  parseTravel,
  pickLocation,
  planFor,
} from '../tasks/workbuddy-buddy-travel.mjs';
import task from '../tasks/workbuddy-buddy-travel.mjs';

/* ───────────────────── 夹具 ───────────────────── */

/** 造一个 fetch Response 的最小替身：run 只用到 status 与 text() */
function fakeResponse(body, status = 200) {
  return {
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/**
 * 按 URL 路径分发的假 request。
 * routes: { 'travel/status': {...}, 'travel/depart': {...} }
 * 值为函数时按次调用（测「第二次返回上限」这种场景）。
 */
function fakeRequest(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const key = Object.keys(routes).find((k) => path.endsWith(k));
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body, key });
    if (!key) return fakeResponse({ code: 404, msg: 'not found' }, 404);
    const route = routes[key];
    const value = typeof route === 'function' ? route(opts, calls) : route;
    if (value instanceof Error) throw value;
    return value;
  };
  fn.calls = calls;
  return fn;
}

const TOKEN = 'not-a-jwt-so-no-expiry-check';

const STATUS_IDLE = {
  code: 0,
  msg: 'OK',
  data: { state: 'idle', server_now: 1_700_000_000, daily_limit_reached: false, reward_credit: 0 },
};

const CONFIG = {
  code: 0,
  msg: 'OK',
  data: { locations: [{ id: 11, name: '京都' }, { id: 12, name: '巴黎' }], intro_slogans: [] },
};

/* ───────────────────── parseTravel ───────────────────── */

describe('parseTravel', () => {
  it('取到全部字段（时间是秒）', () => {
    const snap = parseTravel({
      state: 'traveling',
      location: { id: 11, name: '京都' },
      depart_at: 1_700_000_000,
      arrive_at: 1_700_007_200,
      server_now: 1_700_001_000,
      daily_limit_reached: true,
      reward_credit: 0,
    });
    assert.equal(snap.state, 'traveling');
    assert.equal(snap.location.name, '京都');
    assert.equal(snap.arriveAt, 1_700_007_200);
    assert.equal(snap.serverNow, 1_700_001_000);
    assert.equal(snap.dailyLimitReached, true);
  });

  it('缺字段时给安全默认值，不抛错', () => {
    const snap = parseTravel({});
    assert.equal(snap.state, 'idle');
    assert.equal(snap.location, null);
    assert.equal(snap.arriveAt, 0);
    assert.equal(snap.dailyLimitReached, false);
  });

  it('daily_limit_reached 只认真正的 true（字符串 "true" 不算）', () => {
    assert.equal(parseTravel({ daily_limit_reached: 'true' }).dailyLimitReached, false);
    assert.equal(parseTravel({ daily_limit_reached: 1 }).dailyLimitReached, false);
  });

  it('null 输入不炸', () => {
    assert.equal(parseTravel(null).state, 'idle');
  });
});

/* ───────────────────── planFor ───────────────────── */

describe('planFor', () => {
  it('idle 且未达上限 → 只派出', () => {
    const p = planFor({ state: 'idle', dailyLimitReached: false, arriveAt: 0, serverNow: 100 });
    assert.deepEqual(p, { needClaim: false, canDepart: true });
  });

  it('arrived 且今天还没派过 → 领完接着派（昨天出门、今天归来的号）', () => {
    const p = planFor({ state: 'arrived', dailyLimitReached: false, arriveAt: 50, serverNow: 100 });
    assert.deepEqual(p, { needClaim: true, canDepart: true });
  });

  it('arrived 但今天已派过 → 只领不派（早上出门、中午归来的号）', () => {
    const p = planFor({ state: 'arrived', dailyLimitReached: true, arriveAt: 50, serverNow: 100 });
    assert.deepEqual(p, { needClaim: true, canDepart: false });
  });

  it('traveling 且未到点 → 什么都不做', () => {
    const p = planFor({ state: 'traveling', dailyLimitReached: true, arriveAt: 500, serverNow: 100 });
    assert.deepEqual(p, { needClaim: false, canDepart: false });
  });

  it('traveling 但按 server_now 已经过了 arrive_at → 也试一次领取', () => {
    const p = planFor({ state: 'traveling', dailyLimitReached: true, arriveAt: 100, serverNow: 100 });
    assert.equal(p.needClaim, true);
  });

  it('idle 但今日已派满 → 不能再派', () => {
    const p = planFor({ state: 'idle', dailyLimitReached: true, arriveAt: 0, serverNow: 100 });
    assert.deepEqual(p, { needClaim: false, canDepart: false });
  });
});

/* ───────────────────── pickLocation ───────────────────── */

describe('pickLocation', () => {
  it('按随机值取对应下标', () => {
    const list = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
    assert.equal(pickLocation(list, () => 0).id, 1);
    assert.equal(pickLocation(list, () => 0.999).id, 2);
  });

  it('随机值等于 1 时不越界', () => {
    const list = [{ id: 1 }, { id: 2 }];
    assert.equal(pickLocation(list, () => 1).id, 2);
  });

  it('过滤掉没有 id 的项（传 undefined 只会换回 location not available）', () => {
    const list = [{ name: '坏数据' }, { id: 7, name: 'ok' }];
    assert.equal(pickLocation(list, () => 0).id, 7);
  });

  it('空列表/非数组返回 null', () => {
    assert.equal(pickLocation([]), null);
    assert.equal(pickLocation(null), null);
    assert.equal(pickLocation([{ name: 'x' }]), null);
  });
});

/* ───────────────────── classifyError ───────────────────── */

describe('classifyError', () => {
  it('429 与 daily limit 文案都归为上限', () => {
    assert.equal(classifyError(429, ''), 'daily-limit');
    assert.equal(classifyError(400, 'Daily limit reached'), 'daily-limit');
  });

  it('其余英文文案各自归类', () => {
    assert.equal(classifyError(400, 'already traveling'), 'traveling');
    assert.equal(classifyError(400, 'no active buddy'), 'no-buddy');
    assert.equal(classifyError(400, 'location not available'), 'location');
    assert.equal(classifyError(400, 'not arrived yet'), 'nothing-to-claim');
    assert.equal(classifyError(400, 'no unclaimed travel'), 'nothing-to-claim');
    assert.equal(classifyError(500, 'grant credits failed'), 'grant-failed');
    assert.equal(classifyError(401, ''), 'unauthorized');
  });

  it('看不懂的文案不猜', () => {
    assert.equal(classifyError(400, 'something new'), 'unknown');
  });
});

describe('clockText', () => {
  it('秒 → 北京时间字符串', () => {
    assert.match(clockText(1_700_000_000), /^2023-11-1[45] /);
  });

  it('0 / 缺失 / 非数字给空串（不显示 1970）', () => {
    assert.equal(clockText(0), '');
    assert.equal(clockText(undefined), '');
    assert.equal(clockText(NaN), '');
  });
});

/* ───────────────────── run 端到端 ───────────────────── */

const ctx = (request) => ({
  secrets: { WB_ACCESS_TOKEN: TOKEN },
  request,
  log: () => {},
});

describe('run：正常路径', () => {
  it('idle → 派出，返回 success 并带上地点与归来时间', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse(STATUS_IDLE),
      'travel/config': fakeResponse(CONFIG),
      'travel/depart': fakeResponse({
        code: 0,
        data: {
          state: 'traveling',
          location: { id: 11, name: '京都' },
          depart_at: 1_700_000_100,
          arrive_at: 1_700_010_000,
          daily_limit_reached: true,
        },
      }),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'success');
    assert.equal(out.data.locationName, '京都');
    assert.match(out.message, /已派/);
    assert.equal(out.data.dailyLimitReached, true);
    // 顺序：先查状态（只读），再取配置，最后才派
    assert.deepEqual(
      request.calls.map((c) => c.key),
      ['travel/status', 'travel/config', 'travel/depart'],
    );
  });

  it('arrived → 先领、复查状态、再派', async () => {
    let statusCalls = 0;
    const request = fakeRequest({
      // 第一次：还没领；第二次：领完之后的重查
      'travel/status': () => {
        statusCalls += 1;
        return fakeResponse(
          statusCalls === 1
            ? {
                code: 0,
                data: { state: 'arrived', arrive_at: 1_700_000_000, server_now: 1_700_000_500, daily_limit_reached: false },
              }
            : STATUS_IDLE,
        );
      },
      'travel/claim': fakeResponse({ code: 0, data: { reward_credit: 7, letter: null } }),
      'travel/config': fakeResponse(CONFIG),
      'travel/depart': fakeResponse({
        code: 0,
        data: { state: 'traveling', location: { id: 12, name: '巴黎' }, arrive_at: 1_700_010_000 },
      }),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'success');
    assert.equal(out.data.credit, 7);
    assert.equal(out.data.locationName, '巴黎');
    assert.match(out.message, /领取 7 积分/);
    // 顺序：领取 → 复查（领取会改写服务端状态）→ 取地点 → 派出
    assert.deepEqual(
      request.calls.map((c) => c.key),
      ['travel/status', 'travel/claim', 'travel/status', 'travel/config', 'travel/depart'],
    );
  });

  it('领取后复查发现今日次数已用完 → 只领不派', async () => {
    let statusCalls = 0;
    const request = fakeRequest({
      'travel/status': () => {
        statusCalls += 1;
        return fakeResponse(
          statusCalls === 1
            ? {
                code: 0,
                data: { state: 'arrived', arrive_at: 1_700_000_000, server_now: 1_700_000_500, daily_limit_reached: false },
              }
            : // 领完之后服务端把今天的次数标成用尽
              { code: 0, data: { state: 'idle', server_now: 1_700_000_600, daily_limit_reached: true } },
        );
      },
      'travel/claim': fakeResponse({ code: 0, data: { reward_credit: 5 } }),
      'travel/config': fakeResponse(CONFIG),
      'travel/depart': fakeResponse({ code: 0, data: { state: 'traveling' } }),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'success');
    assert.equal(out.data.credit, 5);
    assert.ok(!request.calls.some((c) => c.key === 'travel/depart'), '不该在次数用尽后再派');
    assert.match(out.message, /领取 5 积分/);
  });

  it('traveling 未到点 → already-signed，不发任何写请求', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse({
        code: 0,
        data: { state: 'traveling', arrive_at: 1_700_010_000, server_now: 1_700_000_000, daily_limit_reached: true },
      }),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'already-signed');
    assert.match(out.message, /还在路上/);
    assert.deepEqual(request.calls.map((c) => c.key), ['travel/status']);
  });
});

describe('run：幂等与边界', () => {
  it('depart 返回 daily limit → already-signed，而不是 failed', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse(STATUS_IDLE),
      'travel/config': fakeResponse(CONFIG),
      'travel/depart': fakeResponse({ code: 40001, msg: 'daily limit reached' }, 429),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'already-signed');
    assert.equal(out.data.dailyLimitReached, true);
  });

  it('claim 返回 not arrived yet → 不算失败，继续派出', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse({
        code: 0,
        data: { state: 'traveling', arrive_at: 1_700_000_000, server_now: 1_700_000_100, daily_limit_reached: false },
      }),
      'travel/claim': fakeResponse({ code: 40002, msg: 'not arrived yet' }, 400),
      'travel/config': fakeResponse(CONFIG),
      'travel/depart': fakeResponse({ code: 0, data: { state: 'traveling', location: { id: 11, name: '京都' } } }),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'success');
    assert.equal(out.data.credit, undefined);
    assert.equal(out.data.locationName, '京都');
  });

  it('还没有 Buddy → blocked，并提示去开盲盒', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse(STATUS_IDLE),
      'travel/config': fakeResponse(CONFIG),
      'travel/depart': fakeResponse({ code: 40003, msg: 'no active buddy' }, 400),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'blocked');
    assert.match(out.message, /盲盒/);
  });

  it('地点列表为空 → blocked，不硬派一个 undefined', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse(STATUS_IDLE),
      'travel/config': fakeResponse({ code: 0, data: { locations: [] } }),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'blocked');
    assert.ok(!request.calls.some((c) => c.key === 'travel/depart'));
  });

  it('401 → config-error（提示换 token），不是 network-error', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse('<html>401</html>', 401),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'config-error');
    assert.match(out.message, /WB_ACCESS_TOKEN/);
  });

  it('返回非 JSON → blocked，并给出响应片段', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse('<html>gateway</html>', 502),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'blocked');
    assert.match(out.message, /非 JSON/);
  });

  it('网络异常 → network-error', async () => {
    const request = fakeRequest({
      'travel/status': () => new Error('socket hang up'),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'network-error');
    assert.match(out.message, /socket hang up/);
  });

  it('凭据过期时直接 config-error，不发任何请求', async () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const expired = `${enc({ alg: 'RS256' })}.${enc({ exp: Math.floor(Date.now() / 1000) - 86400 })}.sig`;
    const request = fakeRequest({});
    const out = await task.run({
      secrets: { WB_ACCESS_TOKEN: expired },
      request,
      log: () => {},
    });
    assert.equal(out.status, 'config-error');
    assert.match(out.message, /过期/);
    assert.equal(request.calls.length, 0);
  });
});
