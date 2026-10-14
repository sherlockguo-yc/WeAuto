/**
 * 邀请码
 *
 * 重点验证「同一份判断」在两处一致：
 *   · 页面显示（check）—— 告诉用户这个码还能不能用
 *   · 提交时（consume）—— 真正扣减，且并发下只能成功一次
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import {
  DEFAULT_EXPIRE_DAYS,
  MAX_EXPIRE_DAYS,
  MAX_USES,
  createInvites,
  newInviteCode,
} from '../src/invites.mjs';

const OWNER = 1;
const DAY = 86_400_000;

let dir;
const dbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-invites-'));
});

after(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function fresh() {
  const db = openDb(path.join(dir, `db-${++seq}.sqlite`));
  const ins = db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)',
  );
  // 外键是开的：used_by / created_by 必须是真实存在的账号
  ins.run(OWNER, 'owner', 'x', 'admin', 'active', 1);
  for (const id of [2, 3, 4]) ins.run(id, `guest-${id}`, 'x', 'user', 'active', 1);
  dbs.push(db);
  return { db, invites: createInvites(db) };
}

describe('生成', () => {
  it('默认单次使用、7 天过期', () => {
    const { invites } = fresh();
    const row = invites.create({ createdBy: OWNER });
    assert.ok(row.code.length > 30, '码要足够长，不可猜');
    assert.equal(row.max_uses, 1);
    assert.ok(row.expires_at > Date.now());
    assert.ok(row.expires_at - row.created_at <= (DEFAULT_EXPIRE_DAYS + 1) * DAY);
  });

  it('可以指定有效期与次数，0 天表示长期', () => {
    const { invites } = fresh();
    const long = invites.create({ createdBy: OWNER, expiresInDays: 0, maxUses: 5 });
    assert.equal(long.expires_at, null);
    assert.equal(long.max_uses, 5);
  });

  it('次数与有效期被夹在合理区间（否则一个码就是永久凭证）', () => {
    const { invites } = fresh();
    const many = invites.create({ createdBy: OWNER, maxUses: 999999 });
    assert.equal(many.max_uses, MAX_USES);

    const long = invites.create({ createdBy: OWNER, expiresInDays: 9999 });
    assert.ok(long.expires_at - long.created_at <= MAX_EXPIRE_DAYS * DAY + 1000);
  });

  it('两个码互不相同', () => {
    const { invites } = fresh();
    assert.notEqual(
      invites.create({ createdBy: OWNER }).code,
      invites.create({ createdBy: OWNER }).code,
    );
    assert.notEqual(newInviteCode(), newInviteCode());
  });
});

describe('校验', () => {
  it('新码可用', () => {
    const { invites } = fresh();
    const row = invites.create({ createdBy: OWNER });
    const checked = invites.check(row.code);
    assert.equal(checked.ok, true);
    assert.equal(checked.invite.code, row.code);
  });

  it('不存在的码、空码都能识别', () => {
    const { invites } = fresh();
    assert.equal(invites.check('nope').reason, 'not-found');
    assert.equal(invites.check('').reason, 'missing');
    assert.equal(invites.check(null).reason, 'missing');
  });

  it('过期后不可用', () => {
    const { invites } = fresh();
    const row = invites.create({ createdBy: OWNER, expiresInDays: 1 });
    const later = Date.now() + 2 * DAY;
    assert.equal(invites.check(row.code, later).reason, 'expired');
  });

  it('用完后不可用', () => {
    const { invites } = fresh();
    const row = invites.create({ createdBy: OWNER, maxUses: 1 });
    assert.equal(invites.consume(row.code, 2), true);
    assert.equal(invites.check(row.code).reason, 'exhausted');
  });

  it('撤销后不可用，且撤销不可重复', () => {
    const { invites } = fresh();
    const row = invites.create({ createdBy: OWNER });
    assert.equal(invites.revoke(row.code), true);
    assert.equal(invites.revoke(row.code), false);
    assert.equal(invites.check(row.code).reason, 'revoked');
  });
});

describe('消耗', () => {
  it('多次码可以用到上限为止', () => {
    const { invites } = fresh();
    const row = invites.create({ createdBy: OWNER, maxUses: 2 });
    assert.equal(invites.consume(row.code, 2), true);
    assert.equal(invites.consume(row.code, 3), true);
    assert.equal(invites.consume(row.code, 4), false, '第三次应该失败');
  });

  it('并发重放：只有一个能成功（条件更新的 changes 判定胜负）', () => {
    const { invites } = fresh();
    const row = invites.create({ createdBy: OWNER, maxUses: 1 });
    // 连着调用两次，模拟两个请求同时提交
    const first = invites.consume(row.code, 2);
    const second = invites.consume(row.code, 3);
    assert.equal([first, second].filter(Boolean).length, 1);
  });

  it('撤销之后即使没用过也消耗不掉', () => {
    const { invites } = fresh();
    const row = invites.create({ createdBy: OWNER });
    invites.revoke(row.code);
    assert.equal(invites.consume(row.code, 2), false);
  });

  it('记录是谁用的', () => {
    const { invites } = fresh();
    const row = invites.create({ createdBy: OWNER });
    invites.consume(row.code, 2);
    const found = invites.list(10).find((r) => r.code === row.code);
    assert.equal(found.used_by, 2);
    assert.equal(found.used_count, 1);
  });
});

describe('列表展示', () => {
  it('状态能被正确描述', () => {
    const { invites } = fresh();
    const unused = invites.create({ createdBy: OWNER });
    assert.equal(invites.describe(unused).state, 'unused');

    const partial = invites.create({ createdBy: OWNER, maxUses: 2 });
    invites.consume(partial.code, 2);
    assert.equal(invites.describe(invites.list(10).find((r) => r.code === partial.code)).state, 'partial');

    const used = invites.create({ createdBy: OWNER });
    invites.consume(used.code, 2);
    assert.equal(invites.describe(invites.list(10).find((r) => r.code === used.code)).state, 'used');

    const revoked = invites.create({ createdBy: OWNER });
    invites.revoke(revoked.code);
    assert.equal(invites.describe(invites.list(10).find((r) => r.code === revoked.code)).state, 'revoked');

    const expired = invites.create({ createdBy: OWNER, expiresInDays: 1 });
    assert.equal(invites.describe(expired, Date.now() + 2 * DAY).state, 'expired');
  });
});
