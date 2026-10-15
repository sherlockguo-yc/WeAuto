/**
 * HTTP 服务测试（真实起服务 + 真实 fetch）
 *
 * 重点验证四件在浏览器里不容易发现的事：
 *   · 未登录时页面跳转、接口 401（而不是把数据吐出去）
 *   · 页面里的外部数据被正确转义（任务结果来自第三方站点，属不可信输入）
 *   · 写操作拒绝跨站请求（CSRF）
 *   · 凭据值**绝不**出现在任何响应里
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db.mjs';
import { createStore } from '../src/store.mjs';
import { createUserSecrets, generateMasterKey } from '../src/user-secrets.mjs';
import { createAuth } from '../src/auth/index.mjs';
import { createInvites } from '../src/invites.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { createServer } from '../src/server.mjs';

const NOW = Date.parse('2026-10-14T12:00:00+08:00');

const DEMO_TASK = {
  name: 'demo-task',
  displayName: '演示任务',
  description: '用于测试',
  group: '测试',
  tags: [],
  requires: ['DEMO_TOKEN'],
  accounts: false,
  timeoutMs: 60_000,
  retention: { days: 90, maxRows: 2000, logDays: 30 },
  schedule: { kind: 'window', window: { start: '09:00', end: '09:50' } },
  view: [
    { key: 'remainTraffic', label: '剩余流量', type: 'bytes' },
    { key: 'note', label: '备注', type: 'text' },
  ],
  run: async () => ({ status: 'success' }),
};

let dir;
const servers = [];
const dbs = [];

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weauto-server-'));
});

after(() => {
  for (const s of servers) s.close();
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const USER_ID = 1;

let seq = 0;
/**
 * @param {boolean} [seedUser] 默认预建一个 admin（id=1）并订阅演示模板。
 *   多租户后「看得到任务」的前提是「订阅了它」，不预置就什么都看不到。
 *   测「首次初始化」的用例要传 false。
 */
async function startServer({
  execute,
  seedUser = true,
  seedSubscription = true,
  limits,
  seedRole = 'admin',
  extraTasks = [],
} = {}) {
  const db = openDb(path.join(dir, `db-${++seq}.sqlite`));
  dbs.push(db);
  const store = createStore(db, { limits });
  const tasks = new Map([[DEMO_TASK.name, { ...DEMO_TASK }]]);
  for (const t of extraTasks) tasks.set(t.name, { ...t });
  const auth = createAuth({ db, jwtSecret: 'test-secret' });
  if (seedUser) {
    auth.register({ username: 'tester', password: 'pass-word-1', role: seedRole });
    if (seedSubscription) store.forUser(USER_ID).subscribe(DEMO_TASK.name);
  }
  const scheduler = createScheduler({
    store,
    tasks,
    execute: execute ?? (async () => null),
    now: () => NOW,
    log: () => {},
  });
  const userSecrets = createUserSecrets(db, generateMasterKey());
  const invites = createInvites(db);
  const app = createServer({
    store,
    auth,
    tasks,
    scheduler,
    config: { trustProxy: true },
    userSecrets,
    invites,
    db,
    now: () => NOW,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, store, auth, scheduler, invites, db };
}

/**
 * 拿到会话 cookie。
 * 默认走 `/login`（账号由 startServer 预建）；`viaSetup` 走「首次初始化创建管理员」这条路。
 */
async function login(base, { viaSetup = false } = {}) {
  const res = await fetch(`${base}${viaSetup ? '/setup' : '/login'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'tester', password: 'pass-word-1' }),
    redirect: 'manual',
  });
  const cookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')];
  return cookies.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

describe('未登录时的边界', () => {
  it('/healthz 不需要登录（供外部探活）', async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.templates, 1); // 不鉴权的接口只能报平台级信息
  });

  it('页面跳转到登录页，接口返回 401', async () => {
    const { base } = await startServer();

    const page = await fetch(`${base}/tasks`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /^\/login/);

    const api = await fetch(`${base}/api/tasks`);
    assert.equal(api.status, 401);
  });

  it('首次访问登录页时给出「创建管理员」而不是登录表单', async () => {
    const { base } = await startServer({ seedUser: false });
    const html = await (await fetch(`${base}/login`)).text();
    assert.match(html, /创建管理员/);
  });
});

describe('初始化与登录', () => {
  it('创建管理员后即可访问页面，且登录页变成普通登录', async () => {
    const { base } = await startServer({ seedUser: false });
    const cookie = await login(base, { viaSetup: true });
    assert.ok(cookie.includes('wa_session'));

    const res = await fetch(`${base}/tasks`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /演示任务/);

    // 已有账号后，/setup 不能再创账号
    const again = await fetch(`${base}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'hacker', password: 'pass-word-1' }),
      redirect: 'manual',
    });
    assert.equal(again.status, 403);
  });

  it('密码错误返回 401 且不设置会话', async () => {
    const { base } = await startServer();
    await login(base);
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'tester', password: 'wrong-password' }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

describe('页面渲染与转义', () => {
  it('任务返回的文本被转义（外部数据是不可信输入）', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);

    store.forUser(USER_ID).appendRun({
      taskName: 'demo-task',
      date: '2026-10-14',
      ts: NOW,
      status: 'success',
      message: '<script>alert(1)</script>',
      data: { remainTraffic: 2048, note: '<img src=x onerror=alert(2)>' },
    });

    const html = await (await fetch(`${base}/tasks/demo-task`, { headers: { cookie } })).text();
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal(html.includes('<img src=x'), false);
    // view 声明的字段被格式化渲染
    assert.match(html, /2\.0 KB/);
  });
});

