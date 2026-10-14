/**
 * token 签发验签单元测试
 *
 * 核心不变量：**verify 失败一律返回 null，不抛异常**。中间件会在每个请求上调用它，
 * 任何一条漏掉的 try/catch 都会变成 500 而不是干净的 401。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromAuthHeader, sign, verify } from '../src/auth/token.mjs';

const SECRET = 'test-secret-abc';

describe('sign / verify', () => {
  it('同一 secret 可验签，payload 保真', () => {
    const token = sign({ id: 7, username: 'sherlockguo', role: 'admin' }, SECRET);
    assert.deepEqual(verify(token, SECRET), {
      id: 7,
      username: 'sherlockguo',
      role: 'admin',
      iat: verify(token, SECRET).iat,
      exp: verify(token, SECRET).exp,
    });
  });

  it('不同 secret 验签失败并返回 null', () => {
    assert.equal(verify(sign({ id: 1 }, SECRET), 'another-secret'), null);
  });

  it('篡改过的 token 返回 null', () => {
    assert.equal(verify(`${sign({ id: 1 }, SECRET)}x`, SECRET), null);
  });

  it('过期 token 返回 null', () => {
    assert.equal(verify(sign({ id: 1 }, SECRET, '-1s'), SECRET), null);
  });

  it('缺 token / 缺 secret 均返回 null', () => {
    assert.equal(verify(null, SECRET), null);
    assert.equal(verify('abc', ''), null);
    assert.equal(verify(undefined, undefined), null);
  });

  it('没有 secret 时签发直接报错', () => {
    // 静默用 undefined 当密钥签 token 比报错危险得多
    assert.throws(() => sign({ id: 1 }, ''), /jwtSecret/);
  });
});

describe('fromAuthHeader', () => {
  it('识别 Bearer 前缀', () => {
    assert.equal(fromAuthHeader('Bearer abc.def.ghi'), 'abc.def.ghi');
  });

  it('非 Bearer / 空值返回 null', () => {
    assert.equal(fromAuthHeader('abc.def.ghi'), null);
    assert.equal(fromAuthHeader('Basic abc'), null);
    assert.equal(fromAuthHeader(undefined), null);
  });
});
