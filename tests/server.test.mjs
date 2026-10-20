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

/** 带「凭据怎么拿」引导的模板：页面要渲染出下载链接与复制按钮 */
const HELPER_TASK = {
  ...DEMO_TASK,
  name: 'helper-task',
  displayName: '带取号指引的任务',
  credentialHelper: {
    download: 'grab-workbuddy-token.mjs',
    command: 'node grab-workbuddy-token.mjs',
    steps: ['跑完会自动复制到剪贴板'],
    note: '需要 Node 18+',
  },
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
    if (seedSubscription) store.forUser(USER_ID).createTask(DEMO_TASK.name, { label: '演示任务', accountKey: '' });
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

/** 用 admin 身份生成一个邀请码（多个 describe 都要用，所以放模块级） */
async function makeInvite(base, cookie, opts = {}) {
  const res = await fetch(`${base}/api/invites`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '测试用', ...opts }),
  });
  assert.equal(res.status, 200);
  return await res.json();
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

  it('模板声明的抓取脚本可匿名下载（朋友用 curl -O，不该先要登录）', async () => {
    const { base } = await startServer({ extraTasks: [HELPER_TASK] });
    const res = await fetch(`${base}/api/tools/grab-workbuddy-token.mjs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    // attachment：否则浏览器可能把 .mjs 当源码内联渲染
    assert.match(res.headers.get('content-disposition'), /attachment/);

    const body = await res.text();
    // 只断言「确实是那个脚本」，不断言实现细节——否则脚本一改测试就碎
    assert.match(body, /remote-debugging-port/);
    assert.ok(body.length > 1000, '脚本内容不像完整文件，检查下载端点是否读错路径');
  });

  it('没被模板声明的脚本一律 404（白名单，不是静态目录）', async () => {
    // 这里的模板没有 credentialHelper，所以 scripts/ 下什么都不可下载
    const { base } = await startServer();
    for (const f of ['grab-workbuddy-token.mjs', 'probe-workbuddy.mjs']) {
      const res = await fetch(`${base}/api/tools/${encodeURIComponent(f)}`);
      assert.equal(res.status, 404, `${f} 不该可下载`);
    }
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

describe('凭据获取引导（模板声明才出现）', () => {
  it('任务页渲染下载链接、命令与复制按钮', async () => {
    const { base, store } = await startServer({ extraTasks: [HELPER_TASK] });
    const cookie = await login(base);
    const row = store.forUser(USER_ID).createTask('helper-task', { label: '带引导' });

    const html = await (
      await fetch(`${base}/tasks/${row.id}`, { headers: { Cookie: cookie } })
    ).text();

    // 标题用第一个 requires 字段拼出来，证明它读的是声明而不是写死的任务名
    assert.match(html, /怎么拿到 DEMO_TOKEN/);
    // 下载的是「个性化」脚本（带配对信息），不是那个通用文件
    assert.match(html, new RegExp(`/api/tasks/${row.id}/grabber\\.mjs`));
    assert.match(html, /data-watch-pair=/);
    assert.match(html, /需要 Node 18\+/);
  });

  it('没声明 credentialHelper 的模板不渲染这块', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    const [row] = store.forUser(USER_ID).tasksOfTemplate('demo-task');

    const html = await (
      await fetch(`${base}/tasks/${row.id}`, { headers: { Cookie: cookie } })
    ).text();

    assert.match(html, /WB_ACCESS_TOKEN|DEMO_TOKEN|任务名/); // 页面本身是正常的
    assert.doesNotMatch(html, /cred-helper/);
  });
});

describe('凭据一键更新（脚本直接推送）', () => {
  // 形状合法即可：这里不验签名，只验「不是半截串」
  const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE4OTM0NTYwMDB9.c2lnbmF0dXJlLXNpZ24';

  async function setup() {
    const ctx = await startServer({ extraTasks: [HELPER_TASK] });
    const cookie = await login(ctx.base);
    const row = ctx.store.forUser(USER_ID).createTask('helper-task', { label: '带引导' });
    const pairCode = async () =>
      (
        await fetch(`${ctx.base}/api/tasks/${row.id}/pair-code`, {
          method: 'POST',
          headers: { Cookie: cookie },
        })
      ).json();
    const push = (body) =>
      fetch(`${ctx.base}/api/tools/push-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const taskJson = async () =>
      (await fetch(`${ctx.base}/api/tasks/${row.id}`, { headers: { Cookie: cookie } })).json();
    const pairStatus = async () =>
      (await fetch(`${ctx.base}/api/tasks/${row.id}/pair-status`, { headers: { Cookie: cookie } })).json();
    return { ...ctx, cookie, row, pairCode, push, taskJson, pairStatus };
  }

  it('未登录不能申请配对码', async () => {
    const { base, row } = await setup();
    const res = await fetch(`${base}/api/tasks/${row.id}/pair-code`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('模板没声明 credentialHelper 时拒绝发码', async () => {
    const { base, store } = await startServer(); // DEMO_TASK 没有 credentialHelper
    const cookie = await login(base);
    const [row] = store.forUser(USER_ID).tasksOfTemplate('demo-task');
    const res = await fetch(`${base}/api/tasks/${row.id}/pair-code`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 400);
  });

  it('发码返回一条可直接粘贴运行的命令', async () => {
    const { pairCode } = await setup();
    const out = await pairCode();
    assert.match(out.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    // 命令里必须带服务器地址与码，用户复制就能跑
    assert.match(out.command, /--push http:\/\/127\.0\.0\.1:\d+/);
    assert.ok(out.command.includes(`--code ${out.code}`));
    assert.ok(out.issuedAt > 0 && out.expiresAt > out.issuedAt);
  });

  it('带码推送后：凭据就位 + 可查到已推送 + 回发长期令牌', async () => {
    const { push, pairCode, taskJson, pairStatus, row } = await setup();
    const { code } = await pairCode();

    const res = await push({ code, token: JWT });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.taskId, row.id);
    assert.ok(body.pushToken, '首次配对应回发长期令牌，否则每月还要回页面点一次');
    assert.equal(body.expiresAt, 1893456000 * 1000);

    const detail = await taskJson();
    assert.deepEqual(detail.task.missingCredentials, []);

    const st = await pairStatus();
    assert.ok(st.pushedAt > 0);
  });

  it('配对码只能用一次', async () => {
    const { push, pairCode } = await setup();
    const { code } = await pairCode();
    assert.equal((await push({ code, token: JWT })).status, 200);
    assert.equal((await push({ code, token: JWT })).status, 400);
  });

  it('之后用 pushToken 推送，不需要配对码，也不再回发新令牌', async () => {
    const { push, pairCode, taskJson } = await setup();
    const { code } = await pairCode();
    const first = await (await push({ code, token: JWT })).json();

    const res = await push({ pushToken: first.pushToken, token: JWT });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pushToken, null, '已配对的令牌不该被反复重发');

    assert.deepEqual((await taskJson()).task.missingCredentials, []);
  });

  it('伪造的 pushToken 被拒绝', async () => {
    const { push, pairCode } = await setup();
    const { code } = await pairCode();
    const first = await (await push({ code, token: JWT })).json();
    // 同一个 taskId，但随机串换掉
    const forged = first.pushToken.replace(/_[^_]+$/, '_AAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal((await push({ pushToken: forged, token: JWT })).status, 401);
  });

  it('不像 JWT 的值直接拒绝，不写库', async () => {
    const { push, pairCode } = await setup();
    const { code } = await pairCode();
    const res = await push({ code, token: 'session=abc' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /JWT/);
  });

  it('个性化脚本：配对信息已注入，拿它就能推送（不用再生成命令）', async () => {
    const { base, cookie, row, push } = await setup();
    const res = await fetch(`${base}/api/tasks/${row.id}/grabber.mjs`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    // no-store：这份文件里带着令牌，不能被缓存后发给别人
    assert.match(res.headers.get('cache-control'), /no-store/);

    const src = await res.text();
    const m = /const EMBEDDED_PAIRING = (\{.*?\});/s.exec(src);
    assert.ok(m, '脚本里应该有注入的配对信息');

    const embedded = JSON.parse(m[1]);
    assert.equal(embedded.taskId, row.id);
    assert.ok(embedded.pushToken.startsWith('wt1_'));
    assert.match(embedded.server, /^http:\/\/127\.0\.0\.1:\d+$/);

    // 真正的验收：用文件里那个令牌直接推送，链路必须通
    const pushed = await push({ pushToken: embedded.pushToken, token: JWT });
    assert.equal(pushed.status, 200);
  });

  it('个性化脚本需要登录才能下载', async () => {
    const { base, row } = await setup();
    assert.equal((await fetch(`${base}/api/tasks/${row.id}/grabber.mjs`)).status, 401);
  });

  it('重复下载复用同一个 pushToken（之前下载的文件不会突然失效）', async () => {
    const { base, cookie, row } = await setup();
    const fetchSrc = async () =>
      (
        await fetch(`${base}/api/tasks/${row.id}/grabber.mjs`, { headers: { Cookie: cookie } })
      ).text();
    const first = /"pushToken":"([^"]+)"/.exec(await fetchSrc())[1];
    const second = /"pushToken":"([^"]+)"/.exec(await fetchSrc())[1];
    assert.equal(first, second);
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

    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
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

    const first = await fetch(`${base}/api/tasks/1/run`, { method: 'POST', headers: { cookie } });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { started: true });

    const second = await fetch(`${base}/api/tasks/1/run`, { method: 'POST', headers: { cookie } });
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

  it('停用任务写入任务本身，删掉之后任务就不在了', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200);

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks[0].enabled, false);
    assert.equal(list.tasks[0].todayStatus, 'disabled');

    const cleared = await fetch(`${base}/api/tasks/1`, { method: 'DELETE', headers: { cookie } });
    assert.deepEqual(await cleared.json(), { ok: true, deleted: true });
    const after = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    // 删掉就是没了，不是「回到模板默认」再显示一行已停止
    assert.equal(after.tasks.length, 0);
  });

  it('配置页只给出凭据字段名与是否已设置，绝不返回值', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.match(html, /DEMO_TOKEN/);
    assert.match(html, /未设置/);
  });
});