describe('接口行为', () => {
  it('立即执行：启动后返回 started，且执行中再次点击返回 409', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const { base, store } = await startServer({
      execute: async (task, { trigger }) => {
        await gate;
        return store.forUser(USER_ID).appendRun({
          taskName: task.name,
          date: '2026-10-14',
          ts: NOW,
          status: 'success',
          message: 'done',
          trigger,
        });
      },
    });
    const cookie = await login(base);

    const first = await fetch(`${base}/api/tasks/demo-task/run`, { method: 'POST', headers: { cookie } });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { started: true });

    const second = await fetch(`${base}/api/tasks/demo-task/run`, { method: 'POST', headers: { cookie } });
    assert.equal(second.status, 409);

    release();
  });

  it('未知任务返回 404', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    assert.equal((await fetch(`${base}/api/tasks/nope`, { headers: { cookie } })).status, 404);
    assert.equal(
      (await fetch(`${base}/api/tasks/nope/run`, { method: 'POST', headers: { cookie } })).status,
      404,
    );
  });

  it('启停任务写入订阅，取消订阅后任务不再是启用状态', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks/demo-task`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200);

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks[0].enabled, false);
    assert.equal(list.tasks[0].todayStatus, 'disabled');

    const cleared = await fetch(`${base}/api/tasks/demo-task/override`, { method: 'DELETE', headers: { cookie } });
    assert.deepEqual(await cleared.json(), { ok: true, cleared: true });
    const after = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    // 取消订阅 = 不再有这个实例，所以是 disabled 而不是「回到模板默认」
    assert.equal(after.tasks[0].enabled, false);
  });

  it('凭据接口只返回字段名与是否已设置，绝不返回值', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const html = await (await fetch(`${base}/credentials`, { headers: { cookie } })).text();
    assert.match(html, /DEMO_TOKEN/);
    // 本机没有 age 私钥/密文，页面应给出可读的原因而不是崩掉
    assert.match(html, /凭据不可用|已设置|缺失/);
  });
});

describe('调度配置（用户配自己的时间必须生效）', () => {
  it('网页改的调度能存进订阅，调度器读到的就是它', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks/demo-task`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 10 } } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.subscription.schedule.kind, 'every');
    assert.equal(body.subscription.schedule.every.minutes, 10);

    // 模板本身是 window，但订阅里是 every —— 调度器必须认订阅里的
    assert.equal(store.forUser(USER_ID).getSubscription('demo-task').schedule.every.minutes, 10);
  });

  it('非法调度返回 400，而不是被静默忽略', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks/demo-task`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 0 } } }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /调度配置无效/);
  });

  it('低于间隔下限返回 400', async () => {
    const { base } = await startServer({ limits: { minIntervalMinutes: 5 } });
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks/demo-task`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 1 } } }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /不能小于 5 分钟/);
  });

  it('传 null 回到模板默认', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);

    await fetch(`${base}/api/tasks/demo-task`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 10 } } }),
    });
    const back = await fetch(`${base}/api/tasks/demo-task`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: null }),
    });
    assert.equal(back.status, 200);
    assert.equal(store.forUser(USER_ID).getSubscription('demo-task').schedule, null);
  });

  it('普通用户（非 admin）也能改自己的订阅', async () => {
    const { base } = await startServer({ seedRole: 'user' });
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks/demo-task`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 15 } } }),
    });
    assert.equal(res.status, 200, '改自己的任务不该要求 admin');
    assert.equal((await res.json()).subscription.schedule.every.minutes, 15);
  });

  it('改自己的订阅不会动到别人的', async () => {
    const { base, store, auth } = await startServer({ seedRole: 'user' });
    auth.register({ username: 'other', password: 'pass-word-2', role: 'user' });
    store.forUser(2).subscribe('demo-task');

    const cookie = await login(base);
    await fetch(`${base}/api/tasks/demo-task`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 15 } } }),
    });

    assert.equal(store.forUser(USER_ID).getSubscription('demo-task').schedule.every.minutes, 15);
    assert.equal(store.forUser(2).getSubscription('demo-task').schedule, null, '别人的订阅没被碰到');
  });

  it('配置页给出可编辑的调度表单', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const html = await (await fetch(`${base}/tasks/demo-task/config`, { headers: { cookie } })).text();

    assert.match(html, /data-action="save-schedule"/);
    assert.match(html, /name="kind"/);
    assert.match(html, /跟随模板默认/);
    assert.equal(html.includes('网页上改调度时间将在下一批支持'), false);
  });
});

describe('执行历史默认隐藏跳过记录', () => {
  it('skipped 默认不出现，加 ?all=1 才显示', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    store.forUser(USER_ID).appendRun({ taskName: 'demo-task', date: '2026-10-14', ts: NOW, status: 'success', message: '一次成功的执行' });
    store.forUser(USER_ID).appendRun({
      taskName: 'demo-task',
      date: '2026-10-14',
      ts: NOW - 1000,
      status: 'skipped',
      message: '一条被跳过的记录',
    });

    const def = await (await fetch(`${base}/tasks/demo-task`, { headers: { cookie } })).text();
    assert.equal(def.includes('一条被跳过的记录'), false);
    assert.match(def, /显示另外 1 条已跳过/);

    const all = await (await fetch(`${base}/tasks/demo-task?all=1`, { headers: { cookie } })).text();
    assert.match(all, /一条被跳过的记录/);

    // 接口口径一致
    const api = await (await fetch(`${base}/api/tasks/demo-task`, { headers: { cookie } })).json();
    assert.equal(api.hiddenSkipped, 1);
    assert.deepEqual(api.runs.map((r) => r.status), ['success']);
  });
});

describe('停用要即时生效', () => {
  it('账号被停用后，已经签发的会话立刻失效', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status, 200);

    const me = auth.listUsers().find((u) => u.username === 'tester');
    auth.setStatus(me.id, 'disabled');

    // token 本身没过期，但账号状态变了 —— 不能让他继续用 7 天
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status, 401);
    const page = await fetch(`${base}/tasks`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(page.status, 302);
  });
});

describe('多账号展示', () => {
  it('一个订阅两个账号 → 列表里两行', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    const extra = store.forUser(USER_ID).addAccount('demo-task', { label: '小号' });

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks.length, 2, '每个账号一行');
    assert.deepEqual(
      list.tasks.map((t) => t.accountKey).sort(),
      ['', extra].sort(),
    );
    assert.equal(list.tasks.find((t) => t.accountKey === extra).accountLabel, '小号');
  });

  it('各账号状态独立：一个成功不影响另一个', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    const extra = store.forUser(USER_ID).addAccount('demo-task', { label: '小号' });
    store.forUser(USER_ID).appendRun({
      taskName: 'demo-task',
      accountKey: '',
      date: '2026-10-14',
      ts: NOW,
      status: 'success',
    });

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    const main = list.tasks.find((t) => t.accountKey === '');
    const second = list.tasks.find((t) => t.accountKey === extra);
    assert.equal(main.todayStatus, 'success');
    assert.notEqual(second.todayStatus, 'success', '另一个账号不该被当成已完成');
  });

  it('详情页按账号过滤历史', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    const extra = store.forUser(USER_ID).addAccount('demo-task', { label: '小号' });
    store.forUser(USER_ID).appendRun({
      taskName: 'demo-task',
      accountKey: '',
      date: '2026-10-14',
      ts: NOW,
      status: 'success',
      message: '默认账号',
    });
    store.forUser(USER_ID).appendRun({
      taskName: 'demo-task',
      accountKey: extra,
      date: '2026-10-14',
      ts: NOW + 1,
      status: 'failed',
      message: '小号',
    });

    const main = await (await fetch(`${base}/api/tasks/demo-task`, { headers: { cookie } })).json();
    assert.equal(main.runs.length, 1);
    assert.equal(main.runs[0].message, '默认账号');

    const other = await (
      await fetch(`${base}/api/tasks/demo-task?account=${extra}`, { headers: { cookie } })
    ).json();
    assert.equal(other.runs.length, 1);
    assert.equal(other.runs[0].message, '小号');
  });

  it('任务页里多账号的标题带账号名', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    store.forUser(USER_ID).addAccount('demo-task', { label: '小号' });

    const html = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.match(html, /演示任务 · 小号/);
  });
});

describe('账号删除', () => {
  it('删号会连带清掉他的一切（订阅、凭据、历史）', async () => {
    const { base, db, store, auth, invites } = await startServer();
    const cookie = await login(base);
    auth.register({ username: 'goner', password: 'pass-word-1', role: 'user' });
    const victim = auth.listUsers().find((u) => u.username === 'goner');
    store.forUser(victim.id).subscribe('demo-task');
    store.forUser(victim.id).appendRun({
      taskName: 'demo-task',
      date: '2026-10-14',
      ts: NOW,
      status: 'success',
    });

    const res = await fetch(`${base}/api/users/${victim.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 200);

    assert.equal(auth.listUsers().some((u) => u.username === 'goner'), false);
    assert.equal(
      store.allUserIds().includes(victim.id),
      false,
      '订阅应被清掉',
    );
    // runs 没有外键兜底，最容易留成孤儿行
    const left = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE user_id = ?').get(victim.id).n;
    assert.equal(left, 0, '执行历史不该留下没有主人的孤儿行');
  });

  it('不能删除自己', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);
    const me = auth.listUsers().find((u) => u.username === 'tester');

    const res = await fetch(`${base}/api/users/${me.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /不能删除自己/);
  });

  it('普通用户删不了别人', async () => {
    const { base, auth } = await startServer({ seedRole: 'user' });
    const cookie = await login(base);
    const other = auth.listUsers().find((u) => u.id !== USER_ID) ?? { id: 999 };

    assert.equal((await fetch(`${base}/api/users/${other.id}`, { method: 'DELETE', headers: { cookie } })).status, 403);
  });
});

describe('平台概览（仅 admin）', () => {
  it('admin 能看到平台页', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/admin`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /启用中的实例/);
    assert.match(html, /最近 7 天失败最多/);
  });

  it('普通用户访问返回 403，导航里也没有入口', async () => {
    const { base } = await startServer({ seedRole: 'user' });
    const cookie = await login(base);

    assert.equal((await fetch(`${base}/admin`, { headers: { cookie } })).status, 403);
    const html = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.equal(html.includes('href="/admin"'), false, '导航里不该出现平台入口');
  });
});

