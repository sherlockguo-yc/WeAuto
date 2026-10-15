/**
 * 服务端 HTML 渲染
 *
 * 不引模板引擎：页面结构就这几个，手写反而更好控制转义这件事。
 * **所有插入 HTML 的用户数据都要经过 esc()** —— 任务返回的 message、data 来自
 * 外部站点，属于不可信输入，漏一处转义就是一个 XSS。
 *
 * 渲染「任务结果」时只认契约里的 `view` 声明，页面里**不允许出现任务名判断**。
 */
import { renderView } from './format.mjs';

export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** 今日状态的展示口径（唯一的映射处，页面与接口共用） */
export const STATUS_LABEL = {
  success: { text: '今日已成功', tone: 'ok' },
  pending: { text: '待执行', tone: 'wait' },
  manual: { text: '仅手动', tone: 'off' },
  disabled: { text: '已停用', tone: 'off' },
  missed: { text: '已错过', tone: 'bad' },
  failed: { text: '失败', tone: 'bad' },
  blocked: { text: '被拦截', tone: 'bad' },
  'network-error': { text: '网络错误', tone: 'bad' },
  'config-error': { text: '配置错误', tone: 'bad' },
  'already-signed': { text: '今日已完成', tone: 'ok' },
};

export function statusBadge(status) {
  const s = STATUS_LABEL[status] ?? { text: status ?? '未知', tone: 'off' };
  return `<span class="badge badge-${s.tone}">${esc(s.text)}</span>`;
}

/**
 * 单条执行记录的文案。
 *
 * 与「今日状态」分开是必要的：同一条 `success`，在概览里该说「今日已成功」，
 * 在历史列表里只能说「成功」——把「今日」两个字贴到昨天的记录上就是错的。
 */
const RUN_LABEL = {
  success: { text: '成功', tone: 'ok' },
  'already-signed': { text: '已完成', tone: 'ok' },
  skipped: { text: '已跳过', tone: 'off' },
  failed: { text: '失败', tone: 'bad' },
  blocked: { text: '被拦截', tone: 'bad' },
  'network-error': { text: '网络错误', tone: 'bad' },
  'config-error': { text: '配置错误', tone: 'bad' },
};

export function runBadge(status) {
  const s = RUN_LABEL[status] ?? { text: status ?? '未知', tone: 'off' };
  return `<span class="badge badge-${s.tone}">${esc(s.text)}</span>`;
}

/* ── 图标 ────────────────────────────────────────────────
   全部内联 SVG，不引外部资源也不装图标库：部署时少一个失效点。
   统一 24 视口、描边风格，颜色跟着 currentColor 走。
   ------------------------------------------------------ */
const ICON = {
  brand:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
  home:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></svg>',
  tasks:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M3.8 6.5l1.1 1.1L7 5.4"/><path d="M3.8 12l1.1 1.1L7 10.9"/><path d="M3.8 17.5l1.1 1.1L7 16.4"/></svg>',
  caret:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>',
  admin:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2l7 2.8v5.6c0 4.4-2.9 7.4-7 8.9-4.1-1.5-7-4.5-7-8.9V6l7-2.8z"/><path d="M9.4 11.9l1.9 1.9 3.6-3.6"/></svg>',
  eye:
    '<svg class="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 12S6 6.2 12 6.2 21.8 12 21.8 12 18 17.8 12 17.8 2.2 12 2.2 12z"/><circle cx="12" cy="12" r="2.7"/></svg>',
  eyeOff:
    '<svg class="icon-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.7 6.4A9.7 9.7 0 0 1 12 6.2c6 0 9.8 5.8 9.8 5.8a17.6 17.6 0 0 1-3.2 3.8"/><path d="M6.5 8.3A16.6 16.6 0 0 0 2.2 12S6 17.8 12 17.8a9.8 9.8 0 0 0 3.6-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  play:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7.5 4.6a1 1 0 0 1 1.52-.86l9.1 6.4a1 1 0 0 1 0 1.72l-9.1 6.4a1 1 0 0 1-1.52-.86z"/></svg>',
};

/**
 * 底部导航只放「看数据的两个页面」。
 * 设置不是页面，是右上角头像展开的弹层——它只有两项内容（外观、系统信息），
 * 占一个底部 tab 太奢侈，而且让用户以为里面还有别的东西。
 */
const NAV = [
  { href: '/', label: '概览', key: 'home', icon: ICON.home },
  { href: '/tasks', label: '任务', key: 'tasks', icon: ICON.tasks },
  /** 只有管理员看得到：普通用户看平台全局没有意义，也是信息泄露 */
  { href: '/admin', label: '管理', key: 'admin', icon: ICON.admin, adminOnly: true },
];

/**
 * 主题启动脚本（内联在 <head> 里，必须在样式生效前跑完）。
 *
 * 为什么要内联：主题存在 localStorage，服务端不知道用户选了什么。若等到
 * app.js 加载后再切换，页面会先按系统主题画一遍再翻转 —— 手机上就是一次明显的闪屏。
 */
export const THEME_BOOT =
  `try{var t=localStorage.getItem('weauto-theme');` +
  `if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}`;

