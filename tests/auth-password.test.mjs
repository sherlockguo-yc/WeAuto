/**
 * 密码哈希单元测试
 *
 * 这里守的是「登录不该快慢泄漏信息」这条线：用户不存在与密码错误必须
 * 消耗同样的时间（burnTime），否则可以用响应时间枚举出系统里有哪些用户。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import { BCRYPT_COST, burnTime, hashPassword, verifyPassword } from '../src/auth/password.mjs';

describe('hashPassword', () => {
  it('使用 cost=12', () => {
    // bcrypt 哈希格式 $2a$<cost>$...，cost 是「算多久」的参数
    assert.equal(hashPassword('correct-horse-battery').split('$')[2], String(BCRYPT_COST));
  });

  it('同一密码两次哈希结果不同（每次都有新 salt）', () => {
    assert.notEqual(hashPassword('same-password'), hashPassword('same-password'));
  });
});

describe('verifyPassword', () => {
  it('正确密码通过、错误密码不通过', () => {
    const hash = hashPassword('secret-1234');
    assert.equal(verifyPassword('secret-1234', hash), true);
    assert.equal(verifyPassword('secret-1235', hash), false);
  });

  it('哈希损坏时返回 false 而不是抛异常', () => {
    // 登录接口不该因为一行脏数据变成 500
    assert.equal(verifyPassword('x', 'not-a-bcrypt-hash'), false);
    assert.equal(verifyPassword('x', ''), false);
  });

  it('非字符串输入不会炸', () => {
    const hash = hashPassword('12345678');
    assert.equal(verifyPassword(12345678, hash), true);
    assert.equal(verifyPassword(null, hash), false);
  });
});

describe('burnTime', () => {
  it('恒返回 false', () => {
    assert.equal(burnTime('anything'), false);
  });

  it('耗时与真实校验同量级（差异 < 30%）', () => {
    const hash = hashPassword('benchmark-password');
    const t0 = Date.now();
    verifyPassword('benchmark-password', hash);
    const real = Date.now() - t0 || 1;

    const t1 = Date.now();
    burnTime('benchmark-password');
    const burn = Date.now() - t1 || 1;

    // bcrypt cost=12 一般在数百毫秒量级，量级一致即可；不断言绝对值以免机器差异误报
    assert.ok(
      Math.abs(burn - real) / real < 0.3,
      `burnTime=${burn}ms 与真实校验 ${real}ms 差距过大，会泄漏「用户是否存在」`,
    );
  });
});
