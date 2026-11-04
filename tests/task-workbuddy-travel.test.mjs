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
  departedToday,
  parseTravel,
  pickLocation,
  planFor,
  resumeAtFor,
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

/* ───────────────────── 续跑时间 ───────────────────── */

describe('resumeAtFor', () => {
  it('用 arrive_at 与 server_now 的差值算，不受本机时钟影响', () => {
    // 还剩 600 秒，缓冲 60 秒 → 本机时间 + 660 秒
    assert.equal(resumeAtFor({ arriveAt: 1_000, serverNow: 400 }, 5_000, 60), 5_000 + 660_000);
  });

  it('已经到点 / 字段缺失 → 0（不给框架排一个过去的时间）', () => {
    assert.equal(resumeAtFor({ arriveAt: 100, serverNow: 100 }), 0);
    assert.equal(resumeAtFor({ arriveAt: 100, serverNow: 200 }), 0);
    assert.equal(resumeAtFor({}), 0);
  });
});

describe('departedToday', () => {
  const at = (iso) => Date.parse(iso);

  it('同一天派出 → true（领完就结束，今天名额已用）', () => {
    const snap = { departAt: at('2026-11-04T09:30:00+08:00') / 1000 };
    assert.equal(departedToday(snap, at('2026-11-04T12:00:00+08:00')), true);
  });

  it('昨天派出、今天归来 → false（领完可以接着派）', () => {
    const snap = { departAt: at('2026-11-03T23:00:00+08:00') / 1000 };
    assert.equal(departedToday(snap, at('2026-11-04T01:00:00+08:00')), false);
  });

  it('没有 depart_at → false（不猜）', () => {
    assert.equal(departedToday({}, Date.now()), false);
  });
});

/* ───────────────────── run 端到端 ───────────────────── */

const ctx = (request, trigger = 'schedule') => ({
  secrets: { WB_ACCESS_TOKEN: TOKEN },
  request,
  log: () => {},
  trigger,
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

/**
 * 续跑：一轮「派出 → 归来领」只有一条执行记录。
 * 时间一律用服务端时间戳，避免测试依赖跑测试那台机器的时钟。
 */
describe('run：续跑', () => {
  const DEPART_AT = 1_700_000_100; // 服务端秒级时间戳（2023-11-14 约 22:15 北京时间）

  it('派出成功 → 交回 resumeAt（剩余时长 + 缓冲），并标为归来领取', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse(STATUS_IDLE),
      'travel/config': fakeResponse(CONFIG),
      'travel/depart': fakeResponse({
        code: 0,
        data: {
          state: 'traveling',
          location: { id: 11, name: '京都' },
          depart_at: DEPART_AT,
          arrive_at: DEPART_AT + 7200,
          server_now: DEPART_AT,
          daily_limit_reached: false,
        },
      }),
    });
    const before = Date.now();
    const out = await task.run(ctx(request));

    const expected = 7200 * 1000 + 90_000;
    assert.ok(out.resumeAt >= before + expected, '不能早于理论归来时刻');
    assert.ok(out.resumeAt <= Date.now() + expected + 2000, '也不该晚太多');
    assert.equal(out.resumeNote, '归来领取');
  });

  it('已在路上（本次不是续跑）→ 也算好归来时刻，上线时在途的号能自愈', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse({
        code: 0,
        data: {
          state: 'traveling',
          depart_at: DEPART_AT,
          arrive_at: DEPART_AT + 3600,
          server_now: DEPART_AT + 600,
          daily_limit_reached: true,
        },
      }),
    });
    const out = await task.run(ctx(request));
    assert.equal(out.status, 'already-signed');
    assert.ok(out.resumeAt > Date.now(), '必须排上下半场，否则要等到明天');
  });

  it('续跑触发且这趟是今天派的 → 只领不派（当天名额已用）', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse({
        code: 0,
        data: {
          state: 'arrived',
          // 服务端说 daily_limit 还没用尽，但 depart_at 是今天 → 仍然不该派
          depart_at: DEPART_AT,
          arrive_at: DEPART_AT + 3600,
          server_now: DEPART_AT + 3700,
          daily_limit_reached: false,
        },
      }),
      'travel/claim': fakeResponse({ code: 0, data: { reward_credit: 8, letter: null } }),
      'travel/config': fakeResponse(CONFIG),
      'travel/depart': fakeResponse({ code: 0, data: { state: 'traveling' } }),
    });
    const out = await task.run(ctx(request, 'resume'));

    assert.equal(out.data.credit, 8);
    assert.ok(!request.calls.some((c) => c.key === 'travel/depart'), '当天已派出，不该再派');
    assert.equal(out.resumeAt, undefined, '领完这一轮就结束了');
  });

  it('续跑触发但服务端说还没到 → 10 分钟后再试，而不是当成结束', async () => {
    const request = fakeRequest({
      'travel/status': fakeResponse({
        code: 0,
        data: {
          state: 'traveling',
          depart_at: DEPART_AT,
          arrive_at: DEPART_AT + 3600,
          server_now: DEPART_AT + 3660,
          daily_limit_reached: true,
        },
      }),
      'travel/claim': fakeResponse({ code: 40002, msg: 'not arrived yet' }, 400),
    });
    const out = await task.run(ctx(request, 'resume'));
    assert.ok(out.resumeAt >= Date.now() + 9 * 60_000, '要在 10 分钟后重试');
    assert.match(out.resumeNote, /状态落库/);
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
