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

export function pageTasks({ items, groups }) {
  if (!items.length) {
    return `<section class="card"><p class="empty">tasks/ 下还没有任务。放一个 .mjs 任务文件即可，不需要改框架。</p></section>`;
  }

  const body = groups
    .map(
      (g) => `<section class="card">
  <h2>${esc(g.name)} <span class="count">${g.items.length}</span></h2>
  ${g.items
    .map(
      (t) => `<a class="row" href="/tasks/${esc(t.name)}">
        <span class="row-main">${esc(t.displayName)}</span>
        ${statusBadge(t.todayStatus)}
        <span class="row-sub">${esc(t.scheduleLabel)}${
          t.todayTargetLabel ? ` · 今日 ${esc(t.todayTargetLabel)}` : ''
        }</span>
      </a>`,
    )
    .join('')}
</section>`,
    )
    .join('');

  return body;
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

export function pageTaskConfig({ task }) {
  const retention = task.retention ?? {};
  return `
<section class="card">
  <h2>调度</h2>
  <dl class="kv">
    <dt>当前</dt><dd>${esc(task.scheduleLabel)}</dd>
    <dt>状态</dt><dd>${task.enabled ? '启用' : '停用'}${
      task.hasOverride ? '（网页设置）' : '（跟随任务文件）'
    }</dd>
    <dt>今日</dt><dd>${esc(task.planReason)}</dd>
  </dl>
  <div class="actions">
    <button data-action="toggle" data-task="${esc(task.name)}" data-enabled="${
      task.enabled ? '1' : '0'
    }">${task.enabled ? '停用此任务' : '启用此任务'}</button>
    <button data-action="clear-override" data-task="${esc(task.name)}" ${
      task.hasOverride ? '' : 'disabled'
    }>恢复为任务文件的默认值</button>
  </div>
  <p class="hint">调度的具体时间写在任务文件里（tasks/${esc(task.file ?? '?')}）。网页上改调度时间将在下一批支持。</p>
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

export function pageCredentials({ groups, secretsError, canEdit = false }) {
  const bannerHtml = secretsError ? banner(`凭据不可用：${secretsError}`, 'bad') : '';

  const body = groups.length
    ? groups
        .map(
          (g) => `<section class="card">
  <h2>${esc(g.name)}</h2>
  ${g.tasks
    .map(
      (t) => `<div class="cred">
        <div class="cred-title">${esc(t.displayName)}</div>
        ${
          t.requires.length
            ? `${
                canEdit && !secretsError
                  ? `<form class="inline-form cred-form" data-action="save-credentials">
                       ${t.requires
                         .map(
                           (f) =>
                             `<label>${esc(f)}<input type="password" name="${esc(
                               f,
                             )}" autocomplete="new-password" placeholder="${
                               t.present[f] ? '已设置，留空表示不修改' : '未设置'
                             }"></label>`,
                         )
                         .join('')}
                       <button type="submit">保存</button>
                     </form>`
                  : ''
              }
                <ul class="fields">${t.requires
                  .map(
                    (f) =>
                      `<li class="${t.present[f] ? 'ok' : 'missing'}">${esc(f)} <span>${
                        t.present[f] ? '已设置' : '缺失'
                      }</span></li>`,
                  )
                  .join('')}</ul>`
            : '<p class="hint">这个任务不需要凭据</p>'
        }
      </div>`,
    )
    .join('')}
</section>`,
        )
        .join('')
    : '<section class="card"><p class="empty">还没有任务</p></section>';

  return `${bannerHtml}
<section class="card">
  <h2>凭据</h2>
  <p class="sub">只显示字段名与是否已设置，<b>凭据值永远不会出现在网页上</b>。</p>
  <p class="hint">${
    canEdit
      ? '留空表示不修改；填新值即覆盖。写入后仍以 age 密文落盘，明文不进数据库。'
      : '只有管理员可以修改凭据。'
  }</p>
</section>
${body}`;
}

/* ─────────────────── 设置 ─────────────────── */

export function pageSettings({ users, canCreateUser, system }) {
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
