/**
 * http.mjs 的防封策略测试
 *
 * 守的是三件事，任何一条退化都不会让任务报错，只会让账号在目标站看来「更像机器」——
 * 属于最隐蔽的一类回归，所以必须有断言：
 *   · 同一账号的 UA 恒定（昨天 Chrome 今天 Firefox 比固定 UA 更可疑）
 *   · 不同账号的 UA 不同（否则多账号在目标站看来是同一个人）
 *   · 同一域名的请求被拉开间隔（「4 个请求 2 秒打完」是最强的自动化特征）
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_UA,
  createRequester,
  request,
  resetDomainThrottle,
  userAgentFor,
} from '../src/http.mjs';

const realFetch = globalThis.fetch;
/** 记录每次请求实际发出的 UA */
let sent = [];

beforeEach(() => {
  sent = [];
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), ua: init.headers?.['User-Agent'] });
    return new Response('ok', { status: 200 });
  };
  resetDomainThrottle();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetDomainThrottle();
});

describe('userAgentFor', () => {
  it('同一 seed 恒定（同一账号不该每天换浏览器）', () => {
    assert.equal(userAgentFor('v2free:a-1'), userAgentFor('v2free:a-1'));
  });

  it('没有 seed 时退回 DEFAULT_UA', () => {
    assert.equal(userAgentFor(), DEFAULT_UA);
    assert.equal(userAgentFor(''), DEFAULT_UA);
  });

  it('多个账号能分到不止一种 UA', () => {
    const uas = new Set(
      ['a-1', 'a-2', 'a-3', 'a-4', 'a-5'].map((k) => userAgentFor(`v2free:${k}`)),
    );
    assert.ok(uas.size >= 2, `5 个账号应至少分到 2 种 UA，实际只有 ${uas.size} 种`);
    assert.ok(!uas.has(undefined), 'UA 不能是 undefined');
  });

  it('同任务名 + 不同账号 → 种子不同 → 与只用任务名的结果可区分', () => {
    assert.notEqual(userAgentFor('v2free-checkin'), userAgentFor('v2free-checkin:a-1'));
  });
});

describe('createRequester', () => {
  it('把 seed 对应的 UA 放进请求头', async () => {
    const req = createRequester({ seed: 'v2free:a-1' });
    await req('https://example.test/x', { throttle: false });
    assert.equal(sent[0].ua, userAgentFor('v2free:a-1'));
  });

  it('不同账号发出不同 UA，同一账号两次一致', async () => {
    const a = createRequester({ seed: 'v2free:a-1' });
    const b = createRequester({ seed: 'v2free:a-2' });

    await a('https://example.test/1', { throttle: false });
    await a('https://example.test/2', { throttle: false });
    await b('https://example.test/3', { throttle: false });

    assert.equal(sent[0].ua, sent[1].ua, '同一账号两次请求的 UA 必须一致');
    // a-1 与 a-2 可能哈希到同一个 UA，这里只要求「能被区分」的账号确实不同
    if (userAgentFor('v2free:a-1') !== userAgentFor('v2free:a-2')) {
      assert.notEqual(sent[1].ua, sent[2].ua);
    }
  });

  it('调用方仍可用 headers 覆盖 UA（保留原有能力）', async () => {
    const req = createRequester({ seed: 'v2free:a-1' });
    await req('https://example.test/x', {
      throttle: false,
      headers: { 'User-Agent': 'custom-agent/1.0' },
    });
    assert.equal(sent[0].ua, 'custom-agent/1.0');
  });
});

describe('同域名节流', () => {
  it('同一域名连续两次请求至少间隔 1 秒', async () => {
    const t0 = Date.now();
    await request('https://throttle.test/a');
    await request('https://throttle.test/b');
    const gap = Date.now() - t0;
    assert.ok(gap >= 900, `同域名两次请求应间隔 ≥ 1s，实际 ${gap}ms`);
  });

  it('不同域名互不影响', async () => {
    const t0 = Date.now();
    await request('https://first.test/1');
    await request('https://second.test/1');
    const gap = Date.now() - t0;
    assert.ok(gap < 500, `不同域名不该互相等待，实际 ${gap}ms`);
  });

  it('throttle:false 跳过节流（供测试与内部脚本使用）', async () => {
    await request('https://skip.test/1', { throttle: false });
    const t0 = Date.now();
    await request('https://skip.test/2', { throttle: false });
    assert.ok(Date.now() - t0 < 200, '显式关掉节流时不应等待');
  });

  it('非法 URL 不会因为取不到 host 而抛错', async () => {
    await assert.doesNotReject(() => request('not-a-url', { throttle: false }));
  });
});
