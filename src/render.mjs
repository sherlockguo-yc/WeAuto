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
  /** 任务层叫「已停止」；账号层（users.status）仍然是「已停用」 */
  disabled: { text: '已停止', tone: 'off' },
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
  <a class="brand" href="/"><span class="brand-mark">${ICON.brand}</span>WeAuto</a>
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
    // 文案要说出这张卡的口径：它收的是「今天没跑成」的任务，不是「待办」
    : '<p class="empty">今天没有失败或错过的任务</p>';

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

  /*
   * 四张卡必须能加出任务总数，否则用户对不上数就会怀疑统计坏了。
   * 「已错过」与失败是同一类事实（今天没办成），所以并进 bad 那张，文案也写出来。
   */
  return `
<section class="grid">
  <div class="stat stat-ok"><b>${b.success}</b><span>今日成功</span></div>
  <div class="stat stat-wait"><b>${b.pending}</b><span>待执行</span></div>
  <div class="stat stat-bad"><b>${b.failed + b.blocked + b.missed}</b><span>失败/被拦/错过</span></div>
  <div class="stat stat-off"><b>${b.disabled + b.manual}</b><span>停止/手动</span></div>
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
 * 既像「停止」又像「立即执行」，猜错一次就是误操作。这里宁可多占几个字：
 * 文字自己就说完了，不需要用户 hover 上去读提示。
 *
 * tone 目前只有 danger：停止是这一行里唯一会改变任务是否在运行的操作，
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

/** 任务行的链接：任务的自增 id，不再有「模板名 + 账号」这种拼法 */
function taskHref(t) {
  return `/tasks/${esc(t.id)}`;
}

/**
 * 任务在界面上的名字 = 用户给这个任务起的名字。
 *
 * 一个任务只跑一个账号，所以不再需要「模板名 · 账号名」的拼法：
 * 任务名本身就是区分两个同类任务的那个东西，没起名时退回模板名。
 */
function taskTitle(t) {
  return t.label || t.displayName;
}

/**
 * 顶部模板轨道里的一张卡：**点它 = 看这个模板**，不是建任务。
 *
 * 以前点一下就把任务建出来了，但多数时候用户只是想看看它要填什么、
 * 默认什么时候跑——结果列表里多出一个没配好的空任务。
 * 所以「看」和「建」分开：卡片进 `/templates/:name`，创建按钮在那里面。
 *
 * 已经建了几个用角标标出来——数字比「已建」更能说明还能不能再加一个。
 */
function templateCard(t) {
  return `<a class="template-card" href="/templates/${encodeURIComponent(t.name)}">
    <span class="template-card-head">
      <span class="template-card-name">${esc(t.displayName)}</span>
      ${t.count ? `<span class="template-card-count">已建 ${esc(t.count)}</span>` : ''}
    </span>
    <span class="template-card-desc">${esc(t.description || '没有说明')}</span>
    <span class="template-card-meta">
      <span class="template-card-schedule">${esc(t.scheduleLabel)}</span>
      ${t.requires.length ? `<span class="template-card-cred">要填凭据</span>` : ''}
    </span>
  </a>`;
}

/**
 * 任务列表里的一行：**操作就地完成，不用进详情**。
 *
 * 三个操作的分量是刻意的：「立即执行」最常用，给实心主按钮；
 * 「停止」会改变任务是否在跑，给常驻红色；「配置」是进下一层，收成右侧的文字按钮。
 * 启停是两个按钮而不是一个开关——「启动 / 停止」比一个 toggle 更能说明现在是什么状态。
 */
function taskRow(t) {
  const title = taskTitle(t);
  const href = taskHref(t);
  // 没填凭据就直接标出来：取消凭据页之后，这是唯一能一眼看出哪些任务没配好的地方
  const credBadge = t.missingCredentials?.length ? '<span class="badge badge-off">待填凭据</span>' : '';
  return `<div class="row task-row">
        <a class="row-main" href="${href}">${esc(title)}</a>
        <span class="badges">${statusBadge(t.todayStatus)}${credBadge}</span>
        <span class="row-sub">${esc(t.displayName)} · ${esc(t.scheduleLabel)}${
          t.todayTargetLabel ? ` · 今日 ${esc(t.todayTargetLabel)}` : ''
        }</span>
        <span class="row-actions">
          <button type="button" class="primary btn-sm" data-action="run" data-task="${esc(
            t.id,
          )}">${ICON.play}立即执行</button>
          <span class="row-actions-minor">
            ${textAction({
              action: 'toggle',
              task: t.id,
              enabled: t.enabled ? '1' : '0',
              label: t.enabled ? '停止' : '启动',
              tone: t.enabled ? 'danger' : '',
            })}
            ${textAction({ href: href, label: '配置' })}
          </span>
        </span>
      </div>`;
}

/**
 * 任务页 = 顶部「模板」横向轨道 + 下方「我的任务」。
 *
 * 上下两段的职责是分开的：模板回答「可以建什么」（平台提供，建了才进下面的列表），
 * 任务回答「我建了什么在跑」（一人一份，一个任务只跑一个账号）。
 * 以前两者混在一张列表里，未启用的模板也占一行「已停止」，新用户进来看到的是一堆
 * 自己没启动过的东西。
 */
export function pageTasks({ items, groups, templates = [] }) {
  const rail = templates.length
    ? `<section class="card templates">
  <h2>模板 <span class="count">${templates.length}</span></h2>
  <div class="template-rail">${templates.map(templateCard).join('')}</div>
  <p class="hint">左右滑动看更多。点一个模板进去看看它是什么、要填什么，
    确定要用再点「创建任务」——一个任务只跑一个账号，想跑第二个账号就再建一个。</p>
