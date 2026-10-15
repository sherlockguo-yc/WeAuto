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

  function hint(msg, tone) {
    var el = document.getElementById('action-hint');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'hint' + (tone ? ' ' + tone : '');
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

  /** 任务跑起来后轮询它是否结束，结束就刷新页面 */
  async function waitForTask(name) {
    for (var i = 0; i < 40; i++) {
      await sleep(2000);
      var d = await api('GET', '/api/tasks/' + encodeURIComponent(name));
      if (!d.running) {
        location.reload();
        return;
      }
      hint('执行中…（' + ((i + 1) * 2) + 's）');
    }
    hint('仍在执行，请稍后手动刷新', 'error');
  }

  document.addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'FORM') return;
    var action = btn.dataset.action;
    if (action === 'create-user') return; // 表单用 submit 事件处理

    var name = btn.dataset.task;
    btn.disabled = true;
    try {
      if (action === 'run') {
        await api('POST', '/api/tasks/' + encodeURIComponent(name) + '/run');
        hint('已开始执行…');
        await waitForTask(name);
      } else if (action === 'toggle') {
        var enabled = btn.dataset.enabled === '1';
        await api('PATCH', '/api/tasks/' + encodeURIComponent(name), { enabled: !enabled });
        location.reload();
      } else if (action === 'clear-override') {
        await api('DELETE', '/api/tasks/' + encodeURIComponent(name) + '/override');
        location.reload();
      } else if (action === 'subscribe') {
        // 启用模板 = 建一个我自己的实例
        await api('POST', '/api/subscriptions', { taskName: name });
        location.reload();
      } else if (action === 'remove-account') {
        if (!window.confirm('删除这个账号？它的凭据会一起删掉，历史记录保留。')) return;
        await api(
          'DELETE',
          '/api/subscriptions/' + encodeURIComponent(name) + '/accounts/' + encodeURIComponent(btn.dataset.account),
        );
        location.reload();
      } else if (action === 'revoke-invite') {
        if (!window.confirm('撤销这个邀请码？已经注册成功的不受影响。')) return;
        await api('DELETE', '/api/invites/' + encodeURIComponent(btn.dataset.code));
        location.reload();
      } else if (action === 'copy-invite') {
        try {
          await navigator.clipboard.writeText(btn.dataset.url);
          hint('邀请链接已复制');
        } catch (err) {
          hint('复制失败，请手动选中链接复制', 'error');
        }
      } else if (action === 'delete-user') {
        if (!window.confirm('删除这个账号？他的订阅、凭据和执行历史会一起清掉，不可恢复。')) return;
        await api('DELETE', '/api/users/' + encodeURIComponent(btn.dataset.user));
        location.reload();
      } else if (action === 'toggle-user') {
        var id = btn.dataset.user;
        var status = btn.dataset.status;
        await api('PATCH', '/api/users/' + id, { status: status === 'active' ? 'disabled' : 'active' });
        location.reload();
      }
    } catch (err) {
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

  document.addEventListener('submit', async function (e) {
    // 凭据表单：留空的字段直接不提交，避免把已有凭据清掉
    var credForm = e.target.closest('[data-action="save-credentials"]');
    if (credForm) {
      e.preventDefault();
      var fd = new FormData(credForm);
      var fields = {};
      fd.forEach(function (v, k) {
        if (typeof v === 'string' && v.length) fields[k] = v;
      });
      if (!Object.keys(fields).length) {
        hint('没有填任何新值', 'error');
        return;
      }
      var credBtn = credForm.querySelector('button[type="submit"]');
      if (credBtn) credBtn.disabled = true;
      try {
        await api('POST', '/api/credentials', {
          taskName: credForm.dataset.task,
          accountKey: credForm.dataset.account || '',
          fields: fields,
        });
        location.reload();
      } catch (err) {
        hint(err.message, 'error');
        if (credBtn) credBtn.disabled = false;
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
        body = { schedule: { once: { at: schedForm.elements.at.value } } };
      }
      if (!body) {
        hint('请选择一种调度方式', 'error');
        return;
      }
      var schedBtn = schedForm.querySelector('button[type="submit"]');
      if (schedBtn) schedBtn.disabled = true;
      try {
        await api('PATCH', '/api/tasks/' + encodeURIComponent(schedForm.dataset.task), body);
        location.reload();
      } catch (err) {
        hint(err.message, 'error');
        if (schedBtn) schedBtn.disabled = false;
      }
      return;
    }

    // 多账号模板：再加一个账号
    var addForm = e.target.closest('[data-action="add-account"]');
    if (addForm) {
      e.preventDefault();
      var label = (addForm.elements.label.value || '').trim();
      if (!label) {
        hint('给这个账号起个名字', 'error');
        return;
      }
      var addBtn = addForm.querySelector('button[type="submit"]');
      if (addBtn) addBtn.disabled = true;
      try {
        await api('POST', '/api/subscriptions/' + encodeURIComponent(addForm.dataset.task) + '/accounts', {
          label: label,
        });
        location.reload();
      } catch (err) {
        hint(err.message, 'error');
        if (addBtn) addBtn.disabled = false;
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
        hint('已生成：' + made.url);
        location.reload();
      } catch (err) {
        hint(err.message, 'error');
        if (invBtn) invBtn.disabled = false;
      }
      return;
    }

    var form = e.target.closest('[data-action="create-user"]');
    if (!form) return;
    e.preventDefault();

    var fd = new FormData(form);
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      await api('POST', '/api/users', {
        username: fd.get('username'),
        password: fd.get('password'),
        role: fd.get('role'),
        status: 'active',
      });
      location.reload();
    } catch (err) {
      hint(err.message, 'error');
      if (btn) btn.disabled = false;
    }
  });
})();
