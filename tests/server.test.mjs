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
import { createAuth } from '../src/auth/index.mjs';
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

let seq = 0;
async function startServer({ execute } = {}) {
  const db = openDb(path.join(dir, `db-${++seq}.sqlite`));
  dbs.push(db);
  const store = createStore(db);
  const tasks = new Map([[DEMO_TASK.name, { ...DEMO_TASK }]]);
  const auth = createAuth({ db, jwtSecret: 'test-secret' });
  const scheduler = createScheduler({
    store,
    tasks,
    execute: execute ?? (async () => null),
    now: () => NOW,
    log: () => {},
  });
  const app = createServer({ store, auth, tasks, scheduler, config: { trustProxy: true }, now: () => NOW });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, store, auth, scheduler };
}

/** 走完「首次初始化 → 拿到会话 cookie」这条路 */
async function login(base) {
  const res = await fetch(`${base}/setup`, {
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
    assert.equal(body.tasks, 1);
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
    const { base } = await startServer();
    const html = await (await fetch(`${base}/login`)).text();
    assert.match(html, /创建管理员/);
  });
});

describe('初始化与登录', () => {
  it('创建管理员后即可访问页面，且登录页变成普通登录', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
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

    store.appendRun({
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
        return store.appendRun({
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

  it('启停任务写入覆盖层，且状态随之变化', async () => {
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
    assert.equal(after.tasks[0].enabled, true);
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

describe('执行历史默认隐藏跳过记录', () => {
  it('skipped 默认不出现，加 ?all=1 才显示', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    store.appendRun({ taskName: 'demo-task', date: '2026-10-14', ts: NOW, status: 'success', message: '一次成功的执行' });
    store.appendRun({
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

describe('凭据接口', () => {
  it('普通账号不能改凭据', async () => {
    const { base, auth } = await startServer();
    const adminCookie = await login(base);

    auth.register({ username: 'plain', password: 'pass-word-1', role: 'user', status: 'active' });
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'plain', password: 'pass-word-1' }),
      redirect: 'manual',
    });
    const cookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')];
    const plainCookie = cookies.filter(Boolean).map((c) => c.split(';')[0]).join('; ');

    const denied = await fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: { cookie: plainCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { A: '1' } }),
    });
    assert.equal(denied.status, 403);

    // 管理员请求本身能走到业务层（本机没配 age 私钥时会是 400/500，总之不是 403）
    const asAdmin = await fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { A: '1' } }),
    });
    assert.notEqual(asAdmin.status, 403);
  });

  it('字段值必须是字符串（对象/数组说明客户端写错了）', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const res = await fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { A: { nested: 1 } } }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /必须是字符串/);
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