</section>`
    : '';

  const mineHtml = groups
    .map((g) => {
      if (!g.items.length) return '';
      return `<section class="card">
  <h2>${esc(g.name)} <span class="count">${g.items.length}</span></h2>
  ${g.items.map(taskRow).join('')}
</section>`;
    })
    .join('');

  if (!items.length) {
    return (
      rail +
      `<section class="card"><p class="empty">还没有创建任务。从上面的模板里点一个，就能建一个任务。</p></section>`
    );
  }
  return rail + mineHtml;
}

/* ─────────────────── 模板页（看清楚再决定建不建） ─────────────────── */

/**
 * 模板页 = 「这个模板是什么」+「我已经用它建了什么」。
 *
 * 建任务的按钮放在这里，而不是列表的模板卡上：点卡片只是想看一眼，
 * 直接建出来会在列表里留下没配好的空任务。
 * 顺手把已建的同类任务列出来——同一个账号重复建一个是最常见的误操作。
 */
export function pageTemplate({ template, mine = [] }) {
  const credFields = template.requires.length
    ? template.requires
        .map((k) => `${esc(fieldLabel(k))}<code class="field-key">${esc(k)}</code>`)
        .join('、')
    : '不需要账号密码';

  return `
<section class="card">
  <h2>${esc(template.displayName)}${
    template.group ? ` <span class="count">${esc(template.group)}</span>` : ''
  }</h2>
  <p class="sub">${esc(template.description || '这个模板没有说明')}</p>
  <dl class="kv">
    <dt>默认调度</dt><dd>${esc(template.scheduleLabel)}</dd>
    <dt>需要填写</dt><dd>${credFields}</dd>
    <dt>执行超时</dt><dd>${Math.round((template.timeoutMs ?? 0) / 1000)} 秒</dd>
    <dt>模板</dt><dd class="mono">${esc(template.name)}</dd>
  </dl>
  <div class="actions">
    <button type="button" class="primary" data-action="create-task" data-template="${esc(
      template.name,
    )}">创建任务</button>
    <a class="btn-link btn-sm" href="/tasks">返回任务列表</a>
  </div>
  <p class="hint">建完会直接进任务页填账号密码。一个任务只跑一个账号。</p>
</section>

<section class="card">
  <h2>我用这个模板建的任务 <span class="count">${mine.length}</span></h2>
  ${
    mine.length
      ? mine.map(taskRow).join('')
      : '<p class="empty">还没建过。点上面的「创建任务」，建完进去填账号密码。</p>'
  }