describe('概览统计', () => {
  it('未启用的模板不计入统计，也不出现在「需要注意」里', async () => {
    const { base } = await startServer({ seedSubscription: false });
    const cookie = await login(base);
    const data = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();

    assert.equal(data.items.length, 1, '列表里仍然要能看到它（供启用）');
    assert.equal(data.byStatus.disabled, 0, '没启用不该被算成「停用」');
    assert.equal(data.attention.length, 0, '没启用不该出现在需要注意里');
  });
});

describe('注销与改密', () => {
  it('退出登录后，那份 cookie 立刻失效', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status, 200);

    await fetch(`${base}/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    // 只清浏览器 cookie 的话，这份值在 7 天内仍然有效——必须服务端也作废
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status, 401);
  });

  it('改密码后旧会话失效', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);
    const me = auth.listUsers().find((u) => u.username === 'tester');

    auth.setPassword(me.id, 'another-pass-1');
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status, 401);
  });
});

describe('邀请注册', () => {
  async function makeInvite(base, cookie, opts = {}) {
    const res = await fetch(`${base}/api/invites`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '测试用', ...opts }),
    });
    assert.equal(res.status, 200);
    return await res.json();
  }

  const signUp = (base, code, username, password) =>
    fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, username, password }),
      redirect: 'manual',
    });

  it('没有邀请码时不给注册表单（默认只接受邀请）', async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/register`);
    assert.equal(res.status, 403);
    assert.match(await res.text(), /只接受邀请注册/);
  });

  it('凭邀请码能注册：注册后直接登录，角色是普通用户', async () => {
    const { base, auth, invites } = await startServer();
    const cookie = await login(base);
    const { invite, url } = await makeInvite(base, cookie);
    assert.match(url, /\/register\?code=/);

    const page = await fetch(`${base}/register?code=${invite.code}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /创建账号/);

    const res = await signUp(base, invite.code, 'newbie', 'pass-word-1');
    assert.equal(res.status, 302);
    const cookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')];
    assert.ok(
      cookies.filter(Boolean).join(';').includes('wa_session'),
      '注册成功应直接签发会话',
    );

    const created = auth.listUsers().find((u) => u.username === 'newbie');
    assert.equal(created.role, 'user', '邀请码不能拿到管理员');
    assert.equal(invites.check(invite.code).reason, 'exhausted');
  });

  it('同一个码注册第二次被拒', async () => {
    const { base, invites } = await startServer();
    const cookie = await login(base);
    const { invite } = await makeInvite(base, cookie);

    assert.equal((await signUp(base, invite.code, 'first', 'pass-word-1')).status, 302);
    const second = await signUp(base, invite.code, 'second', 'pass-word-1');
    assert.equal(second.status, 403);
    assert.match(await second.text(), /已用完/);
  });

  it('撤销后的码不能注册', async () => {
    const { base, invites } = await startServer();
    const cookie = await login(base);
    const { invite } = await makeInvite(base, cookie);
    assert.equal(invites.revoke(invite.code), true);

    const res = await signUp(base, invite.code, 'nope', 'pass-word-1');
    assert.equal(res.status, 403);
    assert.match(await res.text(), /已被撤销/);
  });

  it('注册失败（密码太短）时不会消耗邀请码', async () => {
    const { base, invites, auth } = await startServer();
    const cookie = await login(base);
    const { invite } = await makeInvite(base, cookie);

    const res = await signUp(base, invite.code, 'shorty', '123');
    assert.equal(res.status, 400);
    assert.equal(invites.check(invite.code).ok, true, '码应该还能用');
    assert.equal(auth.listUsers().some((u) => u.username === 'shorty'), false);
  });

  it('普通用户不能生成邀请码', async () => {
    const { base } = await startServer({ seedRole: 'user' });
    const cookie = await login(base);
    const res = await fetch(`${base}/api/invites`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'x' }),
    });
    assert.equal(res.status, 403);
  });

  it('设置页给管理员显示邀请码管理', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    await makeInvite(base, cookie, { note: '给小明' });

    const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    assert.match(html, /data-action="create-invite"/);
    assert.match(html, /给小明/);
    assert.match(html, /\/register\?code=/);
  });

  it('注册页写明管理员可解密凭据', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const { invite } = await makeInvite(base, cookie);
    const html = await (await fetch(`${base}/register?code=${invite.code}`)).text();
    assert.match(html, /管理员在技术上可以解密/);
  });
});

describe('模板市场（只能启用平台提供的模板）', () => {
  const INTERNAL_TASK = {
    ...DEMO_TASK,
    name: 'internal-task',
    displayName: '内部模板',
    visibility: 'internal',
  };

  it('未启用的模板能启用，启用后进入我的任务', async () => {
    const { base } = await startServer({ seedSubscription: false });
    const cookie = await login(base);

    let list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks[0].subscribed, false);

    const res = await fetch(`${base}/api/subscriptions`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskName: 'demo-task' }),
    });
    assert.equal(res.status, 200);

    list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks[0].subscribed, true);
  });

  it('启用不存在的模板返回 404，不会凭空造出订阅', async () => {
    const { base, store } = await startServer({ seedSubscription: false });
    const cookie = await login(base);

    const res = await fetch(`${base}/api/subscriptions`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskName: 'no-such-template' }),
    });
    assert.equal(res.status, 404);
    assert.equal(store.forUser(USER_ID).listSubscriptions().length, 0);
  });

  it('internal 模板对普通用户不可见，也启用不了', async () => {
    const { base } = await startServer({ seedRole: 'user', extraTasks: [INTERNAL_TASK] });
    const cookie = await login(base);

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks.some((t) => t.name === 'internal-task'), false, '列表里不该出现');

    const res = await fetch(`${base}/api/subscriptions`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskName: 'internal-task' }),
    });
    // 404 而不是 403：403 会证实「这个名字存在」，等于泄露 internal 清单
    assert.equal(res.status, 404);
    assert.equal((await fetch(`${base}/tasks/internal-task`, { headers: { cookie } })).status, 404);
  });

  it('admin 能看到并启用 internal 模板', async () => {
    const { base } = await startServer({ extraTasks: [INTERNAL_TASK] });
    const cookie = await login(base);

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks.some((t) => t.name === 'internal-task'), true);

    const res = await fetch(`${base}/api/subscriptions`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskName: 'internal-task' }),
    });
    assert.equal(res.status, 200);
  });

  it('任务页给出启用按钮', async () => {
    const { base } = await startServer({ seedSubscription: false });
    const cookie = await login(base);
    const html = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.match(html, /data-action="subscribe"/);
    assert.match(html, /可以启用的模板/);
  });
});

describe('凭据接口（每人一份）', () => {
  const post = (base, cookie, body) =>
    fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('普通用户也能写自己的凭据', async () => {
    const { base } = await startServer({ seedRole: 'user' });
    const cookie = await login(base);

    const res = await post(base, cookie, {
      taskName: 'demo-task',
      accountKey: '',
      fields: { DEMO_TOKEN: 'abc' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, keys: ['DEMO_TOKEN'] });
  });

  it('只能写模板声明过的字段（白名单）', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await post(base, cookie, {
      taskName: 'demo-task',
      fields: { WHATEVER: 'x' },
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /不属于这个模板/);
  });

  it('字段值必须是字符串（对象/数组说明客户端写错了）', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await post(base, cookie, {
      taskName: 'demo-task',
      fields: { DEMO_TOKEN: { nested: 1 } },
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /必须是字符串/);
  });

  it('没有的模板 / 没有启用的模板都写不进去', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    assert.equal((await post(base, cookie, { taskName: 'nope', fields: {} })).status, 404);
  });

  it('不能拿别人的账号标识覆盖别人的凭据', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await post(base, cookie, {
      taskName: 'demo-task',
      accountKey: 'someone-elses',
      fields: { DEMO_TOKEN: 'x' },
    });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /没有这个账号/);
  });

  it('凭据值不出现在页面里', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    await post(base, cookie, { taskName: 'demo-task', fields: { DEMO_TOKEN: 'top-secret' } });

    const html = await (await fetch(`${base}/credentials`, { headers: { cookie } })).text();
    assert.match(html, /DEMO_TOKEN/);
    assert.equal(html.includes('top-secret'), false);
    assert.match(html, /已设置/);
  });
});

describe('外观（主题）', () => {
  it('设置页提供「跟随系统 / 浅色 / 深色」三选项', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const html = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    assert.match(html, /data-theme-picker/);
    for (const v of ['system', 'light', 'dark']) {
      assert.match(html, new RegExp(`data-theme-value="${v}"`), `缺少选项 ${v}`);
    }
  });

  it('主题脚本内联在 <head> 里（避免先按系统画一遍再翻转的闪屏）', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    const head = /<head>([\s\S]*?)<\/head>/.exec(page)?.[1] ?? '';
    assert.match(head, /weauto-theme/, '主布局的 head 里缺少主题脚本');

    // 登录页同样需要：选过的主题在未登录页也要生效
    const loginHtml = await (await fetch(`${base}/login`)).text();
    assert.match(loginHtml, /weauto-theme/, '登录页缺少主题脚本');
  });
});

describe('CSRF', () => {
  it('跨站来源的写操作被拒绝', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const res = await fetch(`${base}/api/tasks/demo-task/run`, {
      method: 'POST',
      headers: { cookie, Origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 403);
  });

  it('没有 Origin 的客户端（curl）不受影响', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const res = await fetch(`${base}/api/tasks/demo-task/run`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
  });
});