/**
 * 页面骨架。移动端优先：底部是导航条，内容单列。
 *
 * @param {{title: string, active: string, body: string, user?: object|null,
 *          banner?: string, settings?: string}} opts
 * @param {string} [opts.settings] 右上角弹层的内容（settingsPanel 的结果）。
 *   它是骨架的一部分而不是某个页面的内容：**每个页面都要能点开设置**，
 *   漏传就等于那一页没有设置入口，所以由 server 的 shell() 统一装配。
 */
export function layout({ title, active, body, user = null, banner = '', settings = '' }) {
  const nav = NAV.filter((n) => !n.adminOnly || user?.role === 'admin')
    .map(
      (n) =>
        `<a class="nav-item ${active === n.key ? 'active' : ''}" href="${n.href}">` +
        `<span class="nav-icon">${n.icon}</span><span class="nav-label">${esc(n.label)}</span></a>`,
    )
    .join('');

  /**
   * 右上角：头像 + 用户名 = 一个按钮，点开是设置弹层。
   * 退出从顶栏挪进了弹层里（settingsPanel 末尾），顶栏只留这一个入口。
   *
   * 用 button 而不是 a[href=/settings]：设置已经没有独立页面了，
   * 没有 JS 时按钮不响应——这是这次改动的明确代价，见 settingsPanel 的注释。
   */
  const account = user
    ? `<button type="button" class="account-btn" data-action="toggle-user-menu"
         aria-haspopup="dialog" aria-expanded="false" aria-controls="user-menu">
         <span class="avatar">${esc(String(user.username ?? '').slice(0, 1).toUpperCase())}</span>
         <span class="account-name">${esc(user.username)}</span>
         <span class="account-caret">${ICON.caret}</span>
       </button>`
    : '';

  /**
   * 弹层放在顶栏外面：顶栏有 backdrop-filter，会成为 fixed 子元素的包含块，
   * 放在里面的话窄屏的「底部抽屉」会被顶栏的框子困住。
   */
  const panel = user
    ? `<div class="panel-backdrop" data-action="close-user-menu" hidden></div>
<aside class="user-panel" id="user-menu" role="dialog" aria-label="账号与设置" tabindex="-1" hidden>${settings}</aside>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<script>${THEME_BOOT}</script>
<title>${esc(title)} · WeAuto</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">
</head>
<body>
${banner}
<header class="topbar">
  <span class="brand"><span class="brand-mark">${ICON.brand}</span>WeAuto</span>
  ${account}
</header>
<main class="page">
${body}
</main>
<nav class="tabbar">
${nav}
</nav>
${panel}
<script src="/app.js" defer></script>
</body>
</html>`;
}

/** 未登录/出错时的独立页面（不带导航） */
export function authPage({ mode, error = '', redirect = '/', hasUsers = true }) {
  const isSetup = mode === 'setup';
  const title = isSetup ? '创建管理员' : '登录';
  const hint = isSetup
    ? '这是首次启动。创建第一个管理员账号后即可使用。'
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<script>${THEME_BOOT}</script>
<title>${esc(title)} · WeAuto</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">
</head>
<body class="auth-body">
<form class="card auth-card" method="post" action="${isSetup ? '/setup' : '/login'}">
  <div class="auth-head">
    <span class="brand-mark brand-mark-lg">${ICON.brand}</span>
    <h1>WeAuto</h1>
    <p class="sub">${esc(title)}</p>
  </div>
  ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <input type="hidden" name="redirect" value="${esc(redirect)}">
  <label>用户名<input name="username" autocomplete="username" autocapitalize="off" required></label>
  <label>密码<input type="password" name="password" autocomplete="${
    isSetup ? 'new-password' : 'current-password'
  }" required>${isSetup ? '<span class="hint">至少 8 位</span>' : ''}</label>
  <button type="submit" class="primary">${esc(title)}</button>
</form>
</body>
</html>`;
}

/**
 * 注册页（带邀请码）
 *
 * 页面上必须写明「管理员技术上能解密你的凭据」——
 * 用户填的是自己在别处的真实账号，知情后再决定用不用（需求文档 §6）。
 */
export function registerPage({ code = '', error = '', fatal = '', username = '' } = {}) {
  const body = fatal
    ? `<p class="error">${esc(fatal)}</p>
       <p class="hint">找管理员要一个新的邀请链接。</p>`
    : `<form class="card auth-card" method="post" action="/register">
  <div class="auth-head">
    <span class="brand-mark brand-mark-lg">${ICON.brand}</span>
    <h1>WeAuto</h1>
    <p class="sub">创建账号</p>
  </div>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <input type="hidden" name="code" value="${esc(code)}">
  <label>用户名<input name="username" value="${esc(username)}" autocomplete="username" autocapitalize="off" required></label>
  <label>密码<input type="password" name="password" autocomplete="new-password" required><span class="hint">至少 8 位</span></label>
  <p class="hint"><b>先说清楚一件事</b>：你之后在任务里填的账号密码会加密存在本站，
    但<b>站点管理员在技术上可以解密它</b>（密钥在服务器上，这是自建部署的固有性质，不是缺陷）。
    请不要填写你在别处复用的重要密码。</p>
  <button type="submit" class="primary">创建账号</button>