describe('调度配置（用户配自己的时间必须生效）', () => {
  it('网页改的调度能存进任务，调度器读到的就是它', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 10 } } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.task.schedule.kind, 'every');
    assert.equal(body.task.schedule.every.minutes, 10);

    // 模板本身是 window，但任务里是 every —— 调度器必须认任务里的
    assert.equal(store.forUser(USER_ID).getTask(1).schedule.every.minutes, 10);
  });

  it('「当前」一行同时给出生效的调度和它的来源，不再重复成两行', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    // 没改过：生效的就是模板默认，来源标「模板默认」
    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.doesNotMatch(html, /<dt>来源<\/dt>/);
    assert.match(html, /<dt>当前<\/dt><dd>每天 09:00–09:50 内随机<span class="note"> · 模板默认<\/span>/);

    // 改过之后：来源换成「我在下面改过」，值也跟着变
    await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 10 } } }),
    });
    const after = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.match(after, /每 10 分钟<span class="note"> · 我在下面改过<\/span>/);
  });

  it('一次性任务的时刻默认给「今天 + 下一个整点」，不再留空的年月日占位', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    // 日期走三个快捷按钮；「今天」的日期由服务端给，避免浏览器时区算错一天
    assert.match(html, /data-once-day="today"/);
    assert.match(html, /data-once-day="tomorrow"/);
    assert.match(html, /data-once-day="pick"/);
    assert.match(html, /data-today="\d{4}-\d{2}-\d{2}"/);
    assert.match(html, /data-tomorrow="\d{4}-\d{2}-\d{2}"/);
    // 提交用的 at 不是空的，时间与日期分开填
    assert.match(html, /name="atTime" value="\d{2}:\d{2}"/);
    assert.match(html, /name="at" value="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
    assert.doesNotMatch(html, /datetime-local/);
  });

  it('保存过的一次性时刻回显成日期 + 时间，更远的日期停在「选日期…」', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { once: { at: '2026-10-20 08:30' } } }),
    });
    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.match(html, /name="atDate" value="2026-10-20"/);
    assert.match(html, /name="atTime" value="08:30"/);
    assert.match(html, /data-once-day="pick"[^>]*|class="seg-btn on" data-once-day="pick"/);
  });

  it('非法调度返回 400，而不是被静默忽略', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks/1`, {
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

    const res = await fetch(`${base}/api/tasks/1`, {
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

    await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 10 } } }),
    });
    const back = await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: null }),
    });
    assert.equal(back.status, 200);
    assert.equal(store.forUser(USER_ID).getTask(1).schedule, null);
  });

  it('普通用户（非 admin）也能改自己的订阅', async () => {
    const { base } = await startServer({ seedRole: 'user' });
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 15 } } }),
    });
    assert.equal(res.status, 200, '改自己的任务不该要求 admin');
    assert.equal((await res.json()).task.schedule.every.minutes, 15);
  });

  it('改自己的任务不会动到别人的', async () => {
    const { base, store, auth } = await startServer({ seedRole: 'user' });
    auth.register({ username: 'other', password: 'pass-word-2', role: 'user' });
    const others = store.forUser(2).createTask('demo-task');

    const cookie = await login(base);
    await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 15 } } }),
    });

    assert.equal(store.forUser(USER_ID).getTask(1).schedule.every.minutes, 15);
    assert.equal(store.forUser(2).getTask(others.id).schedule, null, '别人的任务没被碰到');
  });

  it('配置页给出可编辑的调度表单', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();

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

    const def = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.equal(def.includes('一条被跳过的记录'), false);
    assert.match(def, /显示另外 1 条已跳过/);

    const all = await (await fetch(`${base}/tasks/1?all=1`, { headers: { cookie } })).text();
    assert.match(all, /一条被跳过的记录/);

    // 接口口径一致
    const api = await (await fetch(`${base}/api/tasks/1`, { headers: { cookie } })).json();
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

describe('凭据就近配置', () => {
  it('任务配置页把任务名与凭据放在同一个表单里，只有一个保存按钮', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    // 一个表单：名字 + 账号密码，提交按钮只有一个
    assert.match(html, /data-action="save-task"/);
    assert.match(html, /data-original-label=/);
    assert.match(html, /name="label"/);
    assert.match(html, /name="DEMO_TOKEN"/);
    assert.equal((html.match(/data-action="save-creds/g) || []).length, 0);
    assert.equal((html.match(/data-action="rename-task"/g) || []).length, 0);
  });

  it('没建过任务时任务页没有任务，只有模板', async () => {
    const { base } = await startServer({ seedSubscription: false });
    const cookie = await login(base);

    const html = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.match(html, /template-rail/);
    // 卡片是「看模板」的链接，不是「一键建任务」的按钮
    assert.match(html, /href="\/templates\/demo-task"/);
    assert.equal(html.includes('data-action="create-task"'), false);
    assert.match(html, /还没有创建任务/);
    // 没建任务就没有任务页可进
    assert.equal((await fetch(`${base}/tasks/1`, { headers: { cookie } })).status, 404);
  });

  it('填过之后配置页显示「已设置」', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    await fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 1, fields: { DEMO_TOKEN: 'x' } }),
    });
    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.match(html, /已设置，留空表示不修改/);
  });
});

describe('凭据页已取消', () => {
  it('/credentials 重定向到任务页，旧链接不失效', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/credentials`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/tasks');
  });

  it('导航里不再有凭据入口', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const html = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.equal(html.includes('href="/credentials"'), false);
  });

  it('没填凭据的实例在列表里标出来', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);

    const before = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.match(before, /待填凭据/);

    await fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 1, fields: { DEMO_TOKEN: 'x' } }),
    });
    const after = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.equal(after.includes('待填凭据'), false, '填过之后标记应消失');
  });
});

