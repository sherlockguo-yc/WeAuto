/**
 * HTTP 服务：页面 + JSON 接口 + 登录
 *
 * 几个刻意的取舍：
 *   · **登录态放在 HttpOnly Cookie 里**，不放 localStorage：前端拿不到 token，
 *     XSS 偷不走会话（页面里要渲染外部站点的数据，这个前提不能让步）
 *   · **写操作要求同源**：靠 Origin/Referer 校验挡 CSRF，不引第三方中间件
 *   · **凭据值永不出现在响应里**，只返回字段名与是否已设置
 *   · 页面全部服务端直出：手机端首屏不依赖 JS，JS 只负责「立即执行」这类动作
 */
import path from 'node:path';
import express from 'express';
import { LOGIN_RATE_LIMIT } from './config.mjs';
import { renderView } from './format.mjs';
import * as render from './render.mjs';
import { SecretsError, loadSecrets } from './secrets.mjs';
import { summarizeAll, summarizeTask } from './status.mjs';
import { DB_FILE } from './db.mjs';
import { DATA_DIR, ROOT, humanDuration } from './util.mjs';

const COOKIE = 'wa_session';

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 当前可用凭据的字段名（**只返回名字**）；解密失败时返回原因 */
function credentialFields() {
  try {
    return { keys: Object.keys(loadSecrets()), error: null };
  } catch (err) {
    return { keys: [], error: err instanceof SecretsError ? err.message : String(err.message) };
  }
}

function groupByGroup(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.group)) map.set(it.group, []);
    map.get(it.group).push(it);
  }
  return [...map.entries()].map(([name, list]) => ({ name, items: list }));
}

/**
 * @param {object} deps
 * @param {object} deps.store createStore 的结果
 * @param {object} deps.auth createAuth 的结果
 * @param {Map} deps.tasks 已规范化任务
 * @param {object} deps.scheduler createScheduler 的结果
 * @param {object} deps.config
 */