</form>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<script>${THEME_BOOT}</script>
<title>注册 · WeAuto</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">
</head>
<body class="auth-body">
${body}
</body>
</html>`;
}

function banner(text, tone = 'bad') {
  return text ? `<div class="banner banner-${esc(tone)}">${esc(text)}</div>` : '';
}

/* ─────────────────── 概览 ─────────────────── */

export function pageOverview(data) {
  const b = data.byStatus;
  const attention = data.attention.length
    ? data.attention
        .map(
          (t) => `<a class="row" href="${taskHref(t)}">
            <span class="row-main">${esc(taskTitle(t))}</span>
            <span class="badges">${statusBadge(t.todayStatus)}</span>
            <span class="row-sub">${esc(t.planReason)}</span>
          </a>`,
        )
        .join('')
    : '<p class="empty">今天没有需要处理的</p>';

  const recent = data.recent.length
    ? data.recent
        .map((r) => {
          // r.time 是 "YYYY-MM-DD HH:MM:SS"（北京时间），概览里省掉年份，完整值留在 title 上
          const short = r.time ? r.time.slice(5) : '';
          // 与任务详情「执行历史」同一口径：时间在前、结果在后，两处能逐条对上
          const sub = [short, r.message].filter(Boolean).join(' · ');
          /*
           * 概览是跨账号流水，只写模板名的话多账号下四条记录长得一模一样。
           * 所以多账号时把账号名一起写上——与任务页「任务名 · 账号名」同一个口径。
           * taskLabel 由 status.mjs 补齐；模板已从注册表移除时只有 r.task，退回它。
           */
          const label = r.taskLabel ?? r.task;
          const title = r.multiAccount ? `${label} · ${r.accountLabel || '默认'}` : label;
          return `<div class="row row-plain">
            <span class="row-main">${esc(title)}</span>
            <span class="badges">${runBadge(r.status)}</span>
            <span class="row-sub"${r.time ? ` title="${esc(r.time)}"` : ''}>${esc(sub)}</span>
          </div>`;
        })
        .join('')
    : '<p class="empty">还没有执行记录</p>';

  return `
<section class="grid">
  <div class="stat stat-ok"><b>${b.success}</b><span>今日成功</span></div>
  <div class="stat stat-wait"><b>${b.pending}</b><span>待执行</span></div>
  <div class="stat stat-bad"><b>${b.failed + b.blocked}</b><span>失败/被拦</span></div>
  <div class="stat stat-off"><b>${b.disabled + b.manual}</b><span>停用/手动</span></div>
</section>
<section class="card">
  <h2>需要处理</h2>
  ${attention}
</section>
<section class="card">
  <h2>最近执行</h2>
  ${recent}
</section>
<p class="foot">北京时间 ${esc(data.today)}</p>`;
}

/* ─────────────────── 任务列表 ─────────────────── */

/**
 * 行内小文字按钮。
 *
 * 图标按钮是省地方，但语义只能靠 title/aria-label 补回来——一个电源图标
 * 既像「停用」又像「立即执行」，猜错一次就是误操作。这里宁可多占几个字：
 * 文字自己就说完了，不需要用户 hover 上去读提示。
 *
 * tone 目前只有 danger：停用是这一行里唯一会改变任务是否在运行的操作，
 * 用常驻的红色标出来，不等 hover 才提示。
 */
function textAction({ href = '', action = '', task = '', account = '', enabled = '', label, tone = '' }) {
  const attrs = href
    ? ` href="${esc(href)}"`
    : ` type="button" data-action="${esc(action)}" data-task="${esc(task)}"` +
      (account ? ` data-account="${esc(account)}"` : '') +
      (enabled !== '' ? ` data-enabled="${esc(enabled)}"` : '');
  const cls = `btn-sm${href ? ' btn-link' : ''}${tone ? ' btn-' + esc(tone) : ''}`;
  return `<${href ? 'a' : 'button'} class="${cls}"${attrs}>${esc(label)}</${href ? 'a' : 'button'}>`;
}

/** 任务行的链接（点它 = 看这个任务的详细配置）。多账号时带上 account，否则会落到第一个账号 */
function taskHref(t) {
  return t.accountKey
    ? `/tasks/${esc(t.name)}?account=${esc(t.accountKey)}`
    : `/tasks/${esc(t.name)}`;
}

/**
 * 任务在界面上的名字：多账号时把账号名带上。
 * 概览的「需要处理」与「最近执行」、任务列表、任务页头部四处都要它——
 * 同一个任务的两个账号不写账号名的话，两行长得一模一样，分不清哪条是哪个账号。
 */
function taskTitle(t) {
  return t.accountCount > 1 ? `${t.displayName} · ${t.accountLabel || '默认'}` : t.displayName;
}

/**
 * 已启用实例的一行：**操作就地完成，不用进详情**。
 * 多账号模板每个账号一行，标题带上账号名——否则两行长得一模一样，分不清哪个失败了。
 *
 * 主次是刻意分开的：「立即执行」是最常用的，给实心主按钮；
 * 「停用」会改变任务是否在跑、「配置」是进下一层，两者收成右侧的小文字按钮。
 */
function taskRow(t) {
  const title = taskTitle(t);
  const href = taskHref(t);
  // 没填凭据就直接标出来：取消凭据页之后，这是唯一能一眼看出哪些实例没配好的地方
  const credBadge =
    t.subscribed && t.missingCredentials?.length ? '<span class="badge badge-off">待填凭据</span>' : '';
  return `<div class="row task-row">
        <a class="row-main" href="${href}">${esc(title)}</a>
        <span class="badges">${statusBadge(t.todayStatus)}${credBadge}</span>
        <span class="row-sub">${esc(t.scheduleLabel)}${
          t.todayTargetLabel ? ` · 今日 ${esc(t.todayTargetLabel)}` : ''
        }</span>
        <span class="row-actions">
          <button type="button" class="primary btn-sm" data-action="run" data-task="${esc(
            t.name,
          )}" data-account="${esc(t.accountKey ?? '')}">${ICON.play}立即执行</button>
          <span class="row-actions-minor">
            ${textAction({
              action: 'toggle',
              task: t.name,
              account: t.accountKey ?? '',
              enabled: t.enabled ? '1' : '0',
              label: t.enabled ? '停用' : '启用',
              tone: t.enabled ? 'danger' : '',
            })}
            ${textAction({ href: href, label: '配置' })}
          </span>
        </span>
      </div>`;
}

/**
 * 任务页 = 「我的实例」+「可以启用的模板」两栏。
 *
 * 这里是操作的起点，不是目录：每行自带「立即执行 / 停用 / 配置」，
 * 最常用的事在这层就能做完。点标题或齿轮才进任务页（详情 + 配置）。
 *
 * 模板只能由平台提供（tasks/*.mjs），用户能做的是「启用一个、配自己的时间与凭据」，
 * 所以未启用的那些不显示状态、只给一个「启用」按钮。
 */
export function pageTasks({ items, groups }) {
  const mine = items.filter((t) => t.subscribed);
  const market = items.filter((t) => !t.subscribed);

  const mineHtml = groups
    .map((g) => {
      const list = g.items.filter((t) => t.subscribed);
      if (!list.length) return '';
      return `<section class="card">
  <h2>${esc(g.name)} <span class="count">${list.length}</span></h2>
  ${list.map(taskRow).join('')}
