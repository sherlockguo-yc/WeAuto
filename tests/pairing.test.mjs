/**
 * 配对码 / pushToken 的单元测试
 *
 * 这里最要命的两个性质，都是「错了不会报错、只会安静地放行」：
 *   · 配对码必须**一次性**（能重复兑换就等于给了一条永久后门）
 *   · 配对码必须**会过期**（命令行里的码会被 shell 历史与进程列表看到）
 * 所以断言都围绕这两个性质，而不是「长得像不像」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createPairing,
  looksLikeJwt,
  makePushToken,
  parsePushToken,
  sameSecret,
  tokenExpiryMs,
} from '../src/pairing.mjs';

const NOW = Date.parse('2026-10-20T17:00:00+08:00');

describe('配对码', () => {
  it('发出来能兑换，返回原来的 userId / credentialId', () => {
    const p = createPairing({ now: () => NOW });
    const { code } = p.issue({ userId: 7, credentialId: 42 });
    assert.deepEqual(p.redeem(code), { userId: 7, credentialId: 42 });
  });

  it('一次性：兑换过就再也兑换不了', () => {
    const p = createPairing({ now: () => NOW });
    const { code } = p.issue({ userId: 1, credentialId: 1 });
    assert.ok(p.redeem(code));
    assert.equal(p.redeem(code), null);
  });

  it('过期后兑换失败', () => {
    let t = NOW;
    const p = createPairing({ now: () => t, ttlMs: 1000 });
    const { code } = p.issue({ userId: 1, credentialId: 1 });
    t = NOW + 1001;
    assert.equal(p.redeem(code), null);
  });

  it('大小写与首尾空格都能容忍（用户会照着手抄）', () => {
    const p = createPairing({ now: () => NOW });
    const { code } = p.issue({ userId: 1, credentialId: 1 });
    assert.ok(p.redeem(`  ${code.toLowerCase()}  `));
  });

  it('乱填的码返回 null，且不影响已发出的码', () => {
    const p = createPairing({ now: () => NOW });
    const { code } = p.issue({ userId: 1, credentialId: 1 });
    assert.equal(p.redeem('AAAA-AAAA'), null);
    assert.equal(p.redeem(''), null);
    assert.equal(p.redeem(null), null);
    assert.ok(p.redeem(code), '瞎猜不应该消耗真正的码');
  });

  it('码里不含容易看错的 0/O/1/I', () => {
    const p = createPairing({ now: () => NOW });
    for (let i = 0; i < 20; i++) {
      const { code } = p.issue({ userId: 1, credentialId: 1 });
      assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('过期的码会被清理，不会越攒越多', () => {
    let t = NOW;
    const p = createPairing({ now: () => t, ttlMs: 1000 });
    for (let i = 0; i < 5; i++) p.issue({ userId: 1, credentialId: 1 });
    assert.equal(p.pending, 5);
    t = NOW + 2000;
    assert.equal(p.pending, 0);
  });
});

describe('pushToken', () => {
  it('生成后能解析出 userId / credentialId', () => {
    const token = makePushToken({ userId: 12, credentialId: 34 });
    assert.deepEqual(parsePushToken(token), { userId: 12, credentialId: 34, taskId: null });
  });

  /*
   * 升级前发出去的令牌里只有 taskId。用户机器上那份脚本还会每月自动跑，
   * 不能因为一次升级就全部失效——解析出来交给调用方去查任务现在引用的账号。
   */
  it('兼容旧的 wt1 令牌（只有 taskId）', () => {
    const parsed = parsePushToken('wt1_12_34_abcdefghijklmnop');
    assert.deepEqual(parsed, { userId: 12, credentialId: null, taskId: 34 });
  });

  it('格式不对的令牌一律拒绝', () => {
    for (const bad of ['', 'wt2_1_2', 'wt2_1_2_short', 'xx_1_2_abcdefghijklmnop', null, undefined]) {
      assert.equal(parsePushToken(bad), null, `${JSON.stringify(bad)} 不该被接受`);
    }
  });

  it('两次生成的结果不同（不带可预测的序列）', () => {
    const a = makePushToken({ userId: 1, credentialId: 1 });
    const b = makePushToken({ userId: 1, credentialId: 1 });
    assert.notEqual(a, b);
  });
});

describe('sameSecret', () => {
  it('相同返回 true，不同返回 false', () => {
    assert.equal(sameSecret('abc123', 'abc123'), true);
    assert.equal(sameSecret('abc123', 'abc124'), false);
  });

  it('长度不同返回 false 而不是抛错', () => {
    assert.equal(sameSecret('abc', 'abcdef'), false);
  });

  it('空值不算匹配（避免两个空字符串被当成一致）', () => {
    assert.equal(sameSecret('', ''), false);
    assert.equal(sameSecret(null, null), false);
  });
});

describe('looksLikeJwt', () => {
  it('三段式 eyJ 开头的字符串通过', () => {
    assert.equal(
      looksLikeJwt('eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE4OTM0NTYwMDB9.c2lnbmF0dXJlLXNpZ24'),
      true,
    );
  });

  it('半截的、粘错的、别的东西都拒绝', () => {
    for (const bad of ['', 'eyJhbGciOiJSUzI1NiJ9', 'session=abc', 'eyJ.短.sig', null]) {
      assert.equal(looksLikeJwt(bad), false, `${JSON.stringify(bad)} 不该被接受`);
    }
  });
});

describe('tokenExpiryMs', () => {
  it('从 exp 取到毫秒', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1893456000 })).toString('base64url');
    assert.equal(tokenExpiryMs(`eyJhbGciOiJSUzI1NiJ9.${payload}.c2ln`), 1893456000 * 1000);
  });

  it('解不出来时返回 null 而不是抛错', () => {
    assert.equal(tokenExpiryMs('not-a-jwt'), null);
    assert.equal(tokenExpiryMs(''), null);
  });
});
