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

  /**
   * 列表/概览的统一入口：可见模板 + 我的数据 + 每个账号缺哪些凭据。
   *
   * 凭据缺失在这里就算出来，是为了让列表能给「待填凭据」打标——
   * 取消凭据页之后，这是唯一能一眼看到哪些实例还没配好的地方。
   */
  const summarizeFor = (req) =>
    summarizeAll({
      tasks: visibleTasks(req),
      store: mine(req),
      nowMs: now(),
      missingCredentials: userSecrets
        ? (taskName, accountKey) => {
            const task = tasks.get(taskName);
            return task ? userSecrets.missing(req.user.id, taskName, accountKey, task.requires) : [];
          }
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
          version: process.env.WEAUTO_VERSION || 'dev',
          dataDir: DATA_DIR,
          dbFile: path.basename(DB_FILE),
          uptime: humanDuration(process.uptime() * 1000),
          scheduler: '运行中',
          // 报「看得见的模板数」而不是实例数：这里回答的是「平台上有几个自动化」，
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
        body: render.pageTasks({ items: data.items, groups: groupByGroup(data.items) }),
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
    // 指定了账号却找不到 → 当作不存在。静默回退到第一个账号的话，
    // 用户会以为自己看的是那个账号，实际是另一个
    const acc = accountKey
      ? sub?.accounts.find((a) => a.accountKey === accountKey) ?? null
      : sub?.accounts[0] ?? null;
    if (accountKey && !acc) return null;
    const summary = summarizeTask({
      task,
      store: mine,
      nowMs: now(),
      accountKey: acc?.accountKey ?? '',
      accountLabel: acc?.label ?? '',
      accountCount: sub?.accounts.length ?? 1,
      accountEnabled: acc?.enabled ?? true,
    });
    /*
     * 历史与顶部状态卡必须是同一个账号：不带 ?account= 时就是第一个账号
     * （acc 的取值见上）。若让「不带参数 = 全部账号」，就会出现
     * 「顶部写着今日已成功、下面第一条却是另一个账号失败」这种新的不一致。
     * 首页「最近执行」是跨任务跨账号的流水，粒度本来就不同 ——
     * 靠在那里标出账号名来对齐，而不是把详情页改成全账号。
     */
    const historyAccountKey = acc?.accountKey ?? null;
    // 窗口 = 最近 50 条（含 skipped），用来算「其中被隐藏了几条 skipped」
    const window = mine.runsOfTask(taskName, {
      accountKey: historyAccountKey,
      limit: 50,
      includeSkipped: true,
    });
    // 展示口径与首页一致：先排除 skipped 再取 50 条
    const runs = includeSkipped
      ? window
      : mine.runsOfTask(taskName, { accountKey: historyAccountKey, limit: 50, includeSkipped: false });
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
   * 配置区要用的数据：哪些凭据字段已填 + 这个实例下的账号列表。
   *
   * 单独抽出来而不是塞进 detailOf()，是因为 detailOf() 也被 /api/tasks/:name 用，
   * 那里只要状态和历史，没必要为每个接口调用多查一遍凭据。
   */
  function credentialOf({ userId, task, accountKey = '' }) {
    const sub = store.forUser(userId).getSubscription(task.name);
    const acc = accountKey
      ? sub?.accounts.find((a) => a.accountKey === accountKey) ?? null
      : sub?.accounts[0] ?? null;
    return {
      account: acc ?? null,
      credential: {
        subscribed: !!sub,
        accountKey: acc?.accountKey ?? '',
        accountLabel: acc?.label ?? '',
        multiAccount: !!task.accounts,
        fields: task.requires.map((key) => ({
          key,
          set: userSecrets
            ? !!userSecrets.fieldStatus(userId, task.name, acc?.accountKey ?? '', [key])[key]
            : false,
        })),
        /* 这个实例下的全部账号：加/删/停用账号都在任务页里做 */
        accounts: (sub?.accounts ?? []).map((a) => ({
          accountKey: a.accountKey,
          label: a.label,
          enabled: a.enabled,
          missing: userSecrets ? userSecrets.missing(userId, task.name, a.accountKey, task.requires) : [],
        })),
      },
    };
  }

  /**
   * 任务页 = 详情 + 配置，两层结构里的最后一层。
   * 原来「列表 → 详情 → 配置」三层里，详情只多了结果和历史，
   * 却让用户为了改一个时间多点一次。
   */
  app.get('/tasks/:name', requireLogin, (req, res) => {
    const d = detailOf(req.params.name, {
      includeSkipped: req.query.all === '1',
      userId: req.user.id,
      role: req.user.role,
      accountKey: String(req.query.account ?? ''),
    });
    if (!d)
      return res
        .status(404)
        .type('html')
        .send(shell(req, { title: '未找到', active: 'tasks', body: '<p class="empty">没有这个任务</p>' }));
    const { credential } = credentialOf({
      userId: req.user.id,
      task: d.task,
      accountKey: String(req.query.account ?? ''),
    });
    res.type('html').send(
      shell(req, {
        title: d.task.displayName,
        active: 'tasks',
        body: render.pageTaskDetail({
          task: {
            ...d.summary,
            retention: d.task.retention,
            // 模板自带的调度，用于表单里「跟随默认」那一项的说明
            templateScheduleLabel: describeSchedule(d.task.schedule),
          },
          view: d.view,
          runs: d.runs,
          hiddenSkipped: d.hiddenSkipped,
          includeSkipped: d.includeSkipped,
          canRun: !scheduler.isRunning(d.task.name, req.user.id),
          credential,
        }),
      }),
    );
  });

  /**
   * 配置已并入任务页：/tasks/:name 本身就是配置页。
   *
   * 保留重定向是为了让旧书签和旧链接不至于 404。校验放在重定向之前——
   * 否则「账号不存在」会先跳一次再 404，用户看到的 URL 就不是他点的那个。
   */
  app.get('/tasks/:name/config', requireLogin, (req, res) => {
    const task = tasks.get(req.params.name);
    const accountKey = String(req.query.account ?? '');
    const notFound = (text) =>
      res
        .status(404)
        .type('html')
        .send(shell(req, { title: '未找到', active: 'tasks', body: `<p class="empty">${text}</p>` }));
    if (!task || (task.visibility === 'internal' && req.user.role !== 'admin')) return notFound('没有这个任务');
    if (accountKey) {
      const sub = mine(req).getSubscription(task.name);
      if (!sub?.accounts.some((a) => a.accountKey === accountKey)) return notFound('没有这个账号');
    }
    res.redirect(
      `/tasks/${encodeURIComponent(req.params.name)}${
        accountKey ? `?account=${encodeURIComponent(accountKey)}` : ''
      }`,
    );
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
    const weekAgo = now() - 7 * 86_400_000;
    res.type('html').send(
      shell(req, {
        title: '管理',
        active: 'admin',
        body: render.pageAdmin({
          users: auth.listUsers(),
          subs: store.subscriptionCounts(),
          today: store.platformStats(dateInTZ(new Date(now()))),
          ranking: store.failureRanking({ sinceMs: weekAgo }).map((r) => ({
            ...r,
            taskLabel: tasks.get(r.task_name)?.displayName ?? r.task_name,
          })),
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
      version: process.env.WEAUTO_VERSION || 'dev',
      templates: tasks.size,
      time: new Date(now()).toISOString(),
    });
  });

  app.get('/api/overview', requireLogin, (req, res) =>
    res.json(summarizeFor(req)),
  );

  app.get('/api/tasks', requireLogin, (req, res) =>
    res.json({ tasks: summarizeFor(req).items }),
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

  /** 单个账号停用/启用：不删凭据与历史，只是不再参与调度 */
  app.patch('/api/subscriptions/:taskName/accounts/:accountKey', requireLogin, (req, res) => {
    const { taskName, accountKey } = req.params;
    if (!tasks.has(taskName)) return res.status(404).json({ error: '没有这个模板' });
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 必须是布尔值' });
    }
    const acc = mine(req).setAccountEnabled(taskName, accountKey, req.body.enabled);
    if (!acc) return res.status(404).json({ error: '没有这个账号' });
    res.json({ ok: true, account: acc });
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

  /**
   * 没有 POST /api/users（管理员代建账号）：账号一律由本人凭邀请链接在 /register
   * 自建，管理员不代填别人的密码。管理员仍能改角色、停用、删号。
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