</section>`;
    })
    .join('');

  const marketHtml = market.length
    ? `<section class="card">
  <h2>可以启用的模板 <span class="count">${market.length}</span></h2>
  ${market
    .map(
      (t) => `<div class="row row-plain">
        <span class="row-main">${esc(t.displayName)}</span>
        <span class="row-sub">${esc(t.description || t.scheduleLabel || '')}</span>
        <button data-action="subscribe" data-task="${esc(t.name)}">启用</button>
      </div>`,
    )
    .join('')}
  <p class="hint">模板由平台提供，启用后你可以配自己的时间与账号；不能自己新建模板。</p>
</section>`
    : '';

  if (!mine.length && !market.length) {
    return `<section class="card"><p class="empty">还没有任何模板。模板由平台提供（tasks/ 下的 .mjs 文件）。</p></section>`;
  }
  if (!mine.length) {
    return `<section class="card"><p class="empty">还没启用任何模板。从下面挑一个启用，再点进去填自己的账号和时间。</p></section>${marketHtml}`;
  }
  return mineHtml + marketHtml;
}

/* ─────────────────── 任务页（详情 + 配置合并） ─────────────────── */

/**
 * 配置错误多半是凭据没填、或者用户自己改了密码。
 * 不明说的话，用户只能对着一个 config-error 猜。
 *
 * 链接指向本页的账号区（#accounts）：配置已经并入任务页，
 * 再跳一次 /config 只是多一次重定向。
 */
function credentialHint(task) {
  const broken = task.todayStatus === 'config-error' || task.lastRun?.status === 'config-error';
  if (!broken) return '';
  return `<div class="banner banner-bad">这个任务报了配置错误，通常是账号密码没填，
    或者你在别处改过密码。<a href="#accounts">去填写或更新凭据</a></div>`;
}

/**
 * 任务页 = 详情 + 配置，两层结构里的第二层，也是最后一层。
 *
 * 为什么要合并：原来「列表 → 详情 → 配置」三层里，详情只多了结果和历史，
 * 却让用户为了改一个时间多点一次。现在进来看见的就是全部。
 *
 * 上下两半的分工是刻意的：标题操作之后先给「设置」（调度 / 账号 / 凭据），
 * 再给「跑得怎么样」（最近一次结果 / 历史）。进详情页多半是为了改点什么，
 * 配置排在后面就得先滑过一屏结果。
 */
export function pageTaskDetail({
  task,
  view,
  runs,
  canRun,
  hiddenSkipped = 0,
  includeSkipped = false,
  credential = null,
}) {
  const hintHtml = credentialHint(task);
  const result = view.rows.length
    ? `<dl class="kv">${view.rows
        .map(
          (r) =>
            `<dt>${esc(r.label)}</dt><dd class="${r.missing ? 'missing' : ''}">${esc(r.value)}</dd>`,
        )
        .join('')}</dl>`
    : '<p class="empty">这个任务没有声明结果字段（view），执行结果只在下方历史里</p>';

  const history = runs.length
    ? runs
        .map(
          (r) => `<div class="row row-plain">
            <span class="row-main">${esc(r.time ?? '')}</span>
            <span class="badges">${runBadge(r.status)}</span>
            <span class="row-sub">${esc(r.message)}${
              r.dur ? ` · ${Math.round(r.dur / 1000)}s` : ''
            }${r.trigger === 'manual' ? ' · 手动' : ''}</span>
          </div>`,
        )
        .join('')
    : '<p class="empty">还没有执行记录</p>';

  return `