export function createServer({ store, auth, tasks, scheduler, config, now = () => Date.now() }) {
  const app = express();
  app.set('trust proxy', config.trustProxy ?? true);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));

  /* ───────── 登录限速（内存实现，单进程够用） ───────── */
  const failures = new Map();
  function tooManyFailures(ip) {
    const rec = failures.get(ip);
    if (!rec) return false;
    if (now() > rec.until) {
      failures.delete(ip);
      return false;
    }
    return rec.count >= LOGIN_RATE_LIMIT.maxFailures;
  }
  function noteFailure(ip) {
    const rec = failures.get(ip) ?? { count: 0, until: now() + LOGIN_RATE_LIMIT.windowMs };
    rec.count += 1;
    rec.until = now() + LOGIN_RATE_LIMIT.windowMs;
    failures.set(ip, rec);
  }

  /* ───────── CSRF：写操作必须同源 ───────── */
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.headers.origin || req.headers.referer;
    if (!origin) return next(); // 非浏览器客户端（curl）没有 Origin，不拦
    try {
      if (new URL(origin).host === req.headers.host) return next();
    } catch {
      /* 解析不了就按不通过处理 */
    }
    return res.status(403).json({ error: '拒绝跨站请求' });
  });

  /* ───────── 静态资源 ───────── */
  app.use(
    express.static(path.join(ROOT, 'public'), {
      index: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );

  /* ───────── 会话 ───────── */
  function currentUser(req) {
    const payload = auth.verify(parseCookies(req.headers.cookie)[COOKIE]);
    return payload ? { id: payload.id, username: payload.username, role: payload.role } : null;
  }
  function setSession(req, res, token) {
    const secure = (req.headers['x-forwarded-proto'] ?? '') === 'https';
    const attrs = [
      `${COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${7 * 24 * 3600}`,
      ...(secure ? ['Secure'] : []),
    ];
    res.setHeader('Set-Cookie', attrs.join('; '));
  }
  function clearSession(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  app.use((req, res, next) => {
    req.user = currentUser(req);
    next();
  });

  const requireLogin = (req, res, next) => {
    if (req.user) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未登录' });
    return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  };
  const requireAdmin = (req, res, next) => {
    if (req.user?.role === 'admin') return next();
    return res.status(403).json({ error: '需要管理员权限' });
  };

  /* ───────── 登录 / 首次初始化 ───────── */
  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.type('html').send(
      render.authPage({
        mode: auth.countUsers() === 0 ? 'setup' : 'login',
        redirect: req.query.redirect || '/',
      }),
    );
  });

  function doLogin(req, res, { username, password } = {}) {
    const ip = req.ip ?? 'unknown';
    if (tooManyFailures(ip)) {
      return res
        .status(429)
        .type('html')
        .send(render.authPage({ mode: 'login', error: '尝试过于频繁，请稍后再试' }));
    }
    const result = auth.login(username, password);
    if (!result.ok) {
      noteFailure(ip);
      return res
        .status(401)
        .type('html')
        .send(render.authPage({ mode: 'login', error: result.error }));
    }
    failures.delete(ip);
    setSession(req, res, result.token);
    const to = typeof req.body.redirect === 'string' && req.body.redirect.startsWith('/')
      ? req.body.redirect
      : '/';
    return res.redirect(to);
  }

  app.post('/login', (req, res) => doLogin(req, res, req.body));
  app.post('/setup', (req, res) => {
    if (auth.countUsers() > 0) return res.status(403).type('html').send(render.authPage({ mode: 'login', error: '账号已存在，请直接登录' }));
    const created = auth.register({ ...req.body, role: 'admin' });
    if (!created.ok) {
      return res.status(400).type('html').send(render.authPage({ mode: 'setup', error: created.error }));
    }
    return doLogin(req, res, req.body);
  });
  app.post('/logout', requireLogin, (req, res) => {
    clearSession(res);
    res.redirect('/login');
  });

  /* ───────── 页面 ───────── */
  app.get('/', requireLogin, (req, res) => {
    const data = summarizeAll({ tasks, store, nowMs: now() });
    res.type('html').send(render.layout({ title: '概览', active: 'home', body: render.pageOverview(data), user: req.user }));
  });

  app.get('/tasks', requireLogin, (req, res) => {
    const data = summarizeAll({ tasks, store, nowMs: now() });
    res.type('html').send(
      render.layout({
        title: '任务',
        active: 'tasks',
        body: render.pageTasks({ items: data.items, groups: groupByGroup(data.items) }),
        user: req.user,
      }),
    );
  });

  function detailOf(taskName) {
    const task = tasks.get(taskName);
    if (!task) return null;
    const summary = summarizeTask({ task, store, nowMs: now() });
    const runs = store.runsOfTask(taskName, 50);
    const lastCompleted = runs.find((r) => r.status !== 'skipped') ?? null;
    return {
      task,
      summary,
      view: renderView(summary.view, lastCompleted?.data ?? {}),
      runs,
      lastCompleted,
    };
  }

  app.get('/tasks/:name', requireLogin, (req, res) => {
    const d = detailOf(req.params.name);
    if (!d) return res.status(404).type('html').send(render.layout({ title: '未找到', active: 'tasks', body: '<p class="empty">没有这个任务</p>', user: req.user }));
    res.type('html').send(
      render.layout({
        title: d.task.displayName,
        active: 'tasks',
        body: render.pageTaskDetail({
          task: d.summary,
          view: d.view,
          runs: d.runs,
          canRun: !scheduler.isRunning(d.task.name),
        }),
        user: req.user,
      }),
    );
  });

  app.get('/tasks/:name/config', requireLogin, (req, res) => {
    const task = tasks.get(req.params.name);
    if (!task) return res.status(404).type('html').send(render.layout({ title: '未找到', active: 'tasks', body: '<p class="empty">没有这个任务</p>', user: req.user }));
    const summary = summarizeTask({ task, store, nowMs: now() });
    res.type('html').send(
      render.layout({
        title: `${task.displayName} · 配置`,
        active: 'tasks',
        body: render.pageTaskConfig({ task: { ...summary, retention: task.retention } }),
        user: req.user,
      }),
    );
  });

  app.get('/credentials', requireLogin, (req, res) => {
    const { keys, error } = credentialFields();
    const present = Object.fromEntries(keys.map((k) => [k, true]));
    const grouped = [...tasks.values()].map((t) => ({
      name: t.name,
      displayName: t.displayName,
      requires: t.requires,
      present,
    }));
    res.type('html').send(
      render.layout({
        title: '凭据',
        active: 'creds',
        body: render.pageCredentials({ groups: [{ name: '按任务', tasks: grouped }], secretsError: error }),
        user: req.user,
      }),
    );
  });

  app.get('/settings', requireLogin, (req, res) => {
    const data = summarizeAll({ tasks, store, nowMs: now() });
    res.type('html').send(
      render.layout({
        title: '设置',
        active: 'settings',
        body: render.pageSettings({
          users: auth.listUsers(),
          canCreateUser: req.user.role === 'admin',
          system: {
            version: process.env.WEAUTO_VERSION || 'dev',
            dataDir: DATA_DIR,
            dbFile: path.basename(DB_FILE),
            uptime: humanDuration(process.uptime() * 1000),
            scheduler: '运行中',
            taskCount: data.items.length,
          },
        }),
        user: req.user,
      }),
    );
  });

  /* ───────── JSON 接口（页面与将来的移动端共用） ───────── */
  app.get('/healthz', (req, res) => {
    const data = summarizeAll({ tasks, store, nowMs: now() });
    res.json({
      ok: true,
      version: process.env.WEAUTO_VERSION || 'dev',
      tasks: data.items.length,
      attention: data.attention.length,
      time: new Date(now()).toISOString(),
    });
  });

  app.get('/api/overview', requireLogin, (req, res) =>
    res.json(summarizeAll({ tasks, store, nowMs: now() })),
  );

  app.get('/api/tasks', requireLogin, (req, res) =>
    res.json({ tasks: summarizeAll({ tasks, store, nowMs: now() }).items }),
  );

  app.get('/api/tasks/:name', requireLogin, (req, res) => {
    const d = detailOf(req.params.name);
    if (!d) return res.status(404).json({ error: '没有这个任务' });
    res.json({
      task: d.summary,
      view: d.view,
      runs: d.runs,
      running: scheduler.isRunning(d.task.name),
    });
  });

  app.post('/api/tasks/:name/run', requireLogin, (req, res) => {
    const name = req.params.name;
    if (!tasks.has(name)) return res.status(404).json({ error: '没有这个任务' });
    if (scheduler.isRunning(name)) return res.status(409).json({ error: '该任务正在执行中' });
    scheduler.trigger(name); // 不 await：任务可能跑几十秒，让前端轮询结果
    res.json({ started: true });
  });

  /** 覆盖层：只允许改启停与超时；调度时间留到下一批（要配套的表单与校验） */
  app.patch('/api/tasks/:name', requireLogin, requireAdmin, (req, res) => {
    const name = req.params.name;
    if (!tasks.has(name)) return res.status(404).json({ error: '没有这个任务' });

    const patch = {};
    if (typeof req.body.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (req.body.timeoutMs !== undefined) {
      const t = Number(req.body.timeoutMs);
      if (!Number.isInteger(t) || t <= 0) return res.status(400).json({ error: 'timeoutMs 必须是正整数' });
      patch.timeoutMs = t;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: '没有可更新的字段' });

    store.setOverride(name, patch);
    res.json({ ok: true, override: store.getOverride(name) });
  });

  app.delete('/api/tasks/:name/override', requireLogin, requireAdmin, (req, res) => {
    if (!tasks.has(req.params.name)) return res.status(404).json({ error: '没有这个任务' });
    res.json({ ok: true, cleared: store.clearOverride(req.params.name) });
  });

  app.get('/api/runs', requireLogin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    res.json({
      runs: store.recentRuns(limit, { includeSkipped: req.query.includeSkipped === '1' }),
    });
  });

  app.post('/api/users', requireLogin, requireAdmin, (req, res) => {
    const created = auth.register(req.body ?? {});
    if (!created.ok) return res.status(400).json({ error: created.error });
    res.json({ ok: true, user: created.user });
  });

  app.patch('/api/users/:id', requireLogin, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const target = auth.getUser(id);
    if (!target) return res.status(404).json({ error: '没有这个账号' });
    if (target.id === req.user.id && req.body.status === 'disabled') {
      // 把自己停用等于把自己锁在门外，直接拒绝
      return res.status(400).json({ error: '不能停用当前登录的账号' });
    }
    if (req.body.status) auth.setStatus(id, req.body.status);
    if (req.body.role) auth.setRole(id, req.body.role);
    res.json({ ok: true, user: auth.getUser(id) });
  });

  // 兜底错误处理：express.json 解析失败、路由内意外异常都转成 JSON，避免返回 HTML 堆栈
  app.use((err, req, res, _next) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[server] 未捕获异常:', err);
    res.status(status).json({ error: status === 400 ? '请求格式错误' : '服务器内部错误' });
  });

  return app;
}

export { COOKIE, parseCookies };
