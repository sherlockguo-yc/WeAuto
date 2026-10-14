/* ============================================================
   WeAuto 前端交互
   页面本身是服务端直出的，这里只处理「点了按钮之后」的事：
   立即执行、启停任务、恢复默认、账号管理。
   ============================================================ */

(function () {
  'use strict';

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
        await api('POST', '/api/credentials', { fields: fields });
        location.reload();
      } catch (err) {
        hint(err.message, 'error');
        if (credBtn) credBtn.disabled = false;
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