${hintHtml}
<section class="card">
  <h2>${esc(taskTitle(task))} ${statusBadge(task.todayStatus)}</h2>
  <p class="sub">${esc(task.description ?? task.name)}</p>
  <div class="actions">
    <button class="primary" data-action="run" data-task="${esc(task.name)}" data-account="${esc(
      task.accountKey ?? '',
    )}" ${canRun ? '' : 'disabled'}>${ICON.play}立即执行</button>
    <button data-action="toggle" data-task="${esc(task.name)}" data-enabled="${
      task.enabled ? '1' : '0'
    }">${task.enabled ? '停用此任务' : '启用此任务'}</button>
  </div>
  <p class="hint" id="action-hint"></p>
</section>

${taskConfigBody({ task: task, credential: credential })}

<section class="card">
  <h2>最近一次结果</h2>
  ${task.lastRun ? `<p class="sub">${esc(task.lastRun.message)}</p>` : ''}
  ${result}
</section>

<section class="card">
  <h2>执行历史</h2>
  ${history}
  ${
    hiddenSkipped
      ? `<p class="hint"><a href="?all=1">显示另外 ${hiddenSkipped} 条已跳过的记录</a></p>`
      : includeSkipped
        ? '<p class="hint"><a href="?">隐藏已跳过的记录</a></p>'
        : ''
  }
</section>`;
}

/* ─────────────────── 任务配置 ─────────────────── */

/** epoch 毫秒 → 「YYYY-MM-DDTHH:mm」（北京时间），给 <input type="datetime-local"> 用 */
function beijingInputValue(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 8 * 36e5).toISOString().slice(0, 16);
}

/**
 * 凭据字段的中文名。
 *
 * 模板只给 V2FREE_EMAIL 这种键，界面上不能原样怼给用户看；
 * 但排错时又需要知道键名，所以中文名后面再跟一个小号的原始键。
 * 规则只认常见的词尾，认不出来就退化成「去掉任务名前缀后的首字母大写」——
 * 以后加新任务不用回来改这张表。
 */
const FIELD_LABEL_RULES = [
  [/(^|_)EMAIL$/, '邮箱'],
  [/(_|^)(PASSWORD|PASSWD|PASS)$/, '密码'],
  [/(_|^)(USERNAME|USER)$/, '用户名'],
  [/TOKEN/, '令牌'],
  [/COOKIE/, 'Cookie'],
  [/_?KEY$/, '密钥'],
  [/(PHONE|MOBILE|TEL)/, '手机号'],
  [/_?URL$/, '地址'],
];

function fieldLabel(key) {
  for (const [re, text] of FIELD_LABEL_RULES) {
    if (re.test(key)) return text;
  }
  // 兜底：V2FREE_API_HOST → API HOST → "Api Host"（第一段通常是任务名前缀）
  const parts = String(key).split('_').filter(Boolean);
  const rest = parts.length > 1 ? parts.slice(1) : parts;
  return rest.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

/** 一个凭据字段：中文名 + 原始键名 + 密码可显隐 */
function credentialField(f) {
  return `<label class="field">
    <span class="field-label">${esc(fieldLabel(f.key))}<code class="field-key">${esc(
      f.key,
    )}</code></span>
    <span class="field-control">
      <input type="password" name="${esc(f.key)}" autocomplete="new-password" placeholder="${
        f.set ? '已设置，留空表示不修改' : '未设置'
      }">
      <button type="button" class="reveal" data-action="toggle-reveal" aria-label="显示密码" title="显示密码">
        ${ICON.eye}${ICON.eyeOff.replace('<svg', '<svg hidden')}
      </button>
    </span>
  </label>`;
}

/** 一个账号行：可切换查看、可停用、可删除（默认账号不能删） */
function accountRow(task, acc, currentKey) {
  const isCurrent = acc.accountKey === currentKey;
  return `<div class="account-row${isCurrent ? ' current' : ''}">
    <a class="account-name" href="/tasks/${esc(task.name)}?account=${esc(
      acc.accountKey,
    )}">${esc(acc.label || '默认账号')}</a>
    <span class="badges">
      ${acc.enabled ? '' : '<span class="badge badge-off">已停用</span>'}
      ${acc.missing?.length ? '<span class="badge badge-off">待填凭据</span>' : ''}
    </span>
    <span class="account-actions">
      <button class="link-btn" data-action="toggle-account" data-task="${esc(
        task.name,
      )}" data-account="${esc(acc.accountKey)}" data-enabled="${
        acc.enabled ? '1' : '0'
      }">${acc.enabled ? '停用' : '启用'}</button>
      ${
        acc.accountKey
          ? `<button class="link-danger" data-action="remove-account" data-task="${esc(
              task.name,
            )}" data-account="${esc(acc.accountKey)}">删除</button>`
          : ''
      }
    </span>
  </div>`;
}

/**
 * 配置区：调度 / 我的账号（含凭据）/ 执行参数。
 * 不再是独立页面，而是任务页里的一段——见 pageTaskDetail。
 */
function taskConfigBody({ task, credential = null }) {
  const retention = task.retention ?? {};
  // 有效调度 = 订阅里改过的（若有）否则模板默认。表单要能表达「我改过哪一种」
  const sch = task.schedule ?? null;
  const customized = !!task.hasOverride && !!sch;
  const mode = customized ? sch.kind : 'default';
  const win = sch?.kind === 'window' ? sch.window : { start: '09:00', end: '09:50' };
  const everyMinutes = sch?.kind === 'every' ? sch.every.minutes : 30;
  const onceAt = sch?.kind === 'once' ? beijingInputValue(sch.once.atMs) : '';

  return `
