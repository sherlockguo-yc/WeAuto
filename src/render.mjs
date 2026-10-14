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

const NAV = [
  { href: '/', label: '概览', key: 'home' },
  { href: '/tasks', label: '任务', key: 'tasks' },
  { href: '/credentials', label: '凭据', key: 'creds' },
  { href: '/settings', label: '设置', key: 'settings' },
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
 * @param {{title: string, active: string, body: string, user?: object|null, banner?: string}} opts
 */
export function layout({ title, active, body, user = null, banner = '' }) {
  const nav = NAV.map(
    (n) =>
      `<a class="nav-item ${active === n.key ? 'active' : ''}" href="${n.href}">${esc(n.label)}</a>`,
  ).join('');

  const logout = user
    ? `<form class="logout" method="post" action="/logout">
         <span class="who">${esc(user.username)}</span>
         <button type="submit" class="link-btn">退出</button>
       </form>`
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
  <span class="brand">WeAuto</span>
  ${logout}
</header>
<main class="page">
${body}
</main>
<nav class="tabbar">
${nav}
</nav>
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
  <h1>WeAuto</h1>
  <p class="sub">${esc(title)}</p>
  ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <input type="hidden" name="redirect" value="${esc(redirect)}">
  <label>用户名<input name="username" autocomplete="username" autocapitalize="off" required></label>
  <label>密码<input type="password" name="password" autocomplete="${
    isSetup ? 'new-password' : 'current-password'
  }" required>${isSetup ? '<span class="hint">至少 8 位</span>' : ''}</label>
  <button type="submit">${esc(title)}</button>
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
  <h1>WeAuto</h1>
  <p class="sub">创建账号</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <input type="hidden" name="code" value="${esc(code)}">
  <label>用户名<input name="username" value="${esc(username)}" autocomplete="username" autocapitalize="off" required></label>
  <label>密码<input type="password" name="password" autocomplete="new-password" required><span class="hint">至少 8 位</span></label>
  <p class="hint"><b>先说清楚一件事</b>：你之后在任务里填的账号密码会加密存在本站，
    但<b>站点管理员在技术上可以解密它</b>（密钥在服务器上，这是自建部署的固有性质，不是缺陷）。
    请不要填写你在别处复用的重要密码。</p>
  <button type="submit">创建账号</button>
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
          (t) => `<a class="row" href="/tasks/${esc(t.name)}">
            <span class="row-main">${esc(t.displayName)}</span>
            ${statusBadge(t.todayStatus)}
            <span class="row-sub">${esc(t.planReason)}</span>
          </a>`,
        )
        .join('')
    : '<p class="empty">今天没有需要处理的</p>';

  const recent = data.recent.length
    ? data.recent
        .map(
          (r) => `<div class="row row-plain">
            <span class="row-main">${esc(r.task)}</span>
            ${runBadge(r.status)}
            <span class="row-sub">${esc(r.message)}</span>
          </div>`,
        )
        .join('')
    : '<p class="empty">还没有执行记录</p>';

  return `
<section class="grid">
  <div class="stat stat-ok"><b>${b.success}</b><span>今日成功</span></div>
  <div class="stat"><b>${b.pending}</b><span>待执行</span></div>
  <div class="stat stat-bad"><b>${b.failed + b.blocked}</b><span>失败/被拦</span></div>
  <div class="stat"><b>${b.disabled + b.manual}</b><span>停用/手动</span></div>
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

/** 已启用实例的一行（可点进详情） */
function taskRow(t) {
  return `<a class="row" href="/tasks/${esc(t.name)}">
        <span class="row-main">${esc(t.displayName)}</span>
        ${statusBadge(t.todayStatus)}
        <span class="row-sub">${esc(t.scheduleLabel)}${
          t.todayTargetLabel ? ` · 今日 ${esc(t.todayTargetLabel)}` : ''
        }</span>
      </a>`;
}

/**
 * 任务页 = 「我的实例」+「可以启用的模板」两栏。
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
    return `<section class="card"><p class="empty">还没启用任何模板。从下面挑一个启用，然后去「凭据」页填自己的账号。</p></section>${marketHtml}`;
  }
  return mineHtml + marketHtml;
}

/* ─────────────────── 任务详情 ─────────────────── */

export function pageTaskDetail({ task, view, runs, canRun, hiddenSkipped = 0, includeSkipped = false }) {
  const result = view.rows.length
    ? `<dl class="kv">${view.rows
        .map(
          (r) =>
            `<dt>${esc(r.label)}</dt><dd class="${r.missing ? 'missing' : ''}">${esc(r.value)}</dd>`,
        )
        .join('')}</dl>`
    : '<p class="empty">这个任务没有声明结果字段（view），执行结果只在下方历史里</p>';

  const remaining = view.remaining.length
    ? `<details class="raw"><summary>原始数据（${view.remaining.length} 项）</summary>
        <dl class="kv">${view.remaining
          .map((r) => `<dt>${esc(r.key)}</dt><dd>${esc(r.value)}</dd>`)
          .join('')}</dl>
      </details>`
    : '';

  const history = runs.length
    ? runs
        .map(
          (r) => `<div class="row row-plain">
            <span class="row-main">${esc(r.time ?? '')}</span>
            ${runBadge(r.status)}
            <span class="row-sub">${esc(r.message)}${
              r.dur ? ` · ${Math.round(r.dur / 1000)}s` : ''
            }${r.trigger === 'manual' ? ' · 手动' : ''}</span>
          </div>`,
        )
        .join('')
    : '<p class="empty">还没有执行记录</p>';

  return `
