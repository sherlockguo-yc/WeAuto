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
import { describeSchedule, summarizeAll, summarizeTask } from './status.mjs';
import { normalizeSchedule } from './task-contract.mjs';
import { DB_FILE } from './db.mjs';
import { DATA_DIR, ROOT, dateInTZ, humanDuration } from './util.mjs';

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
export function createServer({
  store,
  auth,
  tasks,
  scheduler,
  config,
  /** 每用户凭据（createUserSecrets 的结果）。不传则凭据页只读显示「未就绪」 */
  userSecrets = null,
  /** 邀请码（createInvites 的结果）。注册功能依赖它 */
  invites = null,
  /** 数据库连接：注册要在事务里「建账号 + 消耗邀请码」 */
  db = null,
  now = () => Date.now(),
}) {
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
  /**
   * token 里没有账号状态，所以每次都要回查一次 users。
   *
   * 不查的后果：把某个账号停用后，他已经拿到的 token 还能用到 7 天过期为止——
   * 停用只能阻止「重新登录」，等于形同虚设。查一次主键的代价可以忽略。
   */
  function currentUser(req) {
    const payload = auth.verify(parseCookies(req.headers.cookie)[COOKIE]);
    if (!payload?.id) return null;
    const user = auth.getUser(payload.id);
    if (!user || user.status !== 'active') return null;
    // 注销 / 改密之后，之前签发的 token 立即作废（版本号对不上）
    if (user.sessionEpoch !== payload.se) return null;
    return { id: user.id, username: user.username, role: user.role, status: user.status };
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

  /**
   * 每个请求都先绑定用户：多租户下所有数据访问都要经过它。
   * 不提供「不带用户的 store」，是为了让「忘了过滤 user_id」在结构上不可能发生。
   */
  const mine = (req) => store.forUser(req.user.id);

  /**
   * 这个人能看见哪些模板。`internal` 的只有 admin 看得见——
   * 用途是「我自己专用的自动化」和「还在调试、不想给别人看到的半成品」。
   */
  const visibleTasks = (req) => {
    const out = new Map();
    for (const [name, task] of tasks) {
      if (task.visibility === 'internal' && req.user?.role !== 'admin') continue;
      out.set(name, task);
    }
    return out;
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
    // 先把这个账号已签发的 token 全部作废，再清 cookie。
    // 只清 cookie 的话，那个值的副本在 7 天内仍然有效。
    auth.bumpSessionEpoch(req.user.id);
    clearSession(res);
    res.redirect('/login');
  });

  /* ───────── 邀请码注册 ───────── */

  /* 注册口同样在公网上，失败要限速。与登录分开计数：别让注册失败把登录也锁了 */
  const registerFailures = new Map();
  function tooManyRegisterFailures(ip) {
    const rec = registerFailures.get(ip);
    if (!rec) return false;
    if (now() > rec.until) {
      registerFailures.delete(ip);
      return false;
    }
    return rec.count >= LOGIN_RATE_LIMIT.maxFailures;
  }
  function noteRegisterFailure(ip) {
    const rec = registerFailures.get(ip) ?? { count: 0, until: now() + LOGIN_RATE_LIMIT.windowMs };
    rec.count += 1;
    rec.until = now() + LOGIN_RATE_LIMIT.windowMs;
    registerFailures.set(ip, rec);
  }

  /** 无码时是否允许注册。默认只走邀请码（需求文档 §6 第 7 条） */
  const inviteOnly = config.inviteOnly !== false;

  app.get('/register', (req, res) => {
    if (req.user) return res.redirect('/');
    const code = String(req.query.code ?? '');
    const checked = invites ? invites.check(code) : { ok: false, message: '未启用邀请码功能' };

    // 无码且只允许邀请 → 直接说清楚，不给表单
    if (!code && inviteOnly) {
      return res
        .status(403)
        .type('html')
        .send(render.registerPage({ code: '', fatal: '这个站点只接受邀请注册，需要管理员给你一个邀请链接' }));
    }
    if (!checked.ok) {
      return res.status(403).type('html').send(render.registerPage({ code, fatal: checked.message }));
    }
    res.type('html').send(render.registerPage({ code }));
  });

  app.post('/register', (req, res) => {
    if (req.user) return res.redirect('/');
    if (!invites || !db) {
      return res.status(503).type('html').send(render.registerPage({ code: '', fatal: '注册功能未启用' }));
    }

    const ip = req.ip ?? 'unknown';
    if (tooManyRegisterFailures(ip)) {
      return res
        .status(429)
        .type('html')
        .send(render.registerPage({ code: '', fatal: '尝试过于频繁，请稍后再试' }));
    }

    const code = String(req.body?.code ?? '');
    const { username, password } = req.body ?? {};

    // 服务端重新校验：表单里的 code 是隐藏字段，客户端可以改
    const checked = invites.check(code);
    if (!checked.ok) {
      noteRegisterFailure(ip);
      return res.status(403).type('html').send(render.registerPage({ code, fatal: checked.message }));
    }

    let account;
    try {
      account = db.transaction(() => {
        // 角色固定为 user：admin 只能由管理员在后台升级，不能靠邀请码拿到
        const created = auth.register({ username, password, role: 'user' });
        if (!created.ok) throw new Error(created.error);
        if (!invites.consume(code, created.user.id)) {
          throw new Error('这个邀请码刚刚被用掉了');
        }
        return created.user;
      })();
    } catch (err) {
      noteRegisterFailure(ip);
      return res
        .status(400)
        .type('html')
        .send(render.registerPage({ code, error: err.message, username: String(username ?? '') }));
    }

    registerFailures.delete(ip);
    const logged = auth.login(username, password);
    if (!logged.ok) return res.redirect('/login');
    setSession(req, res, logged.token);
    res.redirect('/');
  });

  /* ───────── 页面 ───────── */
  app.get('/', requireLogin, (req, res) => {
    const data = summarizeAll({ tasks: visibleTasks(req), store: mine(req), nowMs: now() });
    res.type('html').send(render.layout({ title: '概览', active: 'home', body: render.pageOverview(data), user: req.user }));
  });

  app.get('/tasks', requireLogin, (req, res) => {
    const data = summarizeAll({ tasks: visibleTasks(req), store: mine(req), nowMs: now() });
    res.type('html').send(
      render.layout({
        title: '任务',
        active: 'tasks',
        body: render.pageTasks({ items: data.items, groups: groupByGroup(data.items) }),
        user: req.user,
      }),
    );
  });

  function detailOf(taskName, { includeSkipped = false, userId, role, accountKey = '' } = {}) {
    const task = tasks.get(taskName);
    if (!task) return null;
    // internal 模板对非 admin 视同不存在
    if (task.visibility === 'internal' && role !== 'admin') return null;
    const mine = store.forUser(userId);
    const sub = mine.getSubscription(taskName);
    const acc = sub?.accounts.find((a) => a.accountKey === accountKey) ?? sub?.accounts[0] ?? null;
    const summary = summarizeTask({
      task,
      store: mine,
      nowMs: now(),
      accountKey: acc?.accountKey ?? '',
      accountLabel: acc?.label ?? '',
      accountCount: sub?.accounts.length ?? 1,
      accountEnabled: acc?.enabled ?? true,
    });
    // 指定账号时只看这个账号的历史；不指定就全部账号
    const all = mine.runsOfTask(taskName, { accountKey: acc?.accountKey ?? null, limit: 50 });
    // 历史默认隐藏 skipped：间隔类任务跑顺之后，跳过记录会把有用的行挤下去
    const runs = includeSkipped ? all : all.filter((r) => r.status !== 'skipped');
    const lastCompleted = all.find((r) => r.status !== 'skipped') ?? null;
    return {
      task,
      summary,
      view: renderView(summary.view, lastCompleted?.data ?? {}),
      runs,
      hiddenSkipped: all.length - runs.length,
      includeSkipped,
      lastCompleted,
    };
  }

  app.get('/tasks/:name', requireLogin, (req, res) => {
    const d = detailOf(req.params.name, {
      includeSkipped: req.query.all === '1',
      userId: req.user.id,
      role: req.user.role,
      accountKey: String(req.query.account ?? ''),
    });
    if (!d) return res.status(404).type('html').send(render.layout({ title: '未找到', active: 'tasks', body: '<p class="empty">没有这个任务</p>', user: req.user }));
    res.type('html').send(
      render.layout({
        title: d.task.displayName,
        active: 'tasks',
        body: render.pageTaskDetail({
          task: d.summary,
          view: d.view,
          runs: d.runs,
          hiddenSkipped: d.hiddenSkipped,
          includeSkipped: d.includeSkipped,
          canRun: !scheduler.isRunning(d.task.name, req.user.id),
        }),
        user: req.user,
      }),
    );
  });

  app.get('/tasks/:name/config', requireLogin, (req, res) => {
    const task = tasks.get(req.params.name);
    if (!task) return res.status(404).type('html').send(render.layout({ title: '未找到', active: 'tasks', body: '<p class="empty">没有这个任务</p>', user: req.user }));
    const summary = summarizeTask({ task, store: mine(req), nowMs: now() });
    res.type('html').send(
      render.layout({
        title: `${task.displayName} · 配置`,
        active: 'tasks',
        body: render.pageTaskConfig({
          task: {
            ...summary,
            retention: task.retention,
            // 模板自带的调度，用于表单里「跟随默认」那一项的说明
            templateScheduleLabel: describeSchedule(task.schedule),
          },
        }),
        user: req.user,
      }),
    );
  });

  /**
   * 凭据页：**只列这个人自己订阅过的模板**，按账号分组。
   *
   * 多租户前这里是「全站一份凭据、只有 admin 能改」，现在每个人有自己的一份，
   * 所以权限判断从「是不是 admin」变成「是不是他自己的」。
   */
  app.get('/credentials', requireLogin, (req, res) => {
    const groups = [];
    for (const sub of mine(req).listSubscriptions()) {
      const task = tasks.get(sub.taskName);
      if (!task) continue; // 模板已下线：保留订阅行，但不显示（没有字段可填）
      const accounts = sub.accounts.map((acc) => ({
        accountKey: acc.accountKey,
        label: acc.label,
        enabled: acc.enabled,
        fields: task.requires.map((key) => ({
          key,
          set: userSecrets
            ? !!userSecrets.fieldStatus(req.user.id, sub.taskName, acc.accountKey, [key])[key]
            : false,
        })),
      }));
      groups.push({
        name: task.displayName,
        description: task.description,
        taskName: sub.taskName,
        requires: task.requires,
        multiAccount: !!task.accounts,
        accounts,
      });
    }

    res.type('html').send(
      render.layout({
        title: '凭据',
        active: 'creds',
        body: render.pageCredentials({
          groups,
          secretsError: userSecrets ? null : '凭据存储未就绪（缺少主密钥）',
        }),
        user: req.user,
      }),
    );
  });

  /** 平台概览（admin）：跨用户的只读统计。普通用户看不到入口也访问不了 */
  app.get('/admin', requireLogin, requireAdmin, (req, res) => {
    const users = auth.listUsers();
    const weekAgo = now() - 7 * 86_400_000;
    res.type('html').send(
      render.layout({
        title: '平台',
        active: 'admin',
        body: render.pageAdmin({
          users,
          subs: store.subscriptionCounts(),
          today: store.platformStats(dateInTZ(new Date(now()))),
          ranking: store.failureRanking({ sinceMs: weekAgo }).map((r) => ({
            ...r,
            taskLabel: tasks.get(r.task_name)?.displayName ?? r.task_name,
          })),
          currentUserId: req.user.id,
        }),
        user: req.user,
      }),
    );
  });

  app.get('/settings', requireLogin, (req, res) => {
    const data = summarizeAll({ tasks: visibleTasks(req), store: mine(req), nowMs: now() });
    res.type('html').send(
      render.layout({
        title: '设置',
        active: 'settings',
        body: render.pageSettings({
          users: auth.listUsers(),
          canCreateUser: req.user.role === 'admin',
          currentUserId: req.user.id,
          invites:
            req.user.role === 'admin' && invites
              ? invites.list(50).map((row) => invites.describe(row))
              : [],
          baseUrl: originOf(req),
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
    // 这个接口不鉴权（给探活用），所以只能报平台级信息，不能带任何用户数据。
    // 多租户后「有几个任务需要注意」是 per-user 的，在这里算不出来也不该算。
    res.json({
      ok: true,
      version: process.env.WEAUTO_VERSION || 'dev',
      templates: tasks.size,
      time: new Date(now()).toISOString(),
    });
  });

  app.get('/api/overview', requireLogin, (req, res) =>
    res.json(summarizeAll({ tasks: visibleTasks(req), store: mine(req), nowMs: now() })),
  );

  app.get('/api/tasks', requireLogin, (req, res) =>
    res.json({ tasks: summarizeAll({ tasks: visibleTasks(req), store: mine(req), nowMs: now() }).items }),
  );

  app.get('/api/tasks/:name', requireLogin, (req, res) => {
    const d = detailOf(req.params.name, {
      includeSkipped: req.query.all === '1',
      userId: req.user.id,
      role: req.user.role,
      accountKey: String(req.query.account ?? ''),
    });
    if (!d) return res.status(404).json({ error: '没有这个任务' });
    res.json({
      task: d.summary,
      view: d.view,
      runs: d.runs,
      hiddenSkipped: d.hiddenSkipped,
      running: scheduler.isRunning(d.task.name, req.user.id),
    });
  });

  app.post('/api/tasks/:name/run', requireLogin, (req, res) => {
    const name = req.params.name;
    const accountKey = String(req.body?.accountKey ?? '');
    if (!tasks.has(name)) return res.status(404).json({ error: '没有这个任务' });
    if (scheduler.isRunning(name, req.user.id, accountKey)) {
      return res.status(409).json({ error: '该任务正在执行中' });
    }
    try {
      // 不 await：任务可能跑几十秒，让前端轮询结果
      scheduler.trigger(name, { userId: req.user.id, accountKey });
    } catch (err) {
      // 没订阅就触发是常见误操作（比如在模板市场点了运行），给 400 而不是 500
      return res.status(400).json({ error: err.message });
    }
    res.json({ started: true });
  });

  /**
   * 改订阅配置：启停、超时、调度时间。
   *
   * 调度时间是「每个用户配自己的」，所以必须能在这里写——调度器会优先用订阅里的值
   * （见 scheduler.mjs 的 targets()），写不进去就等于这个功能是假的。
   *
   * 权限：改的是**自己的**订阅，所以只要登录即可，不需要 admin。
   * admin 与 user 在这条路上没有区别——多租户下「自己的任务自己配」是前提。
   */
  app.patch('/api/tasks/:name', requireLogin, (req, res) => {
    const name = req.params.name;
    if (!tasks.has(name)) return res.status(404).json({ error: '没有这个任务' });

    const patch = {};
    if (typeof req.body.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (req.body.timeoutMs !== undefined) {
      const t = Number(req.body.timeoutMs);
      if (!Number.isInteger(t) || t <= 0) return res.status(400).json({ error: 'timeoutMs 必须是正整数' });
      patch.timeoutMs = t;
    }
    if (req.body.schedule !== undefined) {
      // null 表示「回到模板默认」
      if (req.body.schedule === null || req.body.schedule === '') {
        patch.schedule = null;
      } else {
        try {
          // 前端可能传原始声明（只有 window/once/every），也可能传规范化后的值（带 kind）
          const { kind, ...declared } = req.body.schedule;
          const normalized = normalizeSchedule(name, declared);
          if (kind && normalized && normalized.kind !== kind) {
            return res.status(400).json({ error: '调度配置自相矛盾：kind 与内容不一致' });
          }
          patch.schedule = normalized;
        } catch (err) {
          return res.status(400).json({ error: `调度配置无效：${err.message}` });
        }
      }
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: '没有可更新的字段' });

    try {
      // 没有订阅就先建一个：admin 在「模板」视角下改配置是常见路径
      if (!mine(req).getSubscription(name)) mine(req).subscribe(name);
      mine(req).setSubscription(name, patch);
    } catch (err) {
      // 间隔下限、订阅上限这类限制都在 store 里，转成 400 让界面直接显示原因
      return res.status(400).json({ error: err.message });
    }
    res.json({ ok: true, subscription: mine(req).getSubscription(name) });
  });

  /** 取消订阅（原「清掉覆盖层」）。多租户下没有「回到全局默认」这回事了 */
  app.delete('/api/tasks/:name/override', requireLogin, (req, res) => {
    if (!tasks.has(req.params.name)) return res.status(404).json({ error: '没有这个任务' });
    res.json({ ok: true, cleared: mine(req).unsubscribe(req.params.name) });
  });

  /**
   * 写入**我自己**在某个模板某个账号下的凭据。
   *
   * 三条硬约束：
   *   · 只能写这个模板声明过的字段（白名单）——否则凭据库会变成任意数据的垃圾桶
   *   · 必须先订阅过——没有实例就不该有凭据
   *   · 账号必须是这个订阅下的——防止拿别人的 accountKey 覆盖别人的凭据
   *
   * **留空表示不修改**：界面上不会因为一个空输入框就把已有凭据清掉。
   */
  app.post('/api/credentials', requireLogin, (req, res) => {
    if (!userSecrets) return res.status(503).json({ error: '凭据存储未就绪' });

    const { taskName, accountKey = '', fields } = req.body ?? {};
    if (typeof taskName !== 'string') return res.status(400).json({ error: '缺少 taskName' });
    const task = tasks.get(taskName);
    if (!task) return res.status(404).json({ error: '没有这个模板' });
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return res.status(400).json({ error: '缺少 fields 对象' });
    }

    const allowed = new Set(task.requires);
    const notAllowed = Object.keys(fields).find((k) => !allowed.has(k));
    if (notAllowed) return res.status(400).json({ error: `字段 ${notAllowed} 不属于这个模板` });
    const notString = Object.keys(fields).find((k) => typeof fields[k] !== 'string');
    if (notString) return res.status(400).json({ error: `字段 ${notString} 的值必须是字符串` });
    if (!Object.keys(fields).length) return res.status(400).json({ error: '没有要修改的字段' });

    const sub = mine(req).getSubscription(taskName);
    if (!sub) return res.status(400).json({ error: '还没有启用这个模板' });
    if (accountKey && !sub.accounts.some((a) => a.accountKey === accountKey)) {
      return res.status(404).json({ error: '没有这个账号' });
    }

    try {
      // 只回字段名，绝不回值
      res.json({ ok: true, keys: userSecrets.set(req.user.id, taskName, accountKey, fields) });
    } catch (err) {
      res.status(500).json({ error: '写入凭据失败' });
    }
  });

  /* ───────── 订阅与账号 ───────── */

  /**
   * 启用一个模板（= 建一个我自己的实例）。
   *
   * 校验顺序很关键：**不在 registry 里、或 internal 且非 admin，都返回 404**——
   * 返回 403 会证实「这个名字存在但你不配用」，等于把 internal 模板的清单泄露出去。
   */
  app.post('/api/subscriptions', requireLogin, (req, res) => {
    const name = req.body?.taskName;
    if (typeof name !== 'string') return res.status(400).json({ error: '缺少 taskName' });
    const task = tasks.get(name);
    if (!task || (task.visibility === 'internal' && req.user.role !== 'admin')) {
      return res.status(404).json({ error: '没有这个模板' });
    }
    try {
      mine(req).subscribe(name);
      res.json({ ok: true, subscription: mine(req).getSubscription(name) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** 给支持多账号的模板加一个账号（accounts: true 才允许） */
  app.post('/api/subscriptions/:taskName/accounts', requireLogin, (req, res) => {
    const task = tasks.get(req.params.taskName);
    if (!task) return res.status(404).json({ error: '没有这个模板' });
    if (!task.accounts) return res.status(400).json({ error: '这个模板不支持多账号' });
    if (!mine(req).getSubscription(task.name)) {
      return res.status(400).json({ error: '还没有启用这个模板' });
    }
    try {
      const accountKey = mine(req).addAccount(task.name, {
        label: String(req.body?.label ?? '').trim().slice(0, 32) || '未命名',
      });
      res.json({ ok: true, accountKey });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** 删账号：连它的凭据一起删（历史记录保留，那是发生过的事实） */
  app.delete('/api/subscriptions/:taskName/accounts/:accountKey', requireLogin, (req, res) => {
    const { taskName, accountKey } = req.params;
    if (!tasks.has(taskName)) return res.status(404).json({ error: '没有这个模板' });
    if (!accountKey) return res.status(400).json({ error: '默认账号不能删除' });
    const sub = mine(req).getSubscription(taskName);
    if (!sub || !sub.accounts.some((a) => a.accountKey === accountKey)) {
      return res.status(404).json({ error: '没有这个账号' });
    }
    mine(req).removeAccount(taskName, accountKey);
    if (userSecrets) userSecrets.removeAccount(req.user.id, taskName, accountKey);
    res.json({ ok: true });
  });

  app.get('/api/runs', requireLogin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    res.json({
      runs: mine(req).recentRuns(limit, { includeSkipped: req.query.includeSkipped === '1' }),
    });
  });

  app.post('/api/users', requireLogin, requireAdmin, (req, res) => {
    const created = auth.register(req.body ?? {});
    if (!created.ok) return res.status(400).json({ error: created.error });
    res.json({ ok: true, user: created.user });
  });

  /**
   * 删号：连带清掉他的一切，不可恢复。
   *
   * 顺序要紧：runs / run_logs / run_stats_daily / task_state 没有外键兜底
   * （ALTER TABLE 加不了 REFERENCES），必须先手动清；订阅与凭据才靠 CASCADE。
   * 反过来的话会先触发外键约束，删到一半失败。
   */
  app.delete('/api/users/:id', requireLogin, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的用户 id' });
    if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
    if (!auth.getUser(id)) return res.status(404).json({ error: '没有这个账号' });

    try {
      store.purgeUser(id);
      if (userSecrets) userSecrets.removeUser(id);
      auth.removeUser(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: '删除账号失败' });
    }
  });

  /* ───────── 邀请码（只有 admin 能发、能撤） ───────── */
  const originOf = (req) =>
    config.publicBaseUrl || `${req.protocol}://${req.headers.host}`;

  app.post('/api/invites', requireLogin, requireAdmin, (req, res) => {
    if (!invites) return res.status(503).json({ error: '未启用邀请码' });

    const expiresInDays = Number(req.body?.expiresInDays);
    const maxUses = Number(req.body?.maxUses);
    const row = invites.create({
      createdBy: req.user.id,
      expiresInDays: Number.isFinite(expiresInDays) && expiresInDays >= 0 ? expiresInDays : 7,
      maxUses: Number.isInteger(maxUses) && maxUses > 0 ? maxUses : 1,
      note: String(req.body?.note ?? ''),
    });
    res.json({
      ok: true,
      invite: invites.describe(row),
      url: `${originOf(req)}/register?code=${row.code}`,
    });
  });

  app.delete('/api/invites/:code', requireLogin, requireAdmin, (req, res) => {
    if (!invites) return res.status(503).json({ error: '未启用邀请码' });
    res.json({ ok: true, revoked: invites.revoke(req.params.code) });
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