describe('配置错误的提示', () => {
  it('任务报 config-error 时，详情页直接说可能是凭据问题', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    store.forUser(USER_ID).appendRun({
      taskName: 'demo-task',
      date: '2026-10-14',
      ts: NOW,
      status: 'config-error',
      message: '缺少凭据字段：DEMO_TOKEN（账号「默认」）',
    });

    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.match(html, /去填写或更新凭据/);
  });
});

describe('不存在的任务', () => {
  it('返回 404，而不是静默回退到我的第一个任务', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    assert.equal((await fetch(`${base}/api/tasks/999`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/tasks/999`, { headers: { cookie } })).status, 404);
    // 自己的那个正常
    assert.equal((await fetch(`${base}/api/tasks/1`, { headers: { cookie } })).status, 200);
  });
});

describe('一个任务只跑一个账号', () => {
  it('同一个模板建两个任务 → 列表里两行，各自一个账号', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const made = await (
      await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: 'demo-task', label: '小号' }),
      })
    ).json();
    assert.equal(made.ok, true);

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks.length, 2, '一个任务一行');
    const keys = list.tasks.map((t) => t.accountKey);
    assert.equal(new Set(keys).size, 2, '两个任务的账号不同');
    assert.equal(list.tasks.find((t) => t.id === made.id).label, '小号');
  });

  it('两个任务的状态各自独立：一个成功不影响另一个', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    const second = store.forUser(USER_ID).createTask('demo-task', { label: '小号' });
    store.forUser(USER_ID).appendRun({
      taskName: 'demo-task',
      accountKey: store.forUser(USER_ID).getTask(1).accountKey,
      date: '2026-10-14',
      ts: NOW,
      status: 'success',
    });

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    const main = list.tasks.find((t) => t.id === 1);
    const other = list.tasks.find((t) => t.id === second.id);
    assert.equal(main.todayStatus, 'success');
    assert.notEqual(other.todayStatus, 'success', '另一个任务不该被当成已完成');
  });

  it('详情页只给这个任务自己的历史', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    const mine = store.forUser(USER_ID);
    const second = mine.createTask('demo-task', { label: '小号' });
    mine.appendRun({
      taskName: 'demo-task',
      accountKey: mine.getTask(1).accountKey,
      date: '2026-10-14',
      ts: NOW,
      status: 'success',
      message: '第一个任务',
    });
    mine.appendRun({
      taskName: 'demo-task',
      accountKey: second.accountKey,
      date: '2026-10-14',
      ts: NOW + 1,
      status: 'failed',
      message: '第二个任务',
    });

    const main = await (await fetch(`${base}/api/tasks/1`, { headers: { cookie } })).json();
    assert.equal(main.runs.length, 1);
    assert.equal(main.runs[0].message, '第一个任务');

    const other = await (await fetch(`${base}/api/tasks/${second.id}`, { headers: { cookie } })).json();
    assert.equal(other.runs.length, 1);
    assert.equal(other.runs[0].message, '第二个任务');
  });

  it('停用任务只影响它自己', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    const second = store.forUser(USER_ID).createTask('demo-task', { label: '小号' });

    const res = await fetch(`${base}/api/tasks/${second.id}`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200);

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks.find((t) => t.id === second.id).enabled, false);
    assert.equal(list.tasks.find((t) => t.id === 1).enabled, true);
  });

  it('删除任务：任务没了，历史还在', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);
    const mine = store.forUser(USER_ID);
    const second = mine.createTask('demo-task', { label: '小号' });
    const before = mine.runsOfTask('demo-task', { limit: 50 }).length;

    const res = await fetch(`${base}/api/tasks/${second.id}`, {
      method: 'DELETE',
      headers: { cookie, 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 200);

    const list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks.length, 1, '只剩一个任务');
    assert.equal(
      mine.runsOfTask('demo-task', { limit: 50 }).length,
      before,
      '执行历史是发生过的事实，不跟着删',
    );
  });
});

describe('账号删除', () => {
  it('删号会连带清掉他的一切（订阅、凭据、历史）', async () => {
    const { base, db, store, auth, invites } = await startServer();
    const cookie = await login(base);
    auth.register({ username: 'goner', password: 'pass-word-1', role: 'user' });
    const victim = auth.listUsers().find((u) => u.username === 'goner');
    store.forUser(victim.id).createTask('demo-task');
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

  it('删掉用邀请码注册进来的用户不会失败', async () => {
    const { base, auth, invites } = await startServer();
    const cookie = await login(base);
    const { invite } = await makeInvite(base, cookie);

    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: invite.code, username: 'todelete', password: 'pass-word-1' }),
      redirect: 'manual',
    });
    const victim = auth.listUsers().find((u) => u.username === 'todelete');
    assert.ok(victim, '应该注册成功');

    // invites.used_by 指向他，外键没有 ON DELETE —— 不先处理就会删不掉
    const res = await fetch(`${base}/api/users/${victim.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(auth.listUsers().some((u) => u.username === 'todelete'), false);
  });

  it('删掉发过邀请码的管理员不会失败', async () => {
    const { base, auth, invites } = await startServer();
    const cookie = await login(base);
    // 用户名只允许字母数字下划线中文，不能有连字符
    auth.register({ username: 'otheradmin', password: 'pass-word-1', role: 'admin' });
    const other = auth.listUsers().find((u) => u.username === 'otheradmin');
    // 用他的身份发一个码
    invites.create({ createdBy: other.id, note: '他发的' });

    const res = await fetch(`${base}/api/users/${other.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(invites.list(10).some((i) => i.note === '他发的'), false, '他发的码应一起清掉');
  });

  it('不能删除自己', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);
    const me = auth.listUsers().find((u) => u.username === 'tester');

    const res = await fetch(`${base}/api/users/${me.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /不能删除自己/);
  });

  it('不能停用自己', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);
    const me = auth.listUsers().find((u) => u.username === 'tester');

    const res = await fetch(`${base}/api/users/${me.id}`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /不能停用当前登录的账号/);
  });

  it('不能改自己的角色', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);
    const me = auth.listUsers().find((u) => u.username === 'tester');

    const res = await fetch(`${base}/api/users/${me.id}`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /不能修改自己的角色/);
  });

  it('普通用户删不了别人', async () => {
    const { base, auth } = await startServer({ seedRole: 'user' });
    const cookie = await login(base);
    const other = auth.listUsers().find((u) => u.id !== USER_ID) ?? { id: 999 };

    assert.equal((await fetch(`${base}/api/users/${other.id}`, { method: 'DELETE', headers: { cookie } })).status, 403);
  });
});