<section class="card">
  <h2>${esc(task.displayName)} ${statusBadge(task.todayStatus)}</h2>
  <p class="sub">${esc(task.description ?? task.name)}</p>
  <div class="actions">
    <button class="primary" data-action="run" data-task="${esc(task.name)}" ${
      canRun ? '' : 'disabled'
    }>立即执行</button>
    <button data-action="toggle" data-task="${esc(task.name)}" data-enabled="${
      task.enabled ? '1' : '0'
    }">${task.enabled ? '停用' : '启用'}</button>
    <a class="btn-link" href="/tasks/${esc(task.name)}/config">配置</a>
  </div>
  <p class="hint" id="action-hint"></p>
</section>

<section class="card">
  <h2>最近一次结果</h2>
  ${task.lastRun ? `<p class="sub">${esc(task.lastRun.message)}</p>` : ''}
  ${result}
  ${remaining}
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

export function pageTaskConfig({ task }) {
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
    <button type="submit">保存调度</button>
  </form>
  <div class="actions">
    <button data-action="toggle" data-task="${esc(task.name)}" data-enabled="${
      task.enabled ? '1' : '0'
    }">${task.enabled ? '停用此任务' : '启用此任务'}</button>
    <button data-action="clear-override" data-task="${esc(task.name)}"${
      task.subscribed ? '' : ' disabled'
    }>取消订阅</button>
  </div>
  <p class="hint">这里的设置只影响我自己这个实例，不影响别人，也不会改动模板本身（tasks/${esc(
    task.file ?? '?',
  )}）。</p>
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

/* ─────────────────── 凭据 ─────────────────── */

/**
 * 我的凭据：按「模板 × 账号」分组，每个账号一组输入框。
 *
 * 与单租户版的三点不同：
 *   · 只列**我订阅过的**模板（不再是全站一份）
 *   · 支持多账号（模板声明 accounts: true 时可以加号）
 *   · 明确写出「管理员技术上能解密」——不能让人误以为这是端到端加密
 */
export function pageCredentials({ groups = [], secretsError = null }) {
  const bannerHtml = secretsError ? banner(`凭据不可用：${secretsError}`, 'bad') : '';

  const body = groups.length
    ? groups
        .map(
          (g) => `<section class="card">
  <h2>${esc(g.name)}</h2>
  ${g.description ? `<p class="sub">${esc(g.description)}</p>` : ''}
  ${g.accounts
    .map(
      (acc) => `<div class="cred">
        <div class="cred-title">${esc(acc.label)}${acc.accountKey ? '' : '（默认）'}</div>
        ${
          g.requires.length
            ? `<form class="inline-form cred-form" data-action="save-credentials"
                    data-task="${esc(g.taskName)}" data-account="${esc(acc.accountKey)}">
                 ${g.requires
                   .map((key) => {
                     const set = acc.fields.find((f) => f.key === key)?.set;
                     return `<label>${esc(key)}<input type="password" name="${esc(
                       key,
                     )}" autocomplete="new-password" placeholder="${
                       set ? '已设置，留空表示不修改' : '未设置'
                     }"></label>`;
                   })
                   .join('')}
                 <button type="submit">保存</button>
               </form>`
            : '<p class="hint">这个模板不需要凭据</p>'
        }
        ${
          acc.accountKey
            ? `<button class="link-danger" data-action="remove-account" data-task="${esc(
                g.taskName,
              )}" data-account="${esc(acc.accountKey)}">删除这个账号</button>`
            : ''
        }
      </div>`,
    )
    .join('')}
  ${
    g.multiAccount
      ? `<form class="inline-form add-account" data-action="add-account" data-task="${esc(g.taskName)}">
           <label>再加一个账号<input name="label" placeholder="例如：小号" maxlength="32"></label>
           <button type="submit">添加账号</button>
         </form>`
      : ''
  }
</section>`,
        )
        .join('')
    : '<section class="card"><p class="empty">还没有启用任何模板。先去「任务」页启用一个，再来这里填自己的账号。</p></section>';

  return `${bannerHtml}
<section class="card">
  <h2>我的凭据</h2>
  <p class="sub">只显示字段名与是否已设置，<b>凭据值永远不会出现在网页上</b>。</p>
  <p class="hint">留空表示不修改，填新值即覆盖。这里填的账号密码<b>加密后存在本站</b>，
    <b>站点管理员在技术上可以解密</b>。请不要填写你在别处复用的重要密码。</p>
</section>
${body}`;
}