<section class="card">
  <h2>调度</h2>
  <dl class="kv">
    <dt>当前</dt><dd>${esc(task.scheduleLabel)}</dd>
    <dt>来源</dt><dd>${customized ? '我在下面改过' : esc(task.templateScheduleLabel ?? '跟随模板')}</dd>
    <dt>今日</dt><dd>${esc(task.planReason)}</dd>
  </dl>
  ${task.overrideInvalid ? '<p class="error">我保存的调度有问题，当前正按模板默认执行</p>' : ''}
  <form class="schedule-form" data-action="save-schedule" data-task="${esc(task.name)}">
    <fieldset>
      <legend>什么时候跑</legend>
      <label class="radio"><input type="radio" name="kind" value="default"${
        mode === 'default' ? ' checked' : ''
      }>跟随模板默认（${esc(task.templateScheduleLabel ?? '—')}）</label>
      <label class="radio"><input type="radio" name="kind" value="window"${
        mode === 'window' ? ' checked' : ''
      }>每天在一段时间里随机</label>
      <label class="radio"><input type="radio" name="kind" value="every"${
        mode === 'every' ? ' checked' : ''
      }>每隔固定分钟</label>
      <label class="radio"><input type="radio" name="kind" value="once"${
        mode === 'once' ? ' checked' : ''
      }>只在某个时刻执行一次</label>
    </fieldset>
    <div class="schedule-fields" data-for="window"${mode === 'window' ? '' : ' hidden'}>
      <label>开始<input type="time" name="start" value="${esc(win.start)}"></label>
      <label>结束<input type="time" name="end" value="${esc(win.end)}"></label>
      <p class="hint">在这段时间里随机挑一个时刻，每天不同</p>
    </div>
    <div class="schedule-fields" data-for="every"${mode === 'every' ? '' : ' hidden'}>
      <label>间隔（分钟，最少 5）<input type="number" name="minutes" min="5" step="1" value="${esc(
        String(everyMinutes),
      )}"></label>
    </div>
    <div class="schedule-fields" data-for="once"${mode === 'once' ? '' : ' hidden'}>
      <label>时刻（北京时间）<input type="datetime-local" name="at" value="${esc(onceAt)}"></label>
      <p class="hint">超过计划时刻 5 分钟还没跑就判为「已错过」，不会自动补跑</p>
    </div>
    <button type="submit" class="primary">保存调度</button>
  </form>
  <!-- 停用/启用已经在页面顶部，这里不再重复一个；取消订阅只留在这块配置里 -->
  <div class="actions">
    <button data-action="clear-override" data-task="${esc(task.name)}"${
      task.subscribed ? '' : ' disabled'
    }>取消订阅</button>
  </div>
  <p class="hint">这里的设置只影响我自己这个实例，不影响别人，也不会改动模板本身（tasks/${esc(
    task.file ?? '?',
  )}）。</p>
</section>

<section class="card" id="accounts">
  <h2>我的账号${credential && credential.accountCount > 1 ? `（${esc(credential.accountLabel || '默认')}）` : ''}</h2>
  ${
    !credential || !credential.subscribed
      ? `<p class="empty">先启用这个模板，才能填自己的账号。</p>
         <button class="primary" data-action="subscribe" data-task="${esc(task.name)}">启用</button>`
      : `<!-- 账号块始终显示：单账号时也能看到它被停用、也能停用它 -->
         <div class="accounts">
           ${credential.accounts.map((a) => accountRow(task, a, credential.accountKey)).join('')}
         </div>
         ${
           credential.multiAccount
             ? `<form class="inline-form add-account" data-action="add-account" data-task="${esc(task.name)}">
                  <label class="field">
                    <span class="field-label">再加一个账号</span>
                    <input name="label" placeholder="例如：小号" maxlength="32">
                  </label>
                  <button type="submit">添加账号</button>
                </form>`
             : ''
         }
         ${
           task.requires.length
             ? `<form class="inline-form cred-form" data-action="save-credentials"
                    data-task="${esc(task.name)}" data-account="${esc(credential.accountKey)}">
                 ${credential.fields.map(credentialField).join('')}
                 <button type="submit" class="primary">保存</button>
               </form>
               <p class="hint">留空表示不修改。这里填的账号密码<b>加密后存在本站</b>，
                 <b>站点管理员在技术上可以解密</b>，请不要填写你在别处复用的重要密码。</p>`
             : '<p class="hint">这个模板不需要凭据</p>'
         }`
  }