</section>`;
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
    或者你在别处改过密码。<a href="#credentials">去填写或更新凭据</a></div>`;
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
  /** 由 UA 判断：Windows 给可直接双击的 .cmd，其它平台给 .mjs + 一行命令 */
  isWindows = false,
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
    <button type="button" class="primary" data-action="run" data-task="${esc(task.id)}" ${
      canRun ? '' : 'disabled title="有一个执行还没结束，等它跑完"'
    }">${ICON.play}立即执行</button>
    <!-- 「停止」的红色与列表页同一语气色：两处都是「让任务不再跑」。
         删除是更重的操作，反而收成弱化的文字按钮，别抢「停止」的注意力 -->
    <button type="button" data-action="toggle" data-task="${esc(task.id)}" data-enabled="${
      task.enabled ? '1' : '0'
    }"${task.enabled ? ' class="btn-danger"' : ''}>${task.enabled ? '停止' : '启动'}</button>
    <button type="button" class="link-danger" data-action="delete-task" data-task="${esc(
      task.id,
    )}">删除任务</button>
  </div>
  <!-- 执行进度与报错都写在这里，给 aria-live 让读屏也能听到（浮层 toast 本来就有） -->
  <p class="hint" id="action-hint" role="status" aria-live="polite"></p>
</section>

${taskConfigBody({ task: task, credential: credential, isWindows: isWindows })}

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

/** epoch 毫秒 → 「YYYY-MM-DDTHH:mm」（北京时间） */
function beijingInputValue(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 8 * 36e5).toISOString().slice(0, 16);
}

/** epoch 毫秒 → 北京时间「YYYY-MM-DD」 */
function beijingDate(ms) {
  return new Date(ms + 8 * 36e5).toISOString().slice(0, 10);
}

/**
 * 一次性任务的「日期 + 时间」两个输入框各要一个什么值。
 *
 * 为什么要拆开、还要给默认值：`datetime-local` 空着的时候显示成
 * 「年/月/日 --:--」，看着像坏了，填的时候又得先翻日历再拖时间。
 * 而一次性任务绝大多数就是「今天或明天的某个点」——所以日期默认今天、
 * 时间默认下一个整点，想选更远的日期再点「选日期…」。
 */
