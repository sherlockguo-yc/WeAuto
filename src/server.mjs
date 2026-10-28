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
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { LOGIN_RATE_LIMIT } from './config.mjs';
import { renderView } from './format.mjs';
import * as render from './render.mjs';
import { describeSchedule, summarizeAll, summarizeTask } from './status.mjs';
import { normalizeSchedule } from './task-contract.mjs';
import { credentialPeers } from './registry.mjs';
import {
  createPairing,
  looksLikeJwt,
  makePushToken,
  parsePushToken,
  sameSecret,
  tokenExpiryMs,
} from './pairing.mjs';
import { ROOT, dateInTZ, humanDuration } from './util.mjs';

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

  /**
   * 这个账号还缺哪些凭据字段。
   *
   * 「缺」要算上凭据组：同组兄弟模板配过同名字段就算有。否则用户明明只填过
   * 一次 token，另一个任务却一直挂着「待填凭据」，而它其实跑得好好的。
   */
  const missingCredentialsOf = (userId, taskName, accountKey) => {
    if (!userSecrets) return [];
    const task = tasks.get(taskName);
    if (!task) return [];
    return userSecrets.missingWithPeers(
      userId,
      taskName,
      accountKey,
      task.requires,
      credentialPeers(tasks, taskName),
    );
  };

  /**
   * 列表/概览的统一入口：可见模板 + 我的数据 + 每个账号缺哪些凭据。
   *
   * 凭据缺失在这里就算出来，是为了让列表能给「待填凭据」打标——
   * 取消凭据页之后，这是唯一能一眼看到哪些任务还没配好的地方。
   */
  const summarizeFor = (req) =>
    summarizeAll({
      tasks: visibleTasks(req),
      store: mine(req),
      nowMs: now(),
      missingCredentials: userSecrets
        ? (taskName, accountKey) => missingCredentialsOf(req.user.id, taskName, accountKey)
        : null,
    });

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

  /**
   * 所有页面的统一出口：body 之外，骨架里的设置弹层也在这里装配。
   *
   * 不让每个页面自己调 render.layout，是因为弹层属于骨架、每页都得有——
   * 分散到 7 个调用点里迟早漏掉一个，而「这一页点不开设置」只在那一页暴露，
   * 平时很难发现。集中在这里，漏不掉。
   */
  /**
   * 统一的 404 页：**必须给出路**。
   * 以前只有一句「没有这个任务」，页面上没有任何链接，用户只能靠浏览器后退。
   */
  const notFoundPage = (req, res, text) =>
    res
      .status(404)
      .type('html')
      .send(
        shell(req, {
          title: '未找到',
          active: 'tasks',
          body: `<section class="card">
  <h2>没有找到</h2>
  <p class="sub">${text}</p>
  <div class="actions"><a class="btn-link btn-sm" href="/tasks">返回任务列表</a></div>
</section>`,
        }),
      );

  const shell = (req, { title, active, body, banner = '' }) =>
    render.layout({
      title,
      active,
      body,
      banner,
      user: req.user,
      settings: render.settingsPanel({
        username: req.user.username,
        role: req.user.role,
        system: {
          // 显示构建时间（commit 时间，北京时间）而不是短 sha：这一行要回答的是
          // 「我刚刚推的那版上没上线」，08159b6 这种串只有对着 Git 才认得出。
          // sha 没丢 —— 它在 /healthz 里，排查时还能查到。
          version: process.env.WEAUTO_BUILD_TIME || process.env.WEAUTO_VERSION || 'dev',
          uptime: humanDuration(process.uptime() * 1000),
          // 报「看得见的模板数」而不是任务数：这里回答的是「平台上有几个自动化」，
          // 没必要为此把全部订阅和账号再汇总一遍
          taskCount: visibleTasks(req).size,
        },
      }),
    });

  app.get('/', requireLogin, (req, res) => {
    const data = summarizeFor(req);
    res.type('html').send(shell(req, { title: '概览', active: 'home', body: render.pageOverview(data) }));
  });

  app.get('/tasks', requireLogin, (req, res) => {
    const data = summarizeFor(req);
    res.type('html').send(
      shell(req, {
        title: '任务',
        active: 'tasks',
        body: render.pageTasks({
          items: data.items,
          groups: groupByGroup(data.items),
          templates: templateCards(req, data.items),
        }),
      }),
    );
  });

  /**
   * 模板页：看这个模板是什么，再决定建不建任务。
   *
   * `visibleTasks` 已经过滤掉 internal（非 admin 看不见），
   * 所以「不存在」和「没权限」都走同一个 404——403 会证实它存在。
   */
  app.get('/templates/:name', requireLogin, (req, res) => {
    const task = visibleTasks(req).get(req.params.name);
    if (!task) return notFoundPage(req, res, '没有这个模板，或者你没有权限看它。');
    // 已建的同类任务：复用列表那一套状态（今日状态、缺不缺凭据都在里面）
    const mine = summarizeFor(req).items.filter((it) => it.name === task.name);
    res.type('html').send(
      shell(req, {
        title: task.displayName,
        active: 'tasks',
        body: render.pageTemplate({
          template: {
            name: task.name,
            displayName: task.displayName,
            description: task.description || '',
            group: task.group,
            requires: task.requires ?? [],
            scheduleLabel: describeSchedule(task.schedule),
            timeoutMs: task.timeoutMs,
          },
          mine,
        }),
      }),
    );
  });

  /**
   * 顶部模板轨道用的数据：平台提供的每个模板 + 我已经建了几个任务。
   *
   * 模板与任务是两件事：模板是「可以建什么」（平台提供，改不了），
   * 任务是「我建了什么」（一人一份，一个任务只跑一个账号）。
   * 所以这里只描述模板本身，数量单独带出去给用户看。
   */
  function templateCards(req, myItems = []) {
    const countByTemplate = new Map();
    for (const it of myItems) countByTemplate.set(it.name, (countByTemplate.get(it.name) ?? 0) + 1);
    return [...visibleTasks(req).values()]
      .map((t) => ({
        name: t.name,
        displayName: t.displayName,
        description: t.description || '',
        group: t.group,
        tags: t.tags ?? [],
        requires: t.requires ?? [],
        scheduleLabel: describeSchedule(t.schedule),
        count: countByTemplate.get(t.name) ?? 0,
      }))
      .sort((a, b) => a.group.localeCompare(b.group, 'zh') || a.name.localeCompare(b.name));
  }

  function detailOf(taskId, { includeSkipped = false, userId, role } = {}) {
    const mine = store.forUser(userId);
    const t = mine.getTask(taskId);
    if (!t) return null;
    const task = tasks.get(t.taskName);
    if (!task) return null;
    // internal 模板对非 admin 视同不存在
    if (task.visibility === 'internal' && role !== 'admin') return null;
    const summary = summarizeTask({
      task,
      store: mine,
      nowMs: now(),
      id: t.id,
      accountKey: t.accountKey,
      label: t.label,
      config: { enabled: t.enabled, schedule: t.schedule, timeoutMs: t.timeoutMs },
      missingCredentials: missingCredentialsOf(userId, t.taskName, t.accountKey),
    });
    const historyAccountKey = t.accountKey;
    // 窗口 = 最近 50 条（含 skipped），用来算「其中被隐藏了几条 skipped」
    const window = mine.runsOfTask(t.taskName, {
      accountKey: historyAccountKey,
      limit: 50,
      includeSkipped: true,
    });
    // 展示口径与首页一致：先排除 skipped 再取 50 条
    const runs = includeSkipped
      ? window
      : mine.runsOfTask(t.taskName, { accountKey: historyAccountKey, limit: 50, includeSkipped: false });
    const lastCompleted = runs.find((r) => r.status !== 'skipped') ?? null;
    return {
      task,
      summary,
      view: renderView(summary.view, lastCompleted?.data ?? {}),
      runs,
      // 「最近 50 条里被隐藏掉的 skipped 有几条」——点 ?all=1 显示的就是这 50 条
      hiddenSkipped: window.filter((r) => r.status === 'skipped').length,
      includeSkipped,
      lastCompleted,
    };
  }

  /**
   * 配置区要用的数据：这个任务需要哪些凭据字段、已经填了哪些。
   *
   * 单独抽出来而不是塞进 detailOf()，是因为 detailOf() 也被 /api/tasks/:id 用，
   * 那里只要状态和历史，没必要为每个接口调用多查一遍凭据。
   */
  function credentialOf({ userId, taskName, accountKey = '' }) {
    const task = tasks.get(taskName);
    return {
      credential: {
        subscribed: true,
        accountKey,
        fields: (task?.requires ?? []).map((key) => ({
          key,
          set: userSecrets
            ? !!userSecrets.fieldStatus(userId, taskName, accountKey, [key])[key]
            : false,
        })),
      },
    };
  }

  /**
   * 任务页 = 详情 + 配置，两层结构里的最后一层。
   * 原来「列表 → 详情 → 配置」三层里，详情只多了结果和历史，
   * 却让用户为了改一个时间多点一次。
   */
  app.get('/tasks/:id(\\d+)', requireLogin, (req, res) => {
    const d = detailOf(Number(req.params.id), {
      includeSkipped: req.query.all === '1',
      userId: req.user.id,
      role: req.user.role,
    });
    // 任务被删了、或者是别人的任务
    if (!d) return notFoundPage(req, res, '没有这个任务——它可能已经被删除了。');
    const { credential } = credentialOf({
      userId: req.user.id,
      taskName: d.task.name,
      accountKey: d.summary.accountKey,
    });
    res.type('html').send(
      shell(req, {
        title: d.summary.label,
        active: 'tasks',
        body: render.pageTaskDetail({
          task: {
            ...d.summary,
            // 模板自带的调度，用于表单里「跟随默认」那一项的说明
            templateScheduleLabel: describeSchedule(d.task.schedule),
          },
          view: d.view,
          runs: d.runs,
          hiddenSkipped: d.hiddenSkipped,
          includeSkipped: d.includeSkipped,
          canRun: !scheduler.isRunning(d.summary.id, req.user.id),
          credential,
          // 只有 Windows 能靠双击跑起来（.cmd 不需要权限位），其余平台给 .mjs
          isWindows: /Windows/i.test(req.headers['user-agent'] ?? ''),
        }),
      }),
    );
  });

  /** 旧链接兼容：任务页合并后没有 /config 这一层，旧的 /tasks/:name 也不再有账号维度 */
  app.get('/tasks/:name', requireLogin, (req, res) => {
    res.redirect('/tasks');
  });

  /**
   * 凭据页已取消：凭据在任务页里填（`/tasks/:name`）。
   *
   * 这里保留一条重定向，是为了让旧书签和旧链接不至于 404。
   */
  app.get('/credentials', requireLogin, (req, res) => {
    res.redirect('/tasks');
  });

  /** 管理首页（admin）：跨用户的只读统计 + 各管理功能的入口 */
  app.get('/admin', requireLogin, requireAdmin, (req, res) => {
    res.type('html').send(
      shell(req, {
        title: '管理',
        active: 'admin',
        body: render.pageAdmin({
          users: auth.listUsers(),
          subs: store.configCounts(),
          today: store.platformStats(dateInTZ(new Date(now()))),
        }),
      }),
    );
  });

  /** 账号管理（admin）：停用 / 启用、删除 + 邀请码。不提供新建，账号一律走邀请注册 */
  app.get('/admin/users', requireLogin, requireAdmin, (req, res) => {
    res.type('html').send(
      shell(req, {
        title: '账号',
        active: 'admin',
        body: render.pageAdminUsers({
          users: auth.listUsers(),
          canDelete: true,
          invites: invites ? invites.list(50).map((row) => invites.describe(row)) : null,
          baseUrl: originOf(req),
          currentUserId: req.user.id,
        }),
      }),
    );
  });

  /**
   * 设置页已取消：内容搬进了右上角头像展开的弹层（骨架的一部分，每页都在）。
   *
   * 保留这条重定向，同样是为了旧书签和旧链接不至于 404。
   */
  app.get('/settings', requireLogin, (req, res) => {
    res.redirect('/');
  });

  /* ───────── JSON 接口（页面与将来的移动端共用） ───────── */
  app.get('/healthz', (req, res) => {
    // 这个接口不鉴权（给探活用），所以只能报平台级信息，不能带任何用户数据。
    // 多租户后「有几个任务需要注意」是 per-user 的，在这里算不出来也不该算。
    res.json({
      ok: true,
      // 这里是给部署校验和监控看的，保持 sha 不变：它是 Release tag 与产物路径的唯一标识
      version: process.env.WEAUTO_VERSION || 'dev',
      buildTime: process.env.WEAUTO_BUILD_TIME || null,
      templates: tasks.size,
      time: new Date(now()).toISOString(),
    });
  });

  /*
   * 凭据抓取脚本下载 —— **公开，不鉴权**。
   *
   * 为什么不鉴权：脚本里没有任何密钥，它只在本机通过 CDP 读自己客户端发出的
   * Authorization 头；而使用者是用 `curl -O` 下载的，要求他先处理 session cookie
   * 只会把「两行命令搞定」变成「先去浏览器翻 cookie」。
   *
   * 为什么直接读仓库文件而不是内嵌一份副本：脚本会随客户端版本变化，
   * 复制一份就意味着两处会漂移。读文件的话，脚本改了，下载端点自动跟着改。
   *
   * Content-Disposition 用 attachment：否则浏览器可能把 .mjs 当源码内联渲染，
   * 用户看到的是一屏 JS 而不是一个下载。
   */
  /**
   * 可下载的工具脚本 = 模板显式声明过的那些。
   *
   * 白名单而不是扫目录：scripts/ 里还躺着探针、构建脚本等内部工具，
   * 把它们变成一个可枚举的静态目录既没必要也多一份暴露面。
   */
  const toolScripts = new Set(
    [...tasks.values()].map((t) => t.credentialHelper?.download).filter(Boolean),
  );

  app.get('/api/tools/:file', (req, res) => {
    const { file } = req.params;
    // 冒号参数本来就匹配不到 `/`，这里再套一层白名单：路径穿越与「顺手读个别的文件」都挡掉
    if (!toolScripts.has(file)) return res.status(404).json({ error: '没有这个工具脚本' });

    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(ROOT, 'scripts', file), (err) => {
      if (!err) return;
      // 部署包漏了 scripts/ 时的表现。给一句能定位的话，比空白 500 省一次排查。
      if (res.headersSent) return res.end();
      res.status(404).json({ error: '脚本不存在：部署包可能没带 scripts/ 目录' });
    });
  });

  /*
   * ───────── 凭据一键更新：页面发码 → 本机脚本直接推送 ─────────
   *
   * 有些凭据只能在用户自己机器上抓（本机的客户端进程内存里），服务器够不着。
   * 老办法是「抓完 → 手抄 → 粘回网页」，三次人工操作、每次都可能粘错半截。
   * 这里改成：页面发一个一次性码，脚本拿码把值推进来，页面轮询到结果自动刷新。
   *
   * 脚本那一侧没有登录态（它只是终端里的一个进程），所以鉴权靠码，而不是会话。
   */
  const pairing = createPairing({ now });

  /** 页面：申请一次性配对码，并把完整命令拼好返回（前端不用自己拼） */
  app.post('/api/tasks/:id(\\d+)/pair-code', requireLogin, (req, res) => {
    const t = mine(req).getTask(Number(req.params.id));
    if (!t) return res.status(404).json({ error: '没有这个任务' });

    const task = tasks.get(t.taskName);
    const helper = task?.credentialHelper;
    if (!helper?.download) return res.status(400).json({ error: '这个任务不支持一键更新凭据' });
    if ((task.requires ?? []).length !== 1) {
      // 一个码对应一个字段。多字段任务该由模板明确「推哪个」，而不是在这里靠猜
      return res.status(400).json({ error: '一键更新只支持只有一个凭据字段的任务' });
    }

    // 发码时刻要一起返回：前端拿它和 pushedAt 比较，避免上一次推送的旧时间戳让页面误刷新
    const issuedAt = now();
    const { code, expiresAt } = pairing.issue({ userId: req.user.id, taskId: t.id });
    // 用请求自身的 origin：部署在哪个域名、走没走反代，都由客户端那一侧决定
    const origin = `${req.protocol}://${req.get('host')}`;
    const command = `${helper.command ?? `node ${helper.download}`} --push ${origin} --code ${code}`;
    res.json({ code, command, expiresAt, issuedAt });
  });

  /** 页面：轮询脚本推上来了没有。靠它把「跑完了」变成界面上的自动刷新 */
  app.get('/api/tasks/:id(\\d+)/pair-status', requireLogin, (req, res) => {
    const t = mine(req).getTask(Number(req.params.id));
    if (!t) return res.status(404).json({ error: '没有这个任务' });
    res.json({ pushedAt: pairing.pushedAt(t.id) });
  });

  /**
   * 个性化脚本：把配对信息直接写进文件，下载即用，**不需要再生成命令**。
   *
   * 这是「让用户少做一步」的最后一步优化：原来要先点按钮拿码、再复制命令、
   * 再粘到终端——三步都可能出错（码过期、复制漏字符、粘错窗口）。
   * 现在把手输的这一切提前烘进文件，用户只剩「下载 + 运行」。
   *
   * 为什么用 pushToken 而不是配对码：码 10 分钟就失效，用户完全可能下载完
   * 过一小时才想起来跑。pushToken 长期有效，跑挂了也能重跑。
   *
   * 这份文件里含有一个只对「你这一个任务」有效的令牌，所以：
   *   · 必须登录才能下载（别人拿不到你的文件）
   *   · no-store，避免被浏览器/中间层缓存后发给别人
   */
  /**
   * 个性化脚本 / 启动器共用的前置校验。
   * 失败时已经把响应写好了，调用方拿到 null 直接 return 即可。
   */
  function grabberTarget(req, res) {
    const t = mine(req).getTask(Number(req.params.id));
    if (!t) {
      res.status(404).json({ error: '没有这个任务' });
      return null;
    }
    const task = tasks.get(t.taskName);
    const helper = task?.credentialHelper;
    if (!helper?.download) {
      res.status(400).json({ error: '这个任务不支持一键更新凭据' });
      return null;
    }
    if (!userSecrets) {
      res.status(503).json({ error: '凭据存储未就绪' });
      return null;
    }
    if ((task.requires ?? []).length !== 1) {
      res.status(400).json({ error: '一键更新只支持只有一个凭据字段的任务' });
      return null;
    }

    // 同一个任务复用同一个 pushToken：重复下载不会让之前那份文件失效
    let pushToken = userSecrets.get(req.user.id, t.taskName, t.accountKey)?.WEAUTO_PUSH_TOKEN;
    if (!pushToken) {
      pushToken = makePushToken({ userId: req.user.id, taskId: t.id });
      userSecrets.set(req.user.id, t.taskName, t.accountKey, { WEAUTO_PUSH_TOKEN: pushToken });
    }
    return { t, helper, pushToken, server: `${req.protocol}://${req.get('host')}` };
  }

  app.get('/api/tasks/:id(\\d+)/grabber.mjs', requireLogin, (req, res) => {
    const target = grabberTarget(req, res);
    if (!target) return;
    const { t, helper, pushToken, server } = target;

    const source = fs.readFileSync(path.join(ROOT, 'scripts', helper.download), 'utf8');
    const injected = source.replace(
      'const EMBEDDED_PAIRING = null;',
      `const EMBEDDED_PAIRING = ${JSON.stringify({ server, taskId: t.id, pushToken })};`,
    );
    /*
     * 注入失败必须报错，不能把未注入的文件发出去——那份文件跑起来会退化成
     * 「找不到配对信息」，用户看到的是一句莫名其妙的提示，而我们这边毫无痕迹。
     */
    if (injected === source) {
      return res.status(500).json({ error: '脚本缺少 EMBEDDED_PAIRING 锚点，注入失败（脚本被改过？）' });
    }

    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${helper.download}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(injected);
  });

  /**
   * Windows 双击启动器：一个 .cmd，用户下载后双击即可，不需要敲任何命令。
   *
   * 为什么 .cmd 能做到而 macOS 做不到（2026-10-20 实测）：
   *   · Windows 的 .cmd 由 cmd.exe 通过文件关联执行，**不需要可执行权限位**；
   *   · macOS 的 .command 必须有执行位，而浏览器下载不保留权限（HTTP 不传 mode），
   *     实测 644 的文件双击毫无反应；用 zip 保住权限后又会撞 Gatekeeper 隔离标记。
   *
   * .cmd 里只放服务器地址和 pushToken，脚本本体运行时从公开端点现取：
   * 把 20KB 的 JS 塞进批处理要转义一堆字符，既难维护又容易坏。
   */
  app.get('/api/tasks/:id(\\d+)/grabber.cmd', requireLogin, (req, res) => {
    const target = grabberTarget(req, res);
    if (!target) return;
    const { helper, pushToken, server } = target;

    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      'setlocal',
      'title WorkBuddy token updater',
      `set "SERVER=${server}"`,
      `set "PUSH_TOKEN=${pushToken}"`,
      'set "TMPFILE=%TEMP%\\wb-grab-%RANDOM%%RANDOM%.mjs"',
      '',
      'where node >nul 2>nul',
      'if errorlevel 1 (',
      '  echo Node.js 18+ is required. Get it from https://nodejs.org/',
      '  echo.',
      '  pause',
      '  exit /b 1',
      ')',
      '',
      'echo Fetching grabber...',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '${server}/api/tools/${helper.download}' -OutFile '%TMPFILE%' } catch { exit 1 }"`,
      'if not exist "%TMPFILE%" (',
      '  echo Download failed. Check your network and try again.',
      '  echo.',
      '  pause',
      '  exit /b 1',
      ')',
      '',
      'echo Updating WorkBuddy token...',
      'echo.',
      'node "%TMPFILE%" --push "%SERVER%" --push-token "%PUSH_TOKEN%"',
      'set "RC=%ERRORLEVEL%"',
      'del "%TMPFILE%" >nul 2>nul',
      'echo.',
      'pause',
      'exit /b %RC%',
      '',
    ];

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="update-workbuddy-token.cmd"');
    res.setHeader('Cache-Control', 'no-store');
    // CRLF：cmd.exe 对纯 LF 的批处理在某些版本上会解析出错
    res.send(lines.join('\r\n'));
  });

  /**
   * 脚本：推送凭据 —— **不鉴权中间件，靠 code / pushToken 自证**。
   *
   * 两条路径：
   *   · 带 code：首次配对。验证一次性码，写入凭据，并回发长期 pushToken
   *   · 带 pushToken：之后的自动更新。长期令牌存在本机 ~/.weauto/bind.json
   *
   * 为什么首次也要发一个长期令牌：否则每个月都要打开网页点一次按钮，
   * 「一条命令」就退化成「一条命令 + 一次网页操作」。
   */
  app.post('/api/tools/push-token', (req, res) => {
    const { code, pushToken, token } = req.body ?? {};
    const value = String(token ?? '').trim();

    // 明显不对的输入当场退回去，别等到第二天任务跑失败才发现粘错了
    if (!looksLikeJwt(value)) {
      return res.status(400).json({ error: 'token 看起来不是完整的 JWT（应形如 eyJ...），请重新抓一次' });
    }
    if (!userSecrets) return res.status(503).json({ error: '凭据存储未就绪' });

    let entry = null;
    let issuedToken = null;

    if (code) {
      entry = pairing.redeem(code);
      if (!entry) {
        return res.status(400).json({ error: '配对码无效或已过期，回页面重新点一次「一键更新」' });
      }
    } else if (pushToken) {
      const parsed = parsePushToken(pushToken);
      if (!parsed) return res.status(401).json({ error: 'pushToken 格式不对' });
      entry = parsed;
    } else {
      return res.status(400).json({ error: '需要 code 或 pushToken' });
    }

    const t = store.forUser(entry.userId).getTask(entry.taskId);
    if (!t) return res.status(404).json({ error: '任务不存在（可能已被删除）' });
    const task = tasks.get(t.taskName);
    if (!task) return res.status(404).json({ error: '模板不存在' });

    const key = (task.requires ?? [])[0];
    if (!key) return res.status(400).json({ error: '这个任务没有声明凭据字段' });

    if (code) {
      // 首次配对：顺手发一个长期令牌，脚本存本地，以后不用再打开页面
      issuedToken = makePushToken({ userId: entry.userId, taskId: entry.taskId });
    } else {
      // 长期令牌必须和服务器存的那份一致——它和凭据一样是密文存储
      const stored = userSecrets.get(entry.userId, t.taskName, t.accountKey)?.WEAUTO_PUSH_TOKEN;
      if (!stored || !sameSecret(stored, pushToken)) {
        return res.status(401).json({ error: 'pushToken 已失效，请回页面重新配对' });
      }
    }

    userSecrets.set(
      entry.userId,
      t.taskName,
      t.accountKey,
      issuedToken ? { [key]: value, WEAUTO_PUSH_TOKEN: issuedToken } : { [key]: value },
    );
    pairing.markPushed(entry.taskId);

    res.json({
      ok: true,
      taskId: entry.taskId,
      pushToken: issuedToken,
      expiresAt: tokenExpiryMs(value),
    });
  });

  app.get('/api/overview', requireLogin, (req, res) =>
    res.json(summarizeFor(req)),
  );

  app.get('/api/tasks', requireLogin, (req, res) =>
    res.json({ tasks: summarizeFor(req).items }),
  );

  /**
   * 从一个模板建一个任务。
   *
   * 一个任务只跑一个账号：想跑第二个账号就再建一个任务，
   * 所以同一模板可以建多个，每次都带一个新的 account_key。
   *
   * 校验顺序很关键：**不在 registry 里、或 internal 且非 admin，都返回 404**——
   * 返回 403 会证实「这个名字存在但你不配用」，等于把 internal 模板的清单泄露出去。
   */
  app.post('/api/tasks', requireLogin, (req, res) => {
    const template = String(req.body?.template ?? '');
    const task = tasks.get(template);
    if (!task || (task.visibility === 'internal' && req.user.role !== 'admin')) {
      return res.status(404).json({ error: '没有这个模板' });
    }
    try {
      const existing = mine(req).tasksOfTemplate(task.name);
      // 名字默认取模板名，第二个往后自动加序号——用户可以在任务页改
      const label = String(req.body?.label ?? '').trim().slice(0, 32)
        || (existing.length ? `${task.displayName} ${existing.length + 1}` : task.displayName);
      const t = mine(req).createTask(task.name, { label });
      res.json({ ok: true, id: t.id, task: t });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/tasks/:id(\\d+)', requireLogin, (req, res) => {
    const d = detailOf(Number(req.params.id), {
      includeSkipped: req.query.all === '1',
      userId: req.user.id,
      role: req.user.role,
    });
    if (!d) return res.status(404).json({ error: '没有这个任务' });
    res.json({
      task: d.summary,
      view: d.view,
      runs: d.runs,
      hiddenSkipped: d.hiddenSkipped,
      running: scheduler.isRunning(d.summary.id, req.user.id),
    });
  });

  app.post('/api/tasks/:id(\\d+)/run', requireLogin, (req, res) => {
    const id = Number(req.params.id);
    if (scheduler.isRunning(id, req.user.id)) {
      return res.status(409).json({ error: '该任务正在执行中' });
    }
    try {
      // 不 await：任务可能跑几十秒，让前端轮询结果
      scheduler.trigger(id, { userId: req.user.id });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json({ started: true });
  });

  /**
   * 改任务的启停 / 超时 / 调度 / 名字。
   *
   * 调度是「每个任务配自己的」，所以必须能在这里写——调度器会优先用任务里的值
   * （见 scheduler.mjs 的 targets()），写不进去就等于这个功能是假的。
   *
   * 权限：改的是**自己的**任务，所以只要登录即可，不需要 admin。
   */
  app.patch('/api/tasks/:id(\\d+)', requireLogin, (req, res) => {
    const id = Number(req.params.id);
    const t = mine(req).getTask(id);
    if (!t) return res.status(404).json({ error: '没有这个任务' });

    const patch = {};
    if (typeof req.body.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (typeof req.body.label === 'string') patch.label = req.body.label.trim().slice(0, 32);
    if (req.body.timeoutMs !== undefined) {
      const n = Number(req.body.timeoutMs);
      if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'timeoutMs 必须是正整数' });
      patch.timeoutMs = n;
    }
    if (req.body.schedule !== undefined) {
      // null 表示「回到模板默认」
      if (req.body.schedule === null || req.body.schedule === '') {
        patch.schedule = null;
      } else {
        try {
          // 前端可能传原始声明（只有 window/once/every），也可能传规范化后的值（带 kind）
          const { kind, ...declared } = req.body.schedule;
          const normalized = normalizeSchedule(t.taskName, declared);
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
      const updated = mine(req).updateTask(id, patch);
      res.json({ ok: true, task: updated });
    } catch (err) {
      // 间隔下限、任务数上限这类限制都在 store 里，转成 400 让界面直接显示原因
      return res.status(400).json({ error: err.message });
    }
  });

  /** 删掉这个任务（历史记录保留，那是发生过的事实） */
  app.delete('/api/tasks/:id(\\d+)', requireLogin, (req, res) => {
    const t = mine(req).getTask(Number(req.params.id));
    if (!t) return res.status(404).json({ error: '没有这个任务' });
    if (userSecrets) userSecrets.removeAccount(req.user.id, t.taskName, t.accountKey);
    res.json({ ok: true, deleted: mine(req).deleteTask(t.id) });
  });

  /**
   * 写入**我自己**某个任务的凭据。
   *
   * 三条硬约束：
   *   · 只能写这个模板声明过的字段（白名单）——否则凭据库会变成任意数据的垃圾桶
   *   · 任务必须是我自己的——传 id 而不是名字，避免拿别人的 accountKey 覆盖别人的凭据
   *   · 留空表示不修改：界面上不会因为一个空输入框就把已有凭据清掉
   */
  app.post('/api/credentials', requireLogin, (req, res) => {
    if (!userSecrets) return res.status(503).json({ error: '凭据存储未就绪' });

    const id = Number(req.body?.taskId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '缺少 taskId' });
    const t = mine(req).getTask(id);
    if (!t) return res.status(404).json({ error: '没有这个任务' });
    const task = tasks.get(t.taskName);
    if (!task) return res.status(404).json({ error: '没有这个模板' });

    const fields = req.body?.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return res.status(400).json({ error: '缺少 fields 对象' });
    }

    const allowed = new Set(task.requires);
    const notAllowed = Object.keys(fields).find((k) => !allowed.has(k));
    if (notAllowed) return res.status(400).json({ error: `字段 ${notAllowed} 不属于这个模板` });
    const notString = Object.keys(fields).find((k) => typeof fields[k] !== 'string');
    if (notString) return res.status(400).json({ error: `字段 ${notString} 的值必须是字符串` });
    if (!Object.keys(fields).length) return res.status(400).json({ error: '没有要修改的字段' });

    try {
      // 只回字段名，绝不回值
      res.json({ ok: true, keys: userSecrets.set(req.user.id, t.taskName, t.accountKey, fields) });
    } catch (err) {
      res.status(500).json({ error: '写入凭据失败' });
    }
  });

  app.get('/api/runs', requireLogin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    res.json({
      runs: mine(req).recentRuns(limit, { includeSkipped: req.query.includeSkipped === '1' }),
    });
  });

  /**
   * 没有 POST /api/users（管理员代建账号）：账号一律由本人凭邀请链接在 /register
   * 自建，管理员不代填别人的密码。管理员仍能改角色、停用、删号，以及写备注。
   */

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
      // invites 的两条外键没有级联，必须单独清；顺序在删账号之前
      if (invites) invites.purgeUser(id);
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
    if (target.id === req.user.id && req.body.role && req.body.role !== target.role) {
      // 页面里没有改自己角色的入口，但接口上不挡的话，唯一的管理员能把自己降成
      // 普通用户，之后再也进不了管理页、也没人能把他升回来（只能改数据库）
      return res.status(400).json({ error: '不能修改自己的角色' });
    }
    if (req.body.status) auth.setStatus(id, req.body.status);
    if (req.body.role) auth.setRole(id, req.body.role);
    // 备注：空串是有意义的输入（清空备注），所以判类型而不是判真假。
    // 截断与换行折叠在数据层做，接口只负责拒绝非字符串。
    if (req.body.note !== undefined) {
      if (typeof req.body.note !== 'string') {
        return res.status(400).json({ error: '备注必须是文本' });
      }
      auth.setNote(id, req.body.note);
    }
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