describe('管理页（仅 admin）', () => {
  it('admin 能看到管理首页，里面有账号管理入口', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/admin`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /启动中的任务/);
    assert.match(html, /href="\/admin\/users"/);
  });

  it('账号管理只在管理页，账号弹层里不再有管理入口', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);
    // 自己的账号行没有操作按钮，得先有第二个账号才看得到删除
    auth.register({ username: 'zhangsan', password: 'pass-word-1' });

    const html = await (await fetch(`${base}/admin/users`, { headers: { cookie } })).text();
    assert.match(html, /data-action="delete-user"/);

    // 设置不再是独立页，而是骨架里的弹层：取首页里的弹层片段来断言
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    const panel = /<aside class="user-panel"[\s\S]*?<\/aside>/.exec(home)?.[0] ?? '';
    assert.ok(panel, '首页没有渲染账号弹层');
    assert.equal(panel.includes('data-action="delete-user"'), false, '账号弹层不该有账号管理');
    assert.equal(
      panel.includes('href="/admin/users"'),
      false,
      '账号弹层不该再重复一个账号管理入口：管理员导航里已有「管理」页',
    );
  });

  it('管理页不新建账号：页面没有表单，接口也不留', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);

    const html = await (await fetch(`${base}/admin/users`, { headers: { cookie } })).text();
    assert.equal(
      html.includes('data-action="create-user"'),
      false,
      '账号管理页不该再有新建账号表单：账号一律走邀请注册',
    );

    const res = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'madebyadmin', password: 'pass-word-1', role: 'user' }),
    });
    assert.equal(res.status, 404, 'POST /api/users 应已移除');
    assert.equal(
      auth.listUsers().some((u) => u.username === 'madebyadmin'),
      false,
    );
  });

  it('自己的账号行不给停用与删除按钮', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);
    auth.register({ username: 'zhangsan', password: 'pass-word-1' });
    const other = auth.listUsers().find((u) => u.username === 'zhangsan');

    const html = await (await fetch(`${base}/admin/users`, { headers: { cookie } })).text();
    assert.equal(
      html.includes(`data-action="toggle-user" data-user="${USER_ID}"`),
      false,
      '自己那行不该有停用按钮',
    );
    assert.equal(
      html.includes(`data-action="delete-user" data-user="${USER_ID}"`),
      false,
      '自己那行不该有删除按钮',
    );
    assert.match(html, new RegExp(`data-action="toggle-user" data-user="${other.id}"`));
  });

  it('普通用户访问返回 403，导航里也没有入口', async () => {
    const { base } = await startServer({ seedRole: 'user' });
    const cookie = await login(base);

    assert.equal((await fetch(`${base}/admin`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/admin/users`, { headers: { cookie } })).status, 403);
    const html = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.equal(html.includes('href="/admin"'), false, '导航里不该出现管理入口');
  });
});