function onceParts(atMs, nowMs = Date.now()) {
  if (Number.isFinite(atMs)) {
    const v = beijingInputValue(atMs);
    return { date: v.slice(0, 10), time: v.slice(11) };
  }
  // 北京时间下的「下一个整点」：先偏移到北京，再进 1 小时、抹掉分秒
  const next = new Date(nowMs + 8 * 36e5 + 36e5);
  next.setUTCMinutes(0, 0, 0);
  return { date: beijingDate(nowMs), time: next.toISOString().slice(11, 16) };
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

/**
 * 「怎么拿到这个凭据」的内嵌引导。
 *
 * 有些凭据没法"去注册一个 key"——只能在自己机器上从客户端里抓。这种时候光给一个
 * 空输入框，等于把最难的一步甩给用户，再去文档里找。所以引导直接长在输入框上方：
 * 用户卡住的那一刻，答案就在眼前。
 *
 * 内容全部来自模板声明的 credentialHelper，这里不认识任何一个具体任务名。
 * 将来再有同类任务，只改任务文件，界面不动。
 */
function credentialHelperBlock(task, isWindows = false) {
  const h = task.credentialHelper;
  if (!h) return '';

  const items = [];
  if (h.download) {
    /*
     * 两个平台给不同的东西，因为能力本身不同（2026-10-20 实测）：
     *   · Windows 的 .cmd 由文件关联执行，不需要权限位 —— 下载后双击即可；
     *   · macOS 的 .command 必须有执行位，而浏览器下载不保留权限，双击没反应。
     *     所以 macOS 仍然给 .mjs + 一行 node 命令（不引入 Gatekeeper 的坑）。
     */
    if (isWindows) {
      items.push(
        `<li>下载启动器
          <a class="btn-inline" data-watch-pair="${esc(task.id)}"
            href="/api/tasks/${esc(task.id)}/grabber.cmd" download>下载 update-workbuddy-token.cmd</a>
        </li>`,
      );
      items.push('<li><b>双击运行它</b>（首次可能弹一次系统确认，点「运行」）</li>');
    } else {
      items.push(
        `<li>下载脚本（里面已经带上你这个任务的配对信息）
          <a class="btn-inline" data-watch-pair="${esc(task.id)}"
            href="/api/tasks/${esc(task.id)}/grabber.mjs" download>下载 ${esc(h.download)}</a>
        </li>`,
      );
      items.push(
        `<li>在终端运行 <code>node ${esc(h.download)}</code>
          <button type="button" class="btn-inline" data-action="copy-command"
            data-cmd="node ${esc(h.download)}">复制命令</button>
        </li>`,
      );
    }
  } else if (h.command) {
    // 没有可下载脚本的模板：只能给一条命令，值由用户自己粘回下面的输入框
    items.push(
      `<li>在终端运行 <code>${esc(h.command)}</code>
        <button type="button" class="btn-inline" data-action="copy-command"
          data-cmd="${esc(h.command)}">复制命令</button>
      </li>`,
    );
  }
  for (const step of h.steps) items.push(`<li>${esc(step)}</li>`);

  return `<div class="cred-helper">
    <h3>怎么拿到 ${esc(task.requires[0] ?? '凭据')}</h3>
    <ol>${items.join('')}</ol>
    ${h.note ? `<p class="hint">${esc(h.note)}</p>` : ''}
  </div>`;
}

/**
 * 配置区：调度 / 任务名与凭据。
 * 不再是独立页面，而是任务页里的一段——见 pageTaskDetail。
 *
 * 只放用户能改的东西：超时、保留策略、模板名这类改不了的元数据不在这里占
 * 一张卡片——它们要么已经出现在别处（凭据字段就在下面的表单里，模板名在
 * 列表和模板页），要么只在执行失败时才有意义（超时阈值该跟着失败原因走）。
 *
 * 没有「账号列表」了：一个任务只跑一个账号，想跑第二个账号就回任务页
 * 再建一个任务。账号这个概念因此退到执行侧（凭据与历史按它分），界面不再暴露。
 */
function taskConfigBody({ task, credential = null, isWindows = false }) {
  // 有效调度 = 订阅里改过的（若有）否则模板默认。表单要能表达「我改过哪一种」
  const sch = task.schedule ?? null;
  const customized = !!task.scheduleCustomized && !!sch;
  const mode = customized ? sch.kind : 'default';
  const win = sch?.kind === 'window' ? sch.window : { start: '09:00', end: '09:50' };
  const everyMinutes = sch?.kind === 'every' ? sch.every.minutes : 30;
  const once = onceParts(sch?.kind === 'once' ? sch.once.atMs : NaN);
  const today = beijingDate(Date.now());
  const tomorrow = beijingDate(Date.now() + 86_400_000);
  // 已存的时刻落在今天/明天就点亮对应按钮，否则停在「选日期…」
  const onceDay = once.date === today ? 'today' : once.date === tomorrow ? 'tomorrow' : 'pick';

  return `
<section class="card">
  <h2>调度</h2>
  <dl class="kv">
    <!-- 「当前」和「来源」曾经是两行，但没改过调度时两行必然一字不差
         （生效的就是模板默认）。来源要回答的是「这个值归谁定」，
         所以它只是一个跟在值后面的标记，不再单独占一行 -->
    <dt>当前</dt><dd>${esc(task.scheduleLabel)}<span class="note"> · ${
      customized ? '我在下面改过' : '模板默认'
    }</span></dd>
    <!-- 「今日」执行状态（已完成/未到时刻…）不放在这里：调度是配置，
         跑没跑是结果——它属于概览「需要处理」和执行历史，混进来会让配置卡片每次都变 -->
  </dl>
  ${task.overrideInvalid ? '<p class="error">我保存的调度有问题，当前正按模板默认执行</p>' : ''}
  <form class="schedule-form" data-action="save-schedule" data-task="${esc(task.id)}">
    <fieldset>
      <legend>什么时候跑</legend>
      <!-- 模板默认值只在「我改过」时才写出来：没改过时上面「当前」那行就是同一个值，
           再说一遍是重复；改过之后它是用户决定要不要恢复默认的依据，必须留着 -->
      <label class="radio"><input type="radio" name="kind" value="default"${
        mode === 'default' ? ' checked' : ''
      }>跟随模板默认${
        customized ? `（${esc(task.templateScheduleLabel ?? '—')}）` : ''
      }</label>
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
    <div class="schedule-fields" data-for="once"${mode === 'once' ? '' : ' hidden'}
         data-today="${esc(today)}" data-tomorrow="${esc(tomorrow)}">
      <!-- 不能用 <label> 包这组按钮：label 会把自己绑到第一个可标记后代（「今天」），
           点「日期」两个字就等于点了它；按钮组也不该是 label 的关联控件 -->
      <div class="seg-row" role="group" aria-label="日期">
        <span class="field-label">日期</span>
        <span class="seg">
          <button type="button" class="seg-btn${onceDay === 'today' ? ' on' : ''}" aria-pressed="${
            onceDay === 'today'
          }" data-once-day="today">今天</button>
          <button type="button" class="seg-btn${onceDay === 'tomorrow' ? ' on' : ''}" aria-pressed="${
            onceDay === 'tomorrow'
          }" data-once-day="tomorrow">明天</button>
          <button type="button" class="seg-btn${onceDay === 'pick' ? ' on' : ''}" aria-pressed="${
            onceDay === 'pick'
          }" data-once-day="pick">选日期…</button>
        </span>
      </div>
      <label>时间（北京时间）<input type="time" name="atTime" value="${esc(once.time)}"></label>
      <label class="once-pick"${onceDay === 'pick' ? '' : ' hidden'}>具体日期<input
        type="date" name="atDate" value="${esc(once.date)}"></label>
      <input type="hidden" name="at" value="${esc(once.date)}T${esc(once.time)}">
      <p class="hint">超过计划时刻 5 分钟还没跑就判为「已错过」，不会自动补跑</p>
    </div>
    <button type="submit" class="primary">保存调度</button>
  </form>
  <!-- 模板文件名（tasks/xxx.mjs）不再写出来：它是仓库里的实现细节，
       用户只需要知道「改的是我这个任务」——文件名对他没有任何可操作的含义 -->
  <p class="hint">这里的设置只影响我自己这个任务，不影响别人，也不会改动模板本身。</p>
</section>

<section class="card" id="credentials">
  <h2>任务名与账号</h2>
  <!-- 名字和账号密码共用一个「保存」：它们都是「我这个任务长什么样」，
       分成两个按钮只会让人点了名字再去找第二个按钮（2026-10-16）。 -->
  <form class="inline-form task-form" data-action="save-task" data-task="${esc(
    task.id,
  )}" data-original-label="${esc(task.label || '')}">
    <label class="field">
      <span class="field-label">任务名</span>
      <input name="label" value="${esc(task.label || '')}" maxlength="32" placeholder="${esc(
        task.displayName,
      )}">
    </label>
    ${credentialHelperBlock(task, isWindows)}
    ${(credential?.fields ?? []).map(credentialField).join('')}
    <button type="submit" class="primary">保存</button>
  </form>
  ${
    task.requires.length
      ? `<p class="hint">一个任务只跑这一个账号——想跑第二个账号，
           回任务页用同一个模板再建一个任务。这里填的账号密码<b>加密后存在本站</b>，
           <b>站点管理员在技术上可以解密</b>，请不要填写你在别处复用的重要密码。</p>`
      : '<p class="hint">这个模板不需要账号密码。</p>'
  }
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
        <button type="button" class="link-btn" data-action="toggle-user" data-user="${u.id}" data-status="${esc(
          u.status,
        )}">${u.status === 'active' ? '停用' : '启用'}</button>
        ${
          canDelete
            ? `<button type="button" class="link-danger" data-action="delete-user" data-user="${u.id}">删除</button>`
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
        <button type="button" class="link-btn" data-action="copy-invite" data-url="${esc(url)}">复制链接</button>
        ${
          canRevoke
            ? `<button type="button" class="link-danger" data-action="revoke-invite" data-code="${esc(code)}">撤销</button>`
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
  <div class="stat"><b>${subs.enabled ?? 0}</b><span>启动中的任务</span></div>
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
  <p class="hint">停用只拒绝登录、不再参与调度，任务与历史都留着，随时可以启用；删除会连同他的任务、凭据和执行历史一起清掉，不可恢复。</p>
  <p class="hint">新账号由本人凭邀请链接注册，这里不代建。</p>
</section>
${
  invites
    ? `
<section class="card">
  <h2>邀请码</h2>
  <p class="sub">新用户只能凭邀请链接注册。默认单次使用、7 天过期，随时可撤销。</p>
  <form class="inline-form invite-form" data-action="create-invite">
    <label class="invite-note">备注（给谁的，备查）<input name="note" maxlength="60" placeholder="例如：给小明"></label>
    <label class="invite-num">有效期（天，0 = 长期）<input type="number" name="expiresInDays" value="7" min="0" step="1"></label>
    <label class="invite-num">可用次数<input type="number" name="maxUses" value="1" min="1" step="1"></label>
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
