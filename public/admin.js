(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    for (const k of kids) if (k !== null && k !== undefined) n.append(k);
    return n;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDT = (t) => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  async function api(method, path, body) {
    const res = await fetch('/api/admin' + path, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), cache: 'no-store',
    });
    let j = {};
    try { j = await res.json(); } catch { /* пустой ответ */ }
    if (!res.ok) { const e = new Error(j.error || 'Ошибка ' + res.status); e.status = res.status; throw e; }
    return j;
  }
  // GET без тела
  async function get(path) {
    const res = await fetch('/api/admin' + path, { cache: 'no-store' });
    let j = {};
    try { j = await res.json(); } catch { /* пустой ответ */ }
    if (!res.ok) { const e = new Error(j.error || 'Ошибка ' + res.status); e.status = res.status; throw e; }
    return j;
  }

  let toastTimer;
  function toast(t) {
    const n = $('toast');
    n.textContent = t;
    n.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { n.hidden = true; }, 2200);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = el('textarea', {});
      t.value = text;
      document.body.append(t);
      t.select();
      try { document.execCommand('copy'); } catch { /* ничего */ }
      t.remove();
    }
    toast('Ссылка скопирована');
  }

  function showLogin(msg) {
    $('main').hidden = true;
    $('logout').hidden = true;
    $('loginBox').hidden = false;
    $('loginErr').textContent = msg || '';
    $('pw').focus();
  }

  async function start() {
    try { await get('/me'); } catch { return showLogin(); }
    $('loginBox').hidden = true;
    $('main').hidden = false;
    $('logout').hidden = false;
    await Promise.all([loadMonitors(), loadLinks()]);
  }

  async function loadMonitors() {
    const sel = $('monSel');
    try {
      const list = await get('/monitors');
      sel.textContent = '';
      for (const m of list) sel.append(el('option', { value: m.id }, `${m.name}${m.group ? ' (' + m.group + ')' : ''}`));
      if (!list.length) sel.append(el('option', { value: '' }, 'Мониторов нет'));
    } catch (e) {
      sel.textContent = '';
      sel.append(el('option', { value: '' }, 'Не удалось получить список: ' + e.message));
    }
  }

  const OPTS = [['hideUrl', 'скрыть адрес'], ['hideErrors', 'скрыть ошибки'], ['hideRecovery', 'скрыть автоперезапуск']];

  async function loadLinks() {
    const box = $('links');
    let links;
    try { links = await get('/links'); } catch (e) { if (e.status === 401) return showLogin('Сессия закончилась'); box.textContent = e.message; return; }
    box.textContent = '';
    if (!links.length) { box.append(el('div', { class: 'dim' }, 'Ссылок пока нет. Создайте первую выше.')); return; }
    for (const l of links) box.append(row(l));
  }

  function row(l) {
    const revoked = !!l.revokedAt;
    const act = async (fn, okText, reload = true) => {
      try { await fn(); if (okText) toast(okText); if (reload) await loadLinks(); } catch (e) { toast(e.message); await loadLinks(); }
    };
    const opts = el('div', { class: 'lk__opts' });
    for (const [key, text] of OPTS) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!l[key];
      cb.addEventListener('change', () => act(() => api('PATCH', '/links/' + l.id, { [key]: cb.checked }), 'Сохранено', false));
      opts.append(el('label', {}, cb, text));
    }
    const btn = (text, cls, fn) => {
      const b = el('button', { type: 'button', class: 'btn btn--sm ' + (cls || '') }, text);
      b.addEventListener('click', fn);
      return b;
    };
    const buttons = el('div', { class: 'lk__row' });
    if (!revoked) {
      buttons.append(btn('Копировать ссылку', 'btn--pri', () => copy(l.url)));
      const open = el('a', { class: 'btn btn--sm', href: l.url, target: '_blank', rel: 'noopener' }, 'Открыть');
      buttons.append(open);
      buttons.append(btn('Отозвать', 'btn--danger', () => { if (confirm('Отозвать ссылку? Она перестанет открываться.')) act(() => api('POST', `/links/${l.id}/revoke`), 'Ссылка отозвана'); }));
    } else {
      buttons.append(btn('Восстановить', '', () => act(() => api('POST', `/links/${l.id}/restore`), 'Ссылка снова работает')));
    }
    buttons.append(btn('Удалить', 'btn--danger', () => { if (confirm('Удалить ссылку навсегда вместе со счётчиком?')) act(() => api('DELETE', '/links/' + l.id), 'Удалено'); }));

    const label = el('input', { type: 'text', maxlength: '80', placeholder: 'название на странице' });
    label.value = l.label;
    label.addEventListener('change', () => act(() => api('PATCH', '/links/' + l.id, { label: label.value }), 'Сохранено', false));

    return el('div', { class: 'lk' },
      el('div', { class: 'lk__top' },
        el('span', { class: 'lk__name' }, l.monitorName || l.monitorId),
        el('span', { class: 'pill ' + (revoked ? 'off' : 'on') }, revoked ? 'отозвана' : 'активна'),
        el('span', { class: 'pill' }, `просмотров: ${l.views}`),
        el('span', { class: 'pill' }, l.lastViewAt ? 'последний: ' + fmtDT(l.lastViewAt) : 'ещё не открывали'),
        el('span', { class: 'pill' }, 'создана ' + fmtDT(l.createdAt))),
      el('div', { class: 'lk__url' }, l.url),
      label, opts, buttons);
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/login', { password: $('pw').value }); $('pw').value = ''; await start(); } catch (err) { $('loginErr').textContent = err.message; }
  });
  $('logout').addEventListener('click', async () => { try { await api('POST', '/logout'); } catch { /* всё равно выходим */ } showLogin(); });
  $('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('createErr').textContent = '';
    try {
      const l = await api('POST', '/links', {
        monitorId: $('monSel').value, label: $('label').value,
        hideUrl: $('hUrl').checked, hideErrors: $('hErr').checked, hideRecovery: $('hRec').checked,
      });
      $('label').value = '';
      await loadLinks();
      await copy(l.url);
    } catch (err) { $('createErr').textContent = err.message; }
  });

  start();
})();