describe('概览统计', () => {
  it('没建过的模板不计入统计，也不出现在「需要注意」里', async () => {
    const { base } = await startServer({ seedSubscription: false });
    const cookie = await login(base);
    const data = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();

    assert.equal(data.items.length, 0, '没建过的模板不占「我的任务」的行');
    assert.equal(data.byStatus.disabled, 0, '没建不该被算成「停用」');
    assert.equal(data.attention.length, 0, '没建不该出现在需要注意里');
  });

  it('「需要处理」只收今天没跑成的任务，停止不算', async () => {
    const { base, store } = await startServer();
    const cookie = await login(base);

    // 真出事的（失败）必须进来
    const mine = store.forUser(USER_ID);
    const today = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();
    mine.appendRun({
      taskName: 'demo-task',
      date: today.today,
      ts: Date.now(),
      status: 'failed',
      message: '示例失败',
      trigger: 'schedule',
    });
    const failed = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();
    assert.equal(failed.attention.length, 1);
    assert.equal(failed.attention[0].todayStatus, 'failed');

    // 停掉这个任务：它是我主动按的，不该再占「需要处理」——
    // 但它仍然要出现在顶部统计的「停止/手动」里
    await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const stopped = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();
    assert.equal(stopped.byStatus.disabled, 1, '顶部统计里仍然看得到「我停着 1 个」');
    assert.equal(stopped.attention.length, 0, '「已停止」不该进需要处理');

    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    assert.match(html, /今天没有失败或错过的任务/);
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

  it('账号管理页给管理员显示邀请码管理', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    await makeInvite(base, cookie, { note: '给小明' });

    const html = await (await fetch(`${base}/admin/users`, { headers: { cookie } })).text();
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

describe('模板与任务（只能从平台提供的模板建任务）', () => {
  const INTERNAL_TASK = {
    ...DEMO_TASK,
    name: 'internal-task',
    displayName: '内部模板',
    visibility: 'internal',
  };

  it('点模板建任务，建完就有了我的任务', async () => {
    const { base } = await startServer({ seedSubscription: false });
    const cookie = await login(base);

    let list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks.length, 0, '没建之前没有任务');

    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'demo-task' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.id, 'number');

    list = await (await fetch(`${base}/api/tasks`, { headers: { cookie } })).json();
    assert.equal(list.tasks.length, 1);
    assert.equal(list.tasks[0].id, body.id);
  });

  it('用不存在的模板建任务返回 404，不会凭空造出任务', async () => {
    const { base, store } = await startServer({ seedSubscription: false });
    const cookie = await login(base);

    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'no-such-template' }),
    });
    assert.equal(res.status, 404);
    assert.equal(store.forUser(USER_ID).listTasks().length, 0);
  });

  it('internal 模板对普通用户不可见，也建不了', async () => {
    const { base } = await startServer({ seedRole: 'user', extraTasks: [INTERNAL_TASK] });
    const cookie = await login(base);

    const html = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.equal(html.includes('内部模板'), false, '模板轨道里不该出现');

    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'internal-task' }),
    });
    // 404 而不是 403：403 会证实「这个名字存在」，等于泄露 internal 清单
    assert.equal(res.status, 404);
  });

  it('admin 能看到并用 internal 模板建任务', async () => {
    const { base } = await startServer({ extraTasks: [INTERNAL_TASK] });
    const cookie = await login(base);

    const html = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.match(html, /内部模板/);

    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'internal-task' }),
    });
    assert.equal(res.status, 200);
  });

  it('任务页顶部是模板轨道，不是「可以启用的模板」列表', async () => {
    const { base } = await startServer({ seedSubscription: false });
    const cookie = await login(base);
    const html = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.match(html, /href="\/templates\/demo-task"/);
    assert.equal(html.includes('可以启用的模板'), false);
  });
});

