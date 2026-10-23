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
    sent.push({ url: String(url), ua: init.headers?.['User-Agent'], headers: init.headers ?? {} });
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

describe('浏览器附带请求头', () => {
  const SAFARI_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.6 Safari/605.1.15';
  const CHROME_WIN_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  it('导航请求带 document/navigate 全套头', async () => {
    await request('https://nav.test/user', { throttle: false, ua: CHROME_WIN_UA });
    const h = sent[0].headers;
    assert.match(h.Accept, /text\/html/);
    assert.equal(h['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.8');
    assert.ok(h['Accept-Encoding'].includes('gzip'));
    assert.equal(h['Sec-Fetch-Dest'], 'document');
    assert.equal(h['Sec-Fetch-Mode'], 'navigate');
    assert.equal(h['Sec-Fetch-User'], '?1');
    assert.equal(h['Upgrade-Insecure-Requests'], '1');
  });

  it('XHR 请求用 empty/cors 与 */*，且不带 Upgrade-Insecure-Requests', async () => {
    await request('https://nav.test/user/checkin', {
      throttle: false,
      method: 'POST',
      ua: CHROME_WIN_UA,
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://nav.test/user' },
    });
    const h = sent[0].headers;
    assert.equal(h.Accept, '*/*');
    assert.equal(h['Sec-Fetch-Dest'], 'empty');
    assert.equal(h['Sec-Fetch-Mode'], 'cors');
    assert.equal(h['Upgrade-Insecure-Requests'], undefined);
  });

  it('JSON API 请求的 Accept 是 application/json', async () => {
    await request('https://api.test/claim', {
      throttle: false,
      method: 'POST',
      ua: CHROME_WIN_UA,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.match(sent[0].headers.Accept, /application\/json/);
  });

  it('Sec-Fetch-Site 由 Referer 与目标是否同源推导', async () => {
    await request('https://site.test/a', { throttle: false, ua: CHROME_WIN_UA });
    assert.equal(sent[0].headers['Sec-Fetch-Site'], 'none', '无 Referer 的导航 = 地址栏输入');

    await request('https://site.test/b', {
      throttle: false,
      ua: CHROME_WIN_UA,
      headers: { Referer: 'https://site.test/a' },
    });
    assert.equal(sent[1].headers['Sec-Fetch-Site'], 'same-origin');

    await request('https://site.test/c', {
      throttle: false,
      ua: CHROME_WIN_UA,
      headers: { Referer: 'https://other.test/a' },
    });
    assert.equal(sent[2].headers['Sec-Fetch-Site'], 'cross-site');
  });

  it('Safari 不发 Client Hints（发了就是自曝）', async () => {
    await request('https://safari.test/', { throttle: false, ua: SAFARI_UA });
    const h = sent[0].headers;
    assert.equal(h['sec-ch-ua'], undefined);
    assert.equal(h['sec-ch-ua-platform'], undefined);
  });

  it('Chrome 的 Client Hints 与 UA 平台自洽', async () => {
    await request('https://chrome.test/', { throttle: false, ua: CHROME_WIN_UA });
    const h = sent[0].headers;
    assert.match(h['sec-ch-ua'], /Chrome";v="130"/);
    assert.equal(h['sec-ch-ua-platform'], '"Windows"');
    assert.equal(h['sec-ch-ua-mobile'], '?0');
  });

  it('macOS 的 Chrome 报 macOS 平台', async () => {
    await request('https://chrome.test/', {
      throttle: false,
      headers: { 'User-Agent': DEFAULT_UA },
    });
    assert.equal(sent[0].headers['sec-ch-ua-platform'], '"macOS"');
    // 显式传入的 UA 必须胜出，不能出现「UA 是 Mac 但头里还是池中那个」
    assert.equal(sent[0].headers['User-Agent'], DEFAULT_UA);
  });

  it('调用方显式传的 header 覆盖默认值', async () => {
    await request('https://override.test/', {
      throttle: false,
      ua: CHROME_WIN_UA,
      headers: { Accept: 'application/xml' },
    });
    assert.equal(sent[0].headers.Accept, 'application/xml');
  });

  it('impersonate:false 只发 UA（调试目标站原始响应用）', async () => {
    await request('https://raw.test/', { throttle: false, ua: CHROME_WIN_UA, impersonate: false });
    const h = sent[0].headers;
    assert.equal(h['User-Agent'], CHROME_WIN_UA);
    assert.equal(h.Accept, undefined);
    assert.equal(h['Sec-Fetch-Site'], undefined);
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