/* ─────────────────── 设置 ─────────────────── */

export function pageSettings({ users, canCreateUser, system, invites = [], baseUrl = '' }) {
  // 账号行单独一套栅格：两个徽章归到右上角，操作按钮独占一行。
  // 用通用 .row 时徽章与按钮会挤在同一格里，手机上看起来是错乱的。
  const list = users
    .map(
      (u) => `<div class="user-row">
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
          u.lastLoginAt ? esc(new Date(u.lastLoginAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) : '从未'
        }</span>
        <button class="link-btn" data-action="toggle-user" data-user="${u.id}" data-status="${esc(
          u.status,
        )}">${u.status === 'active' ? '停用' : '启用'}</button>
      </div>`,
    )
    .join('');

  return `
<section class="card">
  <h2>外观</h2>
  <div class="segmented" data-theme-picker>
    <button type="button" data-theme-value="system" class="active">跟随系统</button>
    <button type="button" data-theme-value="light">浅色</button>
    <button type="button" data-theme-value="dark">深色</button>
  </div>
  <p class="hint">默认跟随系统深浅色；选择后会记住，下次打开仍然生效。</p>
</section>

<section class="card">
  <h2>账号</h2>
  ${list}
</section>

<section class="card">
  <h2>新建账号</h2>
  <form class="inline-form" data-action="create-user">
    <label>用户名<input name="username" autocapitalize="off" required></label>
    <label>密码<input type="password" name="password" autocomplete="new-password" required><span class="hint">至少 8 位</span></label>
    <label>角色<select name="role"><option value="user">普通</option><option value="admin">管理员</option></select></label>
    <button type="submit">创建</button>
  </form>
</section>

${
  canCreateUser
    ? `<section class="card">
  <h2>邀请码</h2>
  <p class="sub">新用户只能凭邀请链接注册。默认单次使用、7 天过期，随时可撤销。</p>
  <form class="inline-form" data-action="create-invite">
    <label>备注（给谁的，备查）<input name="note" maxlength="60" placeholder="例如：给小明"></label>
    <label>有效期（天，0 = 长期）<input type="number" name="expiresInDays" value="7" min="0" step="1"></label>
    <label>可用次数<input type="number" name="maxUses" value="1" min="1" step="1"></label>
    <button type="submit">生成邀请链接</button>
  </form>
  ${
    invites.length
      ? `<div class="invites">
    ${invites
      .map((i) => {
        const url = `${baseUrl}/register?code=${encodeURIComponent(i.code)}`;
        const label = {
          unused: '未使用',
          partial: `已用 ${i.usedCount}/${i.maxUses}`,
          used: '已用完',
          expired: '已过期',
          revoked: '已撤销',
        }[i.state];
        const canRevoke = i.state === 'unused' || i.state === 'partial';
        return `<div class="invite-row">
      <span class="row-main mono">${esc(i.note || '（无备注）')}</span>
      <span class="badges"><span class="badge badge-${i.state === 'unused' ? 'ok' : 'off'}">${esc(label)}</span></span>
      <span class="row-sub mono invite-url">${esc(url)}</span>
      <span class="invite-actions">
        <button class="link-btn" data-action="copy-invite" data-url="${esc(url)}">复制链接</button>
        ${
          canRevoke
            ? `<button class="link-danger" data-action="revoke-invite" data-code="${esc(i.code)}">撤销</button>`
            : ''
        }
      </span>
    </div>`;
      })
      .join('')}
  </div>`
      : '<p class="empty">还没有生成过邀请码</p>'
  }
</section>`
    : ''
}

<section class="card">
  <h2>系统</h2>
  <dl class="kv">
    <dt>版本</dt><dd class="mono">${esc(system.version)}</dd>
    <dt>数据目录</dt><dd class="mono">${esc(system.dataDir)}</dd>
    <dt>数据库</dt><dd class="mono">${esc(system.dbFile)}</dd>
    <dt>运行时长</dt><dd>${esc(system.uptime)}</dd>
    <dt>调度器</dt><dd>${esc(system.scheduler)}</dd>
    <dt>任务数</dt><dd>${system.taskCount}</dd>
  </dl>
</section>`;
}