describe('模板页：先看后建', () => {
  it('模板页说明这个模板是什么，创建按钮在里面', async () => {
    const { base } = await startServer({ seedSubscription: false });
    const cookie = await login(base);

    const html = await (await fetch(`${base}/templates/demo-task`, { headers: { cookie } })).text();
    assert.match(html, /演示任务/);
    assert.match(html, /用于测试/);
    // 默认调度、要填哪些字段、创建按钮
    assert.match(html, /每天 09:00–09:50 内随机/);
    assert.match(html, /DEMO_TOKEN/);
    assert.match(html, /data-action="create-task" data-template="demo-task"/);
    assert.match(html, /还没建过/);

    // 光看不建：任务列表里不应该多出任务
    const list = await (await fetch(`${base}/tasks`, { headers: { cookie } })).text();
    assert.match(list, /还没有创建任务/);
  });

  it('点「创建任务」才真的建，之后模板页列出我用它建的任务', async () => {
    const { base } = await startServer({ seedSubscription: false });
    const cookie = await login(base);

    const created = await (
      await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: 'demo-task' }),
      })
    ).json();
    assert.equal(created.ok, true);

    const html = await (await fetch(`${base}/templates/demo-task`, { headers: { cookie } })).text();
    assert.match(html, /我用这个模板建的任务/);
    assert.match(html, /href="\/tasks\/1"/);
  });

  it('不存在或 internal 的模板页返回 404，而不是 403', async () => {
    const { base, auth } = await startServer();
    const cookie = await login(base);

    assert.equal((await fetch(`${base}/templates/nope`, { headers: { cookie } })).status, 404);

    // internal 模板对 admin 可见；换成普通用户后必须视同不存在
    const me = auth.listUsers().find((u) => u.username === 'tester');
    auth.setRole(me.id, 'user');
    assert.equal((await fetch(`${base}/templates/internal-task`, { headers: { cookie } })).status, 404);
  });
});

