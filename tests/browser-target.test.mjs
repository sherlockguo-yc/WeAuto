import assert from 'node:assert/strict';
import { it } from 'node:test';
import { resolveBrowserTarget } from '../bin/weauto-browser-checkin.mjs';

const task = { name: 'v2free-checkin', credentialGroup: 'v2free' };
function fixture({ users = [{ id: 1, username: 'sherlockguo', status: 'active' }], credentials = [{ id: 2, userId: 1, groupName: 'v2free', label: 'v2free 账号' }], subscriptions = [{ credentialId: 2, accountKey: 'instance' }] } = {}) {
  const db = { prepare: (sql) => {
    assert.ok(!sql.includes('credential_fields'));
    if (sql.includes('FROM users')) return { get: (name, status) => users.find((u) => u.username === name && u.status === status) };
    if (sql.includes('FROM credentials')) return { all: (userId, groupName, label) => credentials.filter((c) => c.userId === userId && c.groupName === groupName && c.label === label) };
    assert.fail('unexpected metadata query');
  } };
  const store = { forUser: (userId) => ({ tasksOfTemplate: (name) => {
    assert.equal(userId, 1);
    assert.equal(name, task.name);
    return subscriptions;
  } }) };
  return { db, store };
}
function resolve(options) {
  const { db, store } = fixture(options);
  return resolveBrowserTarget(db, store, { username: 'sherlockguo', label: 'v2free 账号', task });
}
it('resolves only the named user, credential group, label and task binding', () => {
  assert.deepEqual(resolve(), { userId: 1, credentialId: 2, accountKey: 'instance' });
});
it('missing or inactive users do not permit reading credentials', () => {
  assert.throws(() => resolve({ users: [] }), /用户不存在/);
  assert.throws(() => resolve({ users: [{ id: 1, username: 'sherlockguo', status: 'disabled' }] }), /停用/);
});
it('other users or credential groups with the same label cannot be selected', () => {
  assert.throws(() => resolve({ credentials: [{ id: 2, userId: 3, groupName: 'v2free', label: 'v2free 账号' }] }), /账号不存在/);
  assert.throws(() => resolve({ credentials: [{ id: 2, userId: 1, groupName: 'workbuddy', label: 'v2free 账号' }] }), /账号不存在/);
});
it('ambiguous labels and unbound or multiply bound tasks fail before decryption', () => {
  assert.throws(() => resolve({ credentials: [2, 3].map((id) => ({ id, userId: 1, groupName: 'v2free', label: 'v2free 账号' })) }), /不唯一/);
  assert.throws(() => resolve({ subscriptions: [] }), /唯一绑定/);
  assert.throws(() => resolve({ subscriptions: [{ credentialId: 2 }, { credentialId: 2 }] }), /唯一绑定/);
});
