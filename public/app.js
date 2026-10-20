/* ============================================================
   WeAuto 前端交互
   页面本身是服务端直出的，这里只处理「点了按钮之后」的事：
   立即执行、启停任务、恢复默认、账号管理。
   ============================================================ */

(function () {
  'use strict';

  /* ── 主题 ──────────────────────────────────────────────
     配色由 CSS 变量 + [data-theme] 决定，这里只负责读写偏好。
     'system' 表示删掉属性，把决定权交回给 prefers-color-scheme。
     ------------------------------------------------------ */
  var THEME_KEY = 'weauto-theme';

  function applyTheme(value) {
    var root = document.documentElement;
    if (value === 'light' || value === 'dark') root.setAttribute('data-theme', value);
    else root.removeAttribute('data-theme');

    try {
      localStorage.setItem(THEME_KEY, value || 'system');
    } catch (e) {
      /* 隐私模式下写不了，忽略：本次会话内仍然生效 */
    }

    var buttons = document.querySelectorAll('[data-theme-picker] button');
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].getAttribute('data-theme-value') === (value || 'system');
      buttons[i].classList.toggle('active', active);
    }
  }

  function currentTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || 'system';
    } catch (e) {
      return 'system';
    }
  }

  applyTheme(currentTheme());

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-theme-value]');
    if (!btn) return;
    applyTheme(btn.getAttribute('data-theme-value'));
  });

  /* ── 右上角账号弹层（设置在这里，不是一个页面） ─────────────
     内容由服务端直出在骨架里，JS 只管三件事：开合、定位、放开焦点。

     定位写成 CSS 变量而不是直接写 top/right：宽屏拿它锚定在按钮下方，
     窄屏的抽屉样式在媒体查询里把 top/right 整个覆盖掉——
     内联样式会赢过样式表，所以只能让样式表自己决定用不用这两个值。
     ------------------------------------------------------ */
  var accountBtn = document.querySelector('[data-action="toggle-user-menu"]');
  var userPanel = document.getElementById('user-menu');
  var panelBackdrop = document.querySelector('[data-action="close-user-menu"]');

  function placePanel() {
    if (!accountBtn || !userPanel) return;
    var r = accountBtn.getBoundingClientRect();
    userPanel.style.setProperty('--panel-top', r.bottom + 8 + 'px');
    userPanel.style.setProperty('--panel-right', Math.max(8, window.innerWidth - r.right) + 'px');
  }

  function setUserMenu(open) {
    if (!accountBtn || !userPanel) return;
    accountBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    userPanel.hidden = !open;
    if (panelBackdrop) panelBackdrop.hidden = !open;
    if (open) {
      placePanel();
      userPanel.focus();
    } else if (userPanel.contains(document.activeElement)) {
      accountBtn.focus();
    }
  }

  document.addEventListener('click', function (e) {
    if (!accountBtn || !userPanel) return;
    if (e.target.closest('[data-action="toggle-user-menu"]')) {
      setUserMenu(userPanel.hidden);
      return;
    }
    if (userPanel.hidden) return;
    // 点在弹层外面（含遮罩）就关；弹层内部的点击（换主题、展开系统信息）不关
    if (!e.target.closest('.user-panel')) setUserMenu(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (userPanel && !userPanel.hidden) setUserMenu(false);
  });

  // 转屏 / 改窗口宽度后锚点会漂，重算而不是关闭：手机上地址栏伸缩也会触发 resize
  window.addEventListener('resize', function () {
    if (userPanel && !userPanel.hidden) placePanel();
  });

  /**
   * 页面级提示。只有任务详情页有 #action-hint（就在按钮旁边，最合适）；
   * 设置页、任务配置页、管理页都没有，以前会静默丢掉消息——
   * 所以找不到容器时退化成浮层 toast，保证任何情况下都看得见结果。
   */
  function hint(msg, tone) {
    var el = document.getElementById('action-hint');
    if (el) {
      el.textContent = msg || '';
      el.className = 'hint' + (tone ? ' ' + tone : '');
      return;
    }
    toast(msg, tone);
  }

  var TOAST_MS = 3000;

  function toast(msg, tone) {
    var el = document.getElementById('action-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'action-toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = msg || '';
    el.classList.toggle('toast-error', tone === 'error');
    el.classList.remove('toast-show');
    void el.offsetWidth; // 强制回流，让连续两次提示都能重新播一次淡入
    el.classList.add('toast-show');

    clearTimeout(el._toastTimer);
    el._toastTimer = setTimeout(function () {
      el.classList.remove('toast-show');
    }, TOAST_MS);
  }

  /* ── 按钮内联反馈 ──────────────────────────────────────
     #action-hint 只在任务详情页存在，设置页（邀请码列表）没有，
     hint() 会静默 return —— 点了按钮看不出成功还是失败。
     所以复制这类就地操作直接在按钮上给反馈：改文字，2 秒后复原。
     ------------------------------------------------------ */
  var FLASH_MS = 2000;

  function flash(btn, msg, tone) {
    var timer = btn._flashTimer;
    if (timer) clearTimeout(timer);
    else btn._flashText = btn.textContent; // 连点时只认第一次记下的原文

    btn.textContent = msg;
    btn.classList.toggle('flash-ok', tone === 'ok');
    btn.classList.toggle('flash-error', tone === 'error');

    btn._flashTimer = setTimeout(function () {
      btn.textContent = btn._flashText;
      btn.classList.remove('flash-ok', 'flash-error');
      btn._flashTimer = null;
    }, FLASH_MS);
  }

  /**
   * 生成邀请后不刷新页面：克隆页面里那个 <template> 造一行插到列表最上面。
   * 行结构只在 render.mjs 里维护一份，这里只填内容。
   * @returns {boolean} 页面上没有列表容器时返回 false（调用方退回刷新）
   */
  function addInviteRow(made) {
    var list = document.querySelector('[data-invite-list]');
    var tpl = document.getElementById('invite-row-tpl');
    if (!list || !tpl || !made || !made.invite) return false;

    var frag = tpl.content.cloneNode(true);
    var row = frag.querySelector('.invite-row');
    row.querySelector('.row-main').textContent = made.invite.note || '（无备注）';
    row.querySelector('.invite-url').textContent = made.url;
    row.querySelector('[data-action="copy-invite"]').dataset.url = made.url;
    row.querySelector('[data-action="revoke-invite"]').dataset.code = made.invite.code;

    var empty = list.querySelector('.empty');
    if (empty) empty.remove();
    list.insertBefore(row, list.firstChild);
    return true;
  }

  /**
   * 复制文本。navigator.clipboard 只在 HTTPS / localhost 下存在，
   * HTTP 自建部署里它是 undefined，直接调用会抛 TypeError，
   * 所以退回到隐藏 textarea + execCommand（iOS 还要补 setSelectionRange）。
   */
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        /* 权限被拒或不是安全上下文：走下面的兜底 */
      }
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function api(method, url, body) {
    var res = await fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* 非 JSON 响应：下面用状态码报错 */
    }
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  /**
   * 任务跑起来后轮询它是否结束，结束就刷新页面。
   * 进度交给 onProgress：详情页写在 #action-hint 上，列表页写在按钮上——
   * 列表页一个任务一个按钮，用浮层提示会连着弹一串行 toast。
   */
  async function waitForTask(id, onProgress) {
    for (var i = 0; i < 40; i++) {
      await sleep(2000);
      var d = await api('GET', '/api/tasks/' + encodeURIComponent(id));
      if (!d.running) {
        location.reload();
        return;
      }
      onProgress('执行中…（' + ((i + 1) * 2) + 's）');
    }
    // 轮询到上限就自动刷一次：让用户自己去猜什么时候刷新没有意义，
    // 刷新后页面仍显示「执行中」，他可以再等或再点。
    hint('仍在执行，即将刷新…');
    await sleep(1500);
    location.reload();
  }

  /**
   * 保存类操作刷新后：给一句「已保存」，并回到原来的滚动位置。
   *
   * 任务页很长（结果 → 调度 → 账号 → 历史），以前点最下面的「保存」会被弹回顶部，
   * 既看不到成功反馈也找不到刚才改的地方。sessionStorage 只在当前标签页有效，
   * 用完立刻清掉，不会串到别的页面。
   */
  function reloadWithFeedback(msg) {
    try {
      sessionStorage.setItem('weauto-flash', msg || '');
      sessionStorage.setItem('weauto-scroll', String(window.scrollY));
    } catch (e) {
      /* 隐私模式写不了：退化成普通刷新，不影响保存本身 */
    }
    location.reload();
  }

  /** 页面加载后把上一条反馈显示出来、并把滚动位置还原 */
  (function restoreAfterReload() {
    var msg;
    var y;
    try {
      msg = sessionStorage.getItem('weauto-flash');
      y = Number(sessionStorage.getItem('weauto-scroll'));
      sessionStorage.removeItem('weauto-flash');
      sessionStorage.removeItem('weauto-scroll');
    } catch (e) {
      return;
    }
    if (msg) setTimeout(function () { toast(msg); }, 0);
    if (!Number.isNaN(y) && y > 0) {
      // 等一帧再滚：Safari 在图片/字体加载完之前会重置滚动位置
      requestAnimationFrame(function () { window.scrollTo(0, y); });
    }
  })();

  /** 把按钮临时改成另一段内容，之后能原样还原（内容是本页渲染出来的，不含外部输入） */
  function setButtonHtml(btn, html) {
    if (btn._idleHtml == null) btn._idleHtml = btn.innerHTML;
    btn.innerHTML = html;
  }

  function restoreButton(btn) {
    if (btn._idleHtml == null) return;
    btn.innerHTML = btn._idleHtml;
    btn._idleHtml = null;
  }

  document.addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'FORM') return;
    var action = btn.dataset.action;

    // 账号弹层的开合不走 API，也不能被下面的 disabled 闪一下
    if (action === 'toggle-user-menu' || action === 'close-user-menu') return;

    // 密码显隐：纯就地操作，不进 API、也不要被下面的 disabled 闪一下
    if (action === 'toggle-reveal') {
      e.preventDefault();
      var field = btn.closest('.field-control') || btn.parentNode;
      var pwd = field && field.querySelector('input');
      if (!pwd) return;
      var show = pwd.type === 'password';
      pwd.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
      var eye = btn.querySelector('.icon-eye');
      var eyeOff = btn.querySelector('.icon-eye-off');
      if (eye) eye.hidden = show;
      if (eyeOff) eyeOff.hidden = !show;
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      return;
    }

    var name = btn.dataset.task;
    btn.disabled = true;
    try {
      if (action === 'run') {
        var hasHint = !!document.getElementById('action-hint');
        var report = function (msg) {
          if (hasHint) hint(msg);
          else setButtonHtml(btn, msg);
        };
        await api('POST', '/api/tasks/' + encodeURIComponent(name) + '/run');
        report('已开始执行…');
        await waitForTask(name, report);
        restoreButton(btn);
      } else if (action === 'toggle') {
        var enabled = btn.dataset.enabled === '1';
        await api('PATCH', '/api/tasks/' + encodeURIComponent(name), { enabled: !enabled });
        reloadWithFeedback(enabled ? '已停止' : '已启动');
      } else if (action === 'create-task') {
        // 点模板 = 用这个模板建一个任务，建完直接进去填凭据
        var created = await api('POST', '/api/tasks', { template: btn.dataset.template });
        location.href = '/tasks/' + created.id;
      } else if (action === 'delete-task') {
        if (!window.confirm('删除这个任务？它的凭据会一起删掉，执行历史保留。')) return;
        await api('DELETE', '/api/tasks/' + encodeURIComponent(name));
        location.href = '/tasks';
      } else if (action === 'revoke-invite') {
        if (!window.confirm('撤销这个邀请码？已经注册成功的不受影响。')) return;
        await api('DELETE', '/api/invites/' + encodeURIComponent(btn.dataset.code));
        location.reload();
      } else if (action === 'copy-invite') {
        var copied = await copyText(btn.dataset.url);
        flash(btn, copied ? '已复制 ✓' : '复制失败，请手动选中', copied ? 'ok' : 'error');
      } else if (action === 'copy-command') {
        // 命令来自任务模板声明（data-cmd），只做复制，不执行
        var cmdCopied = await copyText(btn.dataset.cmd || '');
        flash(btn, cmdCopied ? '已复制 ✓' : '复制失败，请手动选中', cmdCopied ? 'ok' : 'error');
      } else if (action === 'delete-user') {
        if (!window.confirm('删除这个账号？他的任务、凭据和执行历史会一起清掉，不可恢复。')) return;
        await api('DELETE', '/api/users/' + encodeURIComponent(btn.dataset.user));
        location.reload();
      } else if (action === 'toggle-user') {
        var id = btn.dataset.user;
        var status = btn.dataset.status;
        await api('PATCH', '/api/users/' + id, { status: status === 'active' ? 'disabled' : 'active' });
        location.reload();
      }
    } catch (err) {
      restoreButton(btn);
      hint(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  /* 调度表单：切换类型时只显示对应的输入框 */
  document.addEventListener('change', function (e) {
    var radio = e.target.closest('input[name="kind"]');
    if (!radio) return;
    var form = radio.closest('form');
    if (!form) return;
    var blocks = form.querySelectorAll('.schedule-fields');
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].hidden = blocks[i].getAttribute('data-for') !== radio.value;
    }
  });

  /*
   * 一次性任务的「日期 + 时间」合成提交用的 at。
   *
   * 日期不自己在前端算：今天的边界是北京时间，而浏览器时区未必是东八区，
   * 算出来会差一天。所以「今天 / 明天」两个日期由服务端渲染进 data-today / data-tomorrow，
   * 前端只做拼接。
   */
  function syncOnceAt(wrap) {
    var picked = wrap.querySelector('.seg-btn.on');
    var day = picked ? picked.dataset.onceDay : 'today';
    var date =
      day === 'tomorrow'
        ? wrap.dataset.tomorrow
        : day === 'pick'
          ? (wrap.querySelector('input[name="atDate"]').value || wrap.dataset.today)
          : wrap.dataset.today;
    var time = wrap.querySelector('input[name="atTime"]').value || '00:00';
    wrap.querySelector('input[name="at"]').value = date + 'T' + time;
  }

  document.addEventListener('click', function (e) {
    var segBtn = e.target.closest('.seg-btn');
    if (!segBtn) return;
    var wrap = segBtn.closest('.schedule-fields');
    if (!wrap) return;
    var btns = wrap.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i] === segBtn;
      btns[i].classList.toggle('on', on);
      btns[i].setAttribute('aria-pressed', String(on));
    }
    var pick = wrap.querySelector('.once-pick');
    if (pick) pick.hidden = segBtn.dataset.onceDay !== 'pick';
    syncOnceAt(wrap);
  });

  // 时间/日期两个输入框变化时，同样要把 at 补上
  document.addEventListener('change', function (e) {
    var wrap = e.target.closest('.schedule-fields');
    if (!wrap || wrap.getAttribute('data-for') !== 'once') return;
    syncOnceAt(wrap);
  });

  document.addEventListener('submit', async function (e) {
    // 任务名 + 账号密码：一个「保存」按钮，两处都提交，哪处没改就跳过哪处。
    // 凭据字段留空 = 不修改（否则一个空输入框就会把已存的密码清掉）。
    var taskForm = e.target.closest('[data-action="save-task"]');
    if (taskForm) {
      e.preventDefault();
      var taskId = taskForm.dataset.task;
      var newLabel = (taskForm.elements.label.value || '').trim();
      var fields = {};
      new FormData(taskForm).forEach(function (v, k) {
        if (k !== 'label' && typeof v === 'string' && v.length) fields[k] = v;
      });
      var labelChanged = newLabel !== (taskForm.dataset.originalLabel || '');
      var credsFilled = Object.keys(fields).length > 0;
      if (labelChanged && !newLabel) {
        hint('给这个任务起个名字', 'error');
        return;
      }
      if (!labelChanged && !credsFilled) {
        hint('没有需要保存的修改', 'error');
        return;
      }
      var saveBtn = taskForm.querySelector('button[type="submit"]');
      if (saveBtn) saveBtn.disabled = true;
      try {
        if (labelChanged) {
          await api('PATCH', '/api/tasks/' + encodeURIComponent(taskId), { label: newLabel });
        }
        if (credsFilled) {
          await api('POST', '/api/credentials', { taskId: Number(taskId), fields: fields });
        }
        reloadWithFeedback('已保存');
      } catch (err) {
        hint(err.message, 'error');
        if (saveBtn) saveBtn.disabled = false;
      }
      return;
    }

    // 调度表单：按选中的类型提交对应字段；选「跟随默认」时提交 null（= 回到模板）
    var schedForm = e.target.closest('[data-action="save-schedule"]');
    if (schedForm) {
      e.preventDefault();
      var checked = schedForm.querySelector('input[name="kind"]:checked');
      var kind = checked ? checked.value : null;
      var body = null;
      if (kind === 'default') {
        body = { schedule: null };
      } else if (kind === 'window') {
        body = { schedule: { window: { start: schedForm.elements.start.value, end: schedForm.elements.end.value } } };
      } else if (kind === 'every') {
        body = { schedule: { every: { minutes: Number(schedForm.elements.minutes.value) } } };
      } else if (kind === 'once') {
        var at = schedForm.elements.at.value;
        // 「选日期…」模式下日期框空着时，拼出来的 at 不完整，后端会 400
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) {
          hint('先选一个日期', 'error');
          return;
        }
        body = { schedule: { once: { at: at } } };
      }
      if (!body) {
        hint('请选择一种调度方式', 'error');
        return;
      }
      var schedBtn = schedForm.querySelector('button[type="submit"]');
      if (schedBtn) schedBtn.disabled = true;
      try {
        await api('PATCH', '/api/tasks/' + encodeURIComponent(schedForm.dataset.task), body);
        reloadWithFeedback('调度已保存');
      } catch (err) {
        hint(err.message, 'error');
        if (schedBtn) schedBtn.disabled = false;
      }
      return;
    }

    // 生成邀请链接
    var inviteForm = e.target.closest('[data-action="create-invite"]');
    if (inviteForm) {
      e.preventDefault();
      var ifd = new FormData(inviteForm);
      var invBtn = inviteForm.querySelector('button[type="submit"]');
      if (invBtn) invBtn.disabled = true;
      try {
        var made = await api('POST', '/api/invites', {
          note: ifd.get('note') || '',
          expiresInDays: Number(ifd.get('expiresInDays')),
          maxUses: Number(ifd.get('maxUses')),
        });
        if (!addInviteRow(made)) {
          location.reload(); // 页面上没有列表容器就退回原来的刷新
          return;
        }
        inviteForm.reset();
        if (invBtn) {
          invBtn.disabled = false;
          flash(invBtn, '已生成 ✓', 'ok');
        }
      } catch (err) {
        if (invBtn) {
          invBtn.disabled = false;
          flash(invBtn, err.message, 'error');
        }
      }
      return;
    }
  });
})();