describe('交互细节', () => {
  it('404 页给出路，而不是只剩一句「没有这个」', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const tpl = await (await fetch(`${base}/templates/nope`, { headers: { cookie } })).text();
    assert.match(tpl, /返回任务列表/);

    const task = await (await fetch(`${base}/tasks/9999`, { headers: { cookie } })).text();
    assert.match(task, /返回任务列表/);
  });

  it('「停止」在两页都是危险色；更重的「删除任务」反而弱化', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.match(html, /data-action="toggle"[^>]*class="btn-danger"/);
    assert.match(html, /class="link-danger" data-action="delete-task"/);
    // 按钮都显式声明 type，挪进表单也不会变成提交按钮
    assert.match(html, /type="button" data-action="toggle"/);
  });

  it('没改过调度时，单选里的模板默认值不重复说一遍', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    // 上面「当前」那行已经写明了值，单选项就只留名字
    assert.match(html, /跟随模板默认<\/label>/);
    assert.doesNotMatch(html, /跟随模板默认（/);

    // 改过之后才把模板默认值写出来——它是决定要不要恢复默认的依据
    await fetch(`${base}/api/tasks/1`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: { every: { minutes: 10 } } }),
    });
    const after = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.match(after, /跟随模板默认（每天 09:00–09:50 内随机）/);
  });

  it('一次性任务的日期组是按钮组，不是 <label>', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    // label 会把自己绑到第一个按钮，点「日期」就等于点了「今天」
    assert.match(html, /<div class="seg-row" role="group" aria-label="日期">/);
    assert.match(html, /aria-pressed="true" data-once-day="today"/);
    assert.equal(/<label[^>]*>\s*<span class="field-label">日期/.test(html), false);
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
      taskId: 1,
      fields: { DEMO_TOKEN: 'abc' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, keys: ['DEMO_TOKEN'] });
  });

  it('只能写模板声明过的字段（白名单）', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await post(base, cookie, {
      taskId: 1,
      fields: { WHATEVER: 'x' },
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /不属于这个模板/);
  });

  it('字段值必须是字符串（对象/数组说明客户端写错了）', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await post(base, cookie, {
      taskId: 1,
      fields: { DEMO_TOKEN: { nested: 1 } },
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /必须是字符串/);
  });

  it('没有的模板 / 没有启用的模板都写不进去', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    // 没有这个任务 = 404；模板名不再是写凭据的入口
    assert.equal((await post(base, cookie, { taskId: 999, fields: {} })).status, 404);
    assert.equal((await post(base, cookie, { taskName: 'demo-task', fields: {} })).status, 400);
  });

  it('拿不到别人的任务就写不进别人的凭据', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    // 别人的任务 id 在我的视图里根本取不到 —— 只能拿到 404，写不进去
    const res = await post(base, cookie, {
      taskId: 999,
      fields: { DEMO_TOKEN: 'x' },
    });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /没有这个任务/);
  });

  it('凭据值不出现在页面里', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    await post(base, cookie, { taskId: 1, fields: { DEMO_TOKEN: 'top-secret' } });

    const html = await (await fetch(`${base}/tasks/1`, { headers: { cookie } })).text();
    assert.match(html, /DEMO_TOKEN/);
    assert.equal(html.includes('top-secret'), false);
    assert.match(html, /已设置/);
  });
});