</section>

<section class="card">
  <h2>执行参数</h2>
  <dl class="kv">
    <dt>超时</dt><dd>${Math.round(task.timeoutMs / 1000)} 秒</dd>
    <dt>记录保留</dt><dd>${esc(retention.days ?? '—')} 天 / 最多 ${esc(retention.maxRows ?? '—')} 条</dd>
    <dt>凭据字段</dt><dd>${task.requires.length ? esc(task.requires.join('、')) : '不需要'}</dd>
    <dt>任务标识</dt><dd class="mono">${esc(task.name)}</dd>
  </dl>
</section>`;
}

/* ─────────────────── 管理（admin） ─────────────────── */

/**
 * 账号行，只给账号管理页用。
 *
 * 停用与删除都对自己不渲染：停用自己等于把自己锁在门外，删除自己会让请求
 * 在半途把自己的会话注销掉——服务端各拦一道，这里直接不给按钮，
 * 免得「点了才报错」。
 */
function adminUserRow(u, { currentUserId = null, canDelete = false } = {}) {
  const actions =
    u.id === currentUserId
      ? ''
      : `<span class="invite-actions">
        <button class="link-btn" data-action="toggle-user" data-user="${u.id}" data-status="${esc(
          u.status,
        )}">${u.status === 'active' ? '停用' : '启用'}</button>
        ${
          canDelete
            ? `<button class="link-danger" data-action="delete-user" data-user="${u.id}">删除</button>`
            : ''
        }
      </span>`;
  return `<div class="user-row">
        <span class="row-main">${esc(u.username)}</span>
        <span class="badges">
          <span class="badge badge-${u.role === 'admin' ? 'ok' : 'off'}">${esc(
            u.role === 'admin' ? '管理员' : '普通',
          )}</span>
          <span class="badge badge-${u.status === 'active' ? 'ok' : 'bad'}">${esc(
            u.status === 'active' ? '正常' : '已停用',
          )}</span>
        </span>
        <span class="row-sub">最近登录 ${
          u.lastLoginAt
            ? esc(new Date(u.lastLoginAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
            : '从未'
        }</span>
        ${actions}
      </div>`;
}

/**
 * 一行邀请码。列表由服务端渲染，但「生成后不刷新页面、直接把新行插到最上面」
 * 也需要在前端造出同样结构的 DOM —— 两边各写一遍结构迟早会走样，
 * 所以页面里再带一个由本函数渲染的空壳 <template>，前端克隆它、只填内容。
 */
function inviteRowHtml({ note = '', label = '未使用', url = '', code = '', tone = 'ok', canRevoke = true }) {
  return `<div class="invite-row">
      <span class="row-main mono">${esc(note || '（无备注）')}</span>
      <span class="badges"><span class="badge badge-${tone === 'ok' ? 'ok' : 'off'}">${esc(label)}</span></span>
      <span class="row-sub mono invite-url">${esc(url)}</span>
      <span class="invite-actions">
        <button class="link-btn" data-action="copy-invite" data-url="${esc(url)}">复制链接</button>
        ${
          canRevoke
            ? `<button class="link-danger" data-action="revoke-invite" data-code="${esc(code)}">撤销</button>`
            : ''
        }
      </span>
    </div>`;
}

/** 给前端克隆用的空壳。刚生成的码必然是「未使用 + 可撤销」，徽章不用改 */
function inviteRowTemplate() {
  return `<template id="invite-row-tpl">${inviteRowHtml({})}</template>`;
}

/** 管理首页：跨用户的只读统计 + 各管理功能的入口 */
export function pageAdmin({ users = [], subs = {}, today = {} }) {
  return `
<section class="grid">
  <div class="stat"><b>${users.length}</b><span>账号</span></div>
  <div class="stat"><b>${subs.enabled ?? 0}</b><span>启用中的实例</span></div>
  <div class="stat stat-ok"><b>${today.success ?? 0}</b><span>今日成功</span></div>
  <div class="stat stat-bad"><b>${today.failed ?? 0}</b><span>今日失败</span></div>
</section>

<section class="card">
  <h2>账号</h2>
  <a class="row" href="/admin/users">
    <span class="row-main">管理账号</span>
    <span class="row-sub">停用 / 启用、删除，以及邀请码</span>
  </a>
</section>`;
}

/**
 * 账号管理（admin）：停用 / 启用、删除 + 邀请码。与设置页分开，设置页只放个人偏好。
 *
 * 这里不提供「新建账号」：账号一律由本人凭邀请链接在 /register 自建，
 * 管理员不再代填别人的密码——代填的初始密码要么得另外转告（多一次泄露面），
 * 要么就永远停在那个弱密码上。管理员仍然能改角色、停用、删除。
 */
export function pageAdminUsers({
  users = [],
  canDelete = false,
  /** null = 未启用邀请码（此时整块不渲染） */
  invites = null,
  baseUrl = '',
  currentUserId = null,
}) {
  const list = users
    .map((u) => adminUserRow(u, { currentUserId: currentUserId, canDelete: canDelete }))
    .join('');

  return `
<section class="card">
  <h2>账号</h2>
  ${list}
  <p class="hint">停用只拒绝登录、不再参与调度，订阅与历史都留着，随时可以启用；删除会连同他的订阅、凭据和执行历史一起清掉，不可恢复。</p>
  <p class="hint">新账号由本人凭邀请链接注册，这里不代建。</p>
</section>
${
  invites
    ? `
<section class="card">
  <h2>邀请码</h2>
  <p class="sub">新用户只能凭邀请链接注册。默认单次使用、7 天过期，随时可撤销。</p>
  <form class="inline-form" data-action="create-invite">
    <label>备注（给谁的，备查）<input name="note" maxlength="60" placeholder="例如：给小明"></label>
    <label>有效期（天，0 = 长期）<input type="number" name="expiresInDays" value="7" min="0" step="1"></label>
    <label>可用次数<input type="number" name="maxUses" value="1" min="1" step="1"></label>
    <button type="submit" class="primary">生成邀请链接</button>
  </form>
  <div class="invites" data-invite-list>
    ${
      invites.length
        ? invites
            .map((i) => {
              const url = `${baseUrl}/register?code=${encodeURIComponent(i.code)}`;
              const label = {
                unused: '未使用',
                partial: `已用 ${i.usedCount}/${i.maxUses}`,
                used: '已用完',
                expired: '已过期',
                revoked: '已撤销',
              }[i.state];
              return inviteRowHtml({
                note: i.note,
                label: label,
                url: url,
                code: i.code,
                tone: i.state === 'unused' ? 'ok' : 'off',
                canRevoke: i.state === 'unused' || i.state === 'partial',
              });
            })
            .join('')
        : '<p class="empty">还没有生成过邀请码</p>'
    }
  </div>
  ${inviteRowTemplate()}
</section>`
    : ''
}`;
}

/* ─────────────────── 设置（右上角弹层的内容） ─────────────────── */

/**
 * 右上角弹层的内容：我是谁 + 外观 + 系统信息（折叠）+ 退出。
 *
 * 只放个人偏好与只读信息。这里不再放「管理」入口：管理员导航里已经有
 * 「管理」页（/admin），两处入口重复，且这是个人弹层，不该掺平台级操作。
 *
 * 系统信息默认折叠，而且只留三项：版本、运行时长、任务模板。
 * 它们回答的是同一个问题——「我刚刚那次部署生效了吗」（是不是刚提交的那版、
 * 是不是刚重启过、tasks/ 里的文件有没有被加载）。版本显示的是 commit 时间
 * （北京时间，形如 2026-10-15 20:19）而不是短 sha —— 后者只有对着 Git 才认得出。
 * 折叠是因为换主题是高频动作，
 * 看这些一年也没几次，平铺会让弹层在手机上顶到屏幕顶端。
 *
 * 被删掉的三项各有各的毛病：数据目录与数据库文件名只有 SSH 到机器上才用得上，
 * 放在网页里既没人看，又向普通用户透了服务器路径；「调度器」原本是写死的
 * 「运行中」——scheduler 没有暴露启停状态，那行字在调度真停了的时候会反向误导排查。
 * 与其显示一个假状态，不如不显示。
 *
 * 代价要说清楚：这块内容只在 JS 可用时打不开——按钮没有 href 可去。
 * 主题切换本来也依赖 JS，所以这里不是能力退化，只是多了一层依赖。
 */
export function settingsPanel({ username = '', role = '', system }) {
  const initial = esc(String(username).slice(0, 1).toUpperCase());
  return `
<div class="panel-head">
  <span class="avatar avatar-lg">${initial}</span>
  <span class="panel-who">
    <strong>${esc(username)}</strong>
    <small>${role === 'admin' ? '管理员' : '普通用户'}</small>
  </span>
</div>

<div class="panel-block">
  <h3>外观</h3>
  <div class="segmented" data-theme-picker>
    <button type="button" data-theme-value="system" class="active">跟随系统</button>
    <button type="button" data-theme-value="light">浅色</button>
    <button type="button" data-theme-value="dark">深色</button>
  </div>
  <p class="hint">默认跟随系统深浅色；选择后会记住，下次打开仍然生效。</p>
</div>

<details class="panel-fold">
  <summary>系统信息</summary>
  <dl class="kv">
    <dt>版本</dt><dd class="mono">${esc(system.version)}</dd>
    <dt>运行时长</dt><dd>${esc(system.uptime)}</dd>
    <dt>任务模板</dt><dd>${system.taskCount}</dd>
  </dl>
</details>

<form class="panel-logout" method="post" action="/logout">
  <button type="submit" class="link-btn">退出登录</button>
</form>`;
}
