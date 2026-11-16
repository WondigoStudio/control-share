(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const token = location.pathname.split('/').pop();
  const REFRESH_MS = 30_000;
  const STATUS = {
    up: ['Работает', 'up'], down: ['Недоступен', 'down'], maintenance: ['Плановые работы', 'maintenance'], unknown: ['Нет данных', ''],
  };
  let range = '24h';
  let data = null;
  let inflight = false;
  let slowTimer = null;

  // ---------- форматирование (всё в часовом поясе зрителя)
  const fmtMs = (v) => (v === null || v === undefined ? '-' : v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' с' : Math.round(v) + ' мс');
  const fmtPct = (v) => (v === null || v === undefined ? '-' : (v >= 99.995 || v <= 0 ? Math.round(v) : v.toFixed(v >= 99 ? 2 : 1)) + '%');
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (t) => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`; };
  const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDT = (t) => `${fmtDate(t)} ${fmtTime(t)}`;
  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' с';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' мин';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' ч' + (m % 60 ? ' ' + (m % 60) + ' мин' : '');
    const d = Math.floor(h / 24);
    return d + ' д' + (h % 24 ? ' ' + (h % 24) + ' ч' : '');
  }
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 5 ? 'только что' : fmtDur(s * 1000) + ' назад'; };

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    for (const k of kids) if (k !== null && k !== undefined) n.append(k);
    return n;
  }
  function svg(tag, attrs, ...kids) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    for (const k of kids) if (k !== null && k !== undefined) n.append(k);
    return n;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

  // ---------- шапка и карточки
  function renderTop(d) {
    const [label, cls] = STATUS[d.status] || STATUS.unknown;
    $('title').textContent = d.title;
    document.title = `${d.title} - ${label.toLowerCase()}`;
    $('dot').className = 'dot ' + cls;
    const b = $('badge');
    b.textContent = label;
    b.className = 'badge ' + cls;
    $('u24').textContent = fmtPct(d.uptime24h);
    $('u7').textContent = fmtPct(d.uptime7d);
    $('rt').textContent = d.status === 'down' ? '-' : fmtMs(d.responseMs);
    if (d.ssl) {
      $('extraK').textContent = 'Сертификат HTTPS';
      $('extra').textContent = d.ssl.valid ? d.ssl.daysLeft + ' дн.' : 'проблема';
    } else {
      $('extraK').textContent = 'Проверка каждые';
      $('extra').textContent = d.intervalSec ? fmtDur(d.intervalSec * 1000) : '-';
    }
    tickSub();
  }

  function tickSub() {
    if (!data) return;
    const parts = [];
    if (data.checkedAt) parts.push('Проверено ' + ago(data.checkedAt));
    if (data.target) parts.push(data.target);
    $('sub').textContent = parts.join(' · ') || 'Проверок пока не было';
  }

  function banner(text, bad) {
    const b = $('banner');
    if (!text) { b.hidden = true; return; }
    b.hidden = false;
    b.className = 'banner' + (bad ? ' bad' : '');
    b.textContent = text;
  }

  function renderBanner(d) {
    if (d.stale) return banner('Сервер мониторинга сейчас не отвечает. Показаны последние известные данные (' + ago(d.updatedAt) + ').');
    if (d.status === 'maintenance') return banner('Идут плановые работы, возможны кратковременные перебои.');
    if (d.status === 'down' && d.error) {
      const t = [d.error.label, d.error.explanation].filter(Boolean).join(': ');
      return banner(t || 'Сервис сейчас недоступен.', true);
    }
    if (d.status === 'down') return banner('Сервис сейчас недоступен. Мы уже знаем об этом.', true);
    return banner('');
  }

  // ---------- график времени ответа
  const H = 230, L = 50, R = 10, T = 10, B = 24;
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
    for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
    return 10 * p;
  }

  function renderChart(d) {
    const box = $('chart');
    clear(box);
    const W = Math.round(Math.min(760, Math.max(330, box.clientWidth || 760))); // на телефоне рисуем в натуральную величину, чтобы подписи читались
    const hours = { '24h': 24, '7d': 168, '30d': 720 }[d.range] || 24;
    const t1 = Date.now(), t0 = t1 - hours * 3600_000;
    const pts = d.series.filter((p) => p[0] >= t0 && p[0] <= t1 + 60_000);
    const vals = pts.filter((p) => p[2] && p[1] !== null).map((p) => p[1]);
    const stats = $('chartStats');
    clear(stats);
    if (!pts.length) {
      box.append(el('div', { class: 'empty dim' }, 'За этот период данных пока нет'));
      return;
    }
    const yMax = niceMax(Math.max(100, ...(vals.length ? vals : [100])) * 1.1);
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - v / yMax) * (H - T - B);

    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'График времени ответа' });
    for (const f of [0, 0.5, 1]) {
      const yy = y(yMax * f);
      s.append(svg('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: f === 0 ? 'axis' : 'grid' }));
      const t = svg('text', { x: L - 6, y: yy + 3, 'text-anchor': 'end', class: 'lbl' });
      t.textContent = fmtMs(yMax * f);
      s.append(t);
    }
    for (let i = 0; i <= 4; i++) {
      const tt = t0 + ((t1 - t0) * i) / 4;
      const t = svg('text', { x: Math.min(W - R - 14, Math.max(L + 14, x(tt))), y: H - 7, 'text-anchor': 'middle', class: 'lbl' });
      t.textContent = hours <= 24 ? fmtTime(tt) : fmtDate(tt);
      s.append(t);
    }
    const diffs = [];
    for (let i = 1; i < pts.length; i++) diffs.push(pts[i][0] - pts[i - 1][0]);
    diffs.sort((a, b) => a - b);
    const step = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 60_000;
    const barW = Math.max(2, (step / (t1 - t0)) * (W - L - R));
    for (const p of pts) if (!p[2]) s.append(svg('rect', { x: x(p[0]) - barW / 2, y: T, width: barW, height: H - T - B, class: 'bar-down' }));

    let path = '';
    let prev = null;
    for (const p of pts) {
      if (!p[2] || p[1] === null) { prev = null; continue; }
      const gap = prev !== null && p[0] - prev > step * 3;
      path += (prev === null || gap ? 'M' : 'L') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1) + ' ';
      prev = p[0];
    }
    if (path) s.append(svg('path', { d: path, class: 'line' }));

    const cross = svg('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
    s.append(cross);
    const hit = svg('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
    const tip = $('tip');
    const move = (ev) => {
      const r = s.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const tt = t0 + ((px - L) / (W - L - R)) * (t1 - t0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p[0] - tt) < Math.abs(best[0] - tt)) best = p;
      cross.setAttribute('x1', x(best[0])); cross.setAttribute('x2', x(best[0])); cross.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.textContent = `${fmtDT(best[0])}  ${best[2] ? fmtMs(best[1]) : 'недоступен'}`;
      tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, ev.clientX + 12) + 'px';
      tip.style.top = Math.max(8, ev.clientY - 34) + 'px';
    };
    const leave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', leave);
    hit.addEventListener('pointerdown', move);
    s.append(hit);
    box.append(s);

    const st = d.stats || {};
    for (const [k, v] of [['Среднее', st.avg], ['Минимум', st.min], ['Максимум', st.max]]) stats.append(el('span', {}, `${k}: ${fmtMs(v)}`));
  }

  // ---------- карта доступности за 90 дней
  function renderHeat(d) {
    const box = $('heat');
    clear(box);
    const byDay = new Map(d.heatmap.map((x) => [x.day, x.uptime]));
    const cell = 8, gap = 2, n = 90;
    const s = svg('svg', { viewBox: `0 0 ${n * (cell + gap) - gap} 30`, role: 'img', 'aria-label': 'Доступность по дням' });
    const today = new Date();
    for (let i = 0; i < n; i++) {
      const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (n - 1 - i)));
      const key = dt.toISOString().slice(0, 10);
      const up = byDay.get(key);
      const cls = up === undefined || up === null ? 'c-none' : up >= 99.9 ? 'c-up' : up >= 99 ? 'c-ok' : up >= 95 ? 'c-warn' : 'c-down';
      const r = svg('rect', { x: i * (cell + gap), y: 0, width: cell, height: 30, rx: 2, class: cls });
      const t = svg('title', {});
      t.textContent = `${key.slice(8, 10)}.${key.slice(5, 7)}: ` + (up === undefined || up === null ? 'нет данных' : fmtPct(up));
      r.append(t);
      s.append(r);
    }
    box.append(s);
  }

  // ---------- сбои
  function renderIncidents(d) {
    const box = $('incidents');
    clear(box);
    if (!d.incidents.length) { box.append(el('div', { class: 'empty' }, 'За последние 30 дней сбоев не было')); return; }
    for (const i of d.incidents) {
      const when = i.ongoing ? `${fmtDT(i.start)} - идёт сейчас` : `${fmtDT(i.start)} - ${fmtDT(i.end)}`;
      const bits = [];
      if (i.label) bits.push(i.label);
      if (i.explanation) bits.push(i.explanation);
      if (i.message) bits.push(i.message);
      if (i.autoRestarted) bits.push('выполнен автоперезапуск');
      box.append(el('div', { class: 'inc' },
        el('span', { class: 'inc__mark' + (i.ongoing ? '' : ' ok') }),
        el('div', {},
          el('div', { class: 'inc__t' }, i.ongoing ? 'Недоступен' : `Недоступен ${fmtDur(i.durationMs)}`),
          el('div', { class: 'inc__s' }, when),
          bits.length ? el('div', { class: 'inc__s' }, bits.join(' · ')) : null)));
    }
  }

  function renderRecovery(d) {
    const panel = $('recPanel');
    if (!d.recovery) { panel.hidden = true; return; }
    panel.hidden = false;
    const box = $('rec');
    clear(box);
    box.append(el('div', { class: 'inc__s' }, d.recovery.enabled ? 'Автоперезапуск включён: при падении сервис пытаются поднять автоматически.' : 'Автоперезапуск не настроен.'));
    for (const r of d.recovery.log) {
      box.append(el('div', { class: 'inc' },
        el('span', { class: 'inc__mark' + (r.success ? ' ok' : '') }),
        el('div', {}, el('div', { class: 'inc__t' }, r.success ? 'Перезапуск выполнен' : 'Перезапуск не удался'),
          el('div', { class: 'inc__s' }, fmtDT(r.ts) + (r.message ? ' · ' + r.message : '')))));
    }
  }

  function render(d) {
    data = d;
    $('gone').hidden = true;
    $('content').hidden = false;
    renderTop(d);
    renderBanner(d);
    renderChart(d);
    renderHeat(d);
    renderIncidents(d);
    renderRecovery(d);
  }

  function gone() {
    $('content').hidden = true;
    $('gone').hidden = false;
    $('dot').className = 'dot';
    $('badge').textContent = '';
    $('badge').className = 'badge';
    $('title').textContent = 'Ссылка недействительна';
    $('sub').textContent = '';
    banner('');
  }

  async function load() {
    if (inflight) return;
    inflight = true;
    clearTimeout(slowTimer);
    // Бесплатный Render засыпает: если ответа долго нет, объясняем, что происходит
    slowTimer = setTimeout(() => { if (!data) banner('Сервер просыпается, это может занять до минуты. Страница обновится сама.'); }, 6000);
    try {
      const res = await fetch(`/api/s/${encodeURIComponent(token)}?range=${range}`, { cache: 'no-store' });
      if (res.status === 404) return gone();
      if (res.status === 429) { if (!data) banner('Слишком много запросов, страница попробует ещё раз чуть позже.'); return; }
      if (!res.ok) throw new Error(String(res.status));
      render(await res.json());
    } catch {
      if (data) banner('Не удалось обновить данные. Показаны последние полученные (' + ago(data.updatedAt || Date.now()) + ').');
      else { banner('Не удалось загрузить данные. Пробуем ещё раз...', true); setTimeout(load, 6000); }
    } finally {
      clearTimeout(slowTimer);
      inflight = false;
    }
  }

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-r]');
    if (!b || b.dataset.r === range) return;
    range = b.dataset.r;
    for (const x of $('tabs').children) x.classList.toggle('on', x === b);
    load();
  });

  let lastW = 0, rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { const w = $('chart').clientWidth; if (data && Math.abs(w - lastW) > 20) { lastW = w; renderChart(data); } }, 150);
  });
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  setInterval(tickSub, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  load();
})();