describe('外观（主题）', () => {
  it('账号弹层提供「跟随系统 / 浅色 / 深色」三选项', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    // 骨架的一部分：任何页面都该带着它，否则那一页就换不了主题
    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    assert.match(html, /data-theme-picker/);
    for (const v of ['system', 'light', 'dark']) {
      assert.match(html, new RegExp(`data-theme-value="${v}"`), `缺少选项 ${v}`);
    }
  });

  it('设置不再是一个页面：/settings 回到首页，导航里也没有它', async () => {
    const { base } = await startServer();
    const cookie = await login(base);

    const res = await fetch(`${base}/settings`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 302, '旧链接不该 404');
    assert.equal(res.headers.get('location'), '/');

    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    assert.equal(html.includes('href="/settings"'), false, '底部导航里不该再有设置');

    const panel = /<aside class="user-panel"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? '';
    assert.match(panel, /id="user-menu"/, '骨架里要有账号弹层');
  });

  it('弹层的系统信息只留「版本 / 运行时长 / 任务模板」', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    const panel = /<aside class="user-panel"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? '';

    // 留着的三项回答的是同一个问题：这次部署生效了吗
    for (const label of ['版本', '运行时长', '任务模板']) {
      assert.ok(panel.includes(label), `缺少 ${label}`);
    }
    // 数据目录/数据库只有 SSH 到机器上才用得上，在网页里还向普通用户透了路径
    assert.equal(panel.includes('数据目录'), false, '不该再暴露服务器路径');
    assert.equal(panel.includes('数据库'), false, '不该再暴露数据库文件名');
    // 「调度器：运行中」是写死的，scheduler 拿不到真启停状态，假状态不如不显示
    assert.equal(panel.includes('调度器'), false, '拿不到真值就不要显示');
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
    const res = await fetch(`${base}/api/tasks/1/run`, {
      method: 'POST',
      headers: { cookie, Origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 403);
  });

  it('没有 Origin 的客户端（curl）不受影响', async () => {
    const { base } = await startServer();
    const cookie = await login(base);
    const res = await fetch(`${base}/api/tasks/1/run`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
  });
});

/* ───────────────────────────────────────────────────────
   概览「最近执行」与任务详情「执行历史」必须是同一批记录。
   两处曾经各用一套口径（账号范围 / skipped 过滤时机），
   同一条记录在一个页面看得到、另一个页面看不到。
   ------------------------------------------------------ */
const MULTI_TASK = {
  ...DEMO_TASK,
  name: 'multi-task',
  displayName: '多账号任务',
  accounts: true,
  view: [],
};

describe('概览与任务详情的执行记录一致', () => {
  it('概览标出任务展示名与账号名，多账号下才分得清每条属于谁', async () => {
    const { base, store } = await startServer({ extraTasks: [MULTI_TASK] });
    const mine = store.forUser(USER_ID);
    const first = mine.createTask(MULTI_TASK.name, { label: '主号' });
    const second = mine.createTask(MULTI_TASK.name, { label: '小号' });
    const t0 = Date.parse('2026-10-14T09:00:00+08:00');
    let i = 0;
    for (const accountKey of [first.accountKey, second.accountKey, first.accountKey, second.accountKey]) {
      mine.appendRun({
        taskName: MULTI_TASK.name,
        accountKey,
        date: '2026-10-14',
        ts: t0 + i * 60_000,
        status: 'success',
        message: 'ok' + i,
        dur: 100,
      });
      i += 1;
    }
    const cookie = await login(base);

    // 概览是跨任务流水：两个任务各 2 条都在，且每条都标得出是哪个任务
    const overview = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();
    assert.equal(overview.recent.length, 4, '两个任务共 4 条');
    assert.notEqual(overview.recent[0].taskLabel, '多账号任务', '概览用任务名，不是模板名');
    const labels = overview.recent.map((r) => r.taskLabel).sort();
    assert.deepEqual(labels, ['主号', '主号', '小号', '小号'].sort());

    // 详情页是这个任务自己的视图：指定谁就只看谁
    const main = await (await fetch(`${base}/api/tasks/${first.id}`, { headers: { cookie } })).json();
    assert.equal(main.runs.length, 2);
    assert.ok(main.runs.every((r) => r.accountKey === first.accountKey));
    const only = await (
      await fetch(`${base}/api/tasks/${second.id}`, { headers: { cookie } })
    ).json();
    assert.equal(only.runs.length, 2);
    assert.ok(only.runs.every((r) => r.accountKey === second.accountKey));
  });

  it('最近几十条全是 skipped 时，两处仍然给出同样的有效记录', async () => {
    const { base, store } = await startServer();
    const mine = store.forUser(USER_ID);
    const t0 = Date.parse('2026-10-14T00:00:00+08:00');
    for (let i = 0; i < 25; i++) {
      mine.appendRun({
        taskName: DEMO_TASK.name,
        date: '2026-10-14',
        ts: t0 + i * 60_000,
        status: 'success',
        message: 'ok' + i,
        dur: 100,
      });
    }
    for (let i = 0; i < 60; i++) {
      mine.appendRun({
        taskName: DEMO_TASK.name,
        date: '2026-10-15',
        ts: t0 + 86_400_000 + i * 60_000,
        status: 'skipped',
        message: 'skip' + i,
        dur: 0,
      });
    }
    const cookie = await login(base);
    const overview = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();
    const detail = await (await fetch(`${base}/api/tasks/1`, { headers: { cookie } })).json();

    assert.equal(overview.recent.length, 20);
    // 以前详情页先取 50 条（全是 skipped）再过滤 → 0 条，与概览的 20 条对不上
    assert.equal(detail.runs.length, 25);
    assert.deepEqual(
      detail.runs.slice(0, 20).map((r) => r.id),
      overview.recent.map((r) => r.id),
    );
    assert.equal(detail.hiddenSkipped, 50);
  });
});
