const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { RateLimiter } = require('./limits');
const { buildPublicData, RANGES } = require('./sanitize');

const COOKIE = 'share_admin';
const SESSION_MS = 30 * 24 * 3600_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
// Предпросмотры ссылок в мессенджерах и поисковые роботы не считаем просмотрами.
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slack|skype|vkshare|embedly|curl|wget|python-requests|monitor|uptime/i;
const VIEW_DEDUPE_MS = 30 * 60_000;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanLabel = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* битая кука */ }
    }
  }
  return out;
}

function createApp({ store, control, config, now = Date.now }) {
  const app = express();
  const limiter = new RateLimiter();
  const recentViews = new Map();
  const secret = config.sessionSecret || crypto.createHash('sha256').update('share-session:' + config.adminPassword).digest('hex');

  const viewTpl = fs.readFileSync(path.join(__dirname, 'views', 'view.html'), 'utf8');
  const adminHtml = path.join(__dirname, 'views', 'admin.html');
  const notFoundHtml = fs.readFileSync(path.join(__dirname, 'views', 'notfound.html'), 'utf8');

  // ---- подпись сессии админа (без хранения на сервере: переживает засыпание Render)
  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const makeSession = () => {
    const p = Buffer.from(JSON.stringify({ exp: now() + SESSION_MS })).toString('base64url');
    return p + '.' + sign(p);
  };
  const isAdmin = (req) => {
    const v = parseCookies(req)[COOKIE];
    if (!v) return false;
    const [p, sig] = v.split('.');
    if (!p || !sig) return false;
    const want = Buffer.from(sign(p));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
    try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > now(); } catch { return false; }
  };
  const safeEqual = (a, b) => {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));
  app.get('/', (req, res) => res.redirect('/admin'));
  app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '5m', index: false }));

  const sendNotFound = (res, status = 404) =>
    res.status(status).set('Cache-Control', 'no-store').type('html').send(notFoundHtml);

  const activeLink = async (token) => {
    if (!TOKEN_RE.test(String(token))) return null;
    const link = await store.getByToken(token);
    return link && !link.revokedAt ? link : null;
  };

  // ---------------------------------------------------------------- публичная часть
  app.get('/s/:token', async (req, res, next) => {
    try {
      if (!limiter.take('page:' + req.ip, 90, 60_000)) return res.status(429).type('text').send('Слишком много запросов, попробуйте через минуту');
      const link = await activeLink(req.params.token);
      if (!link) return sendNotFound(res);

      const ua = String(req.headers['user-agent'] || '');
      if (ua && !BOT_RE.test(ua) && !isAdmin(req)) {
        const key = crypto.createHash('sha1').update(link.id + '|' + req.ip + '|' + ua).digest('hex');
        const t = now();
        if (!recentViews.has(key) || t - recentViews.get(key) > VIEW_DEDUPE_MS) {
          recentViews.set(key, t);
          if (recentViews.size > 5000) for (const [k, v] of recentViews) if (t - v > VIEW_DEDUPE_MS) recentViews.delete(k);
          store.addView(link.id, t).catch((e) => console.error('[views]', e.message));
        }
      }
      const title = link.label || link.monitorName || 'Статус сервиса';
      res.set('Cache-Control', 'no-store').type('html').send(viewTpl.replace(/\{\{TITLE\}\}/g, esc(title)));
    } catch (e) { next(e); }
  });

  async function loadPublic(link, range) {
    const hours = RANGES[range];
    const id = encodeURIComponent(link.monitorId);
    const histTtl = hours <= 24 ? 30_000 : 300_000;
    const jobs = {
      list: control.get('/api/monitors', 15_000),
      history: control.get(`/api/monitors/${id}/history?hours=${hours}`, histTtl),
      stats: control.get(`/api/monitors/${id}/stats?hours=${hours}`, 60_000),
      heatmap: control.get(`/api/monitors/${id}/heatmap?days=90`, 600_000),
      incidents: control.get(`/api/monitors/${id}/incidents?days=30`, 60_000),
    };
    if (!link.hideRecovery) jobs.restarts = control.get(`/api/monitors/${id}/restarts`, 60_000);

    const keys = Object.keys(jobs);
    const settled = await Promise.allSettled(keys.map((k) => jobs[k]));
    const res = Object.fromEntries(keys.map((k, i) => [k, settled[i]]));
    if (res.list.status !== 'fulfilled') {
      const err = new Error('Источник данных временно недоступен');
      err.status = 503;
      throw err;
    }
    const monitor = (res.list.value.data || []).find((m) => m.id === link.monitorId);
    if (!monitor) return null;

    const ok = keys.filter((k) => res[k].status === 'fulfilled').map((k) => res[k].value);
    const get = (k) => (res[k] && res[k].status === 'fulfilled' ? res[k].value.data : undefined);
    return buildPublicData(link, {
      monitor, history: get('history'), stats: get('stats'), heatmap: get('heatmap'), incidents: get('incidents'), restarts: get('restarts'),
    }, range, {
      updatedAt: Math.min(...ok.map((v) => v.at)),
      stale: ok.some((v) => v.stale),
      partial: ok.length < keys.length,
    });
  }

  app.get('/api/s/:token', async (req, res, next) => {
    try {
      if (!limiter.take('data:' + req.ip, 120, 60_000)) return res.status(429).json({ error: 'Слишком много запросов, попробуйте через минуту' });
      const link = await activeLink(req.params.token);
      if (!link) return res.status(404).set('Cache-Control', 'no-store').json({ error: 'Ссылка недействительна или отозвана' });
      const range = Object.hasOwn(RANGES, req.query.range) ? req.query.range : '24h';
      const data = await loadPublic(link, range);
      if (!data) return res.status(404).set('Cache-Control', 'no-store').json({ error: 'Ссылка недействительна или отозвана' });
      res.set('Cache-Control', 'no-store').json(data);
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------------- админка
  app.get('/admin', (req, res) => res.set('Cache-Control', 'no-store').sendFile(adminHtml));

  const adminApi = express.Router();

  // Защита от подделки запросов с чужих сайтов: кука SameSite=Strict плюс проверка Origin.
  adminApi.use((req, res, next) => {
    if (req.method !== 'GET') {
      const o = req.headers.origin;
      if (o) {
        let host = '';
        try { host = new URL(o).host; } catch { /* пустой */ }
        if (host !== req.headers.host) return res.status(403).json({ error: 'Запрос с чужого сайта отклонён' });
      }
      if (!req.is('application/json')) return res.status(415).json({ error: 'Ожидается JSON' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  adminApi.post('/login', (req, res) => {
    if (!limiter.take('login:' + req.ip, 10, 15 * 60_000)) return res.status(429).json({ error: 'Слишком много попыток, подождите 15 минут' });
    const pw = req.body && req.body.password;
    if (typeof pw !== 'string' || !safeEqual(pw, config.adminPassword)) return res.status(401).json({ error: 'Неверный пароль' });
    const flags = ['HttpOnly', 'Path=/', 'SameSite=Strict', `Max-Age=${SESSION_MS / 1000}`];
    if (config.cookieSecure) flags.push('Secure');
    res.set('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeSession())}; ${flags.join('; ')}`).json({ ok: true });
  });

  adminApi.post('/logout', (req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`).json({ ok: true });
  });

  adminApi.use((req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Нужен вход' })));

  adminApi.get('/me', (req, res) => res.json({ ok: true }));

  const baseUrl = (req) => (config.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const view = (req, l) => ({ ...l, url: `${baseUrl(req)}/s/${l.token}` });

  adminApi.get('/monitors', async (req, res, next) => {
    try {
      const { data } = await control.get('/api/monitors', 15_000);
      res.json(data.map((m) => ({ id: m.id, name: m.name, status: m.status, group: m.group || null })));
    } catch (e) { e.status = 502; next(e); }
  });

  adminApi.get('/links', async (req, res, next) => {
    try { res.json((await store.list()).map((l) => view(req, l))); } catch (e) { next(e); }
  });

  adminApi.post('/links', async (req, res, next) => {
    try {
      const b = req.body || {};
      if (typeof b.monitorId !== 'string' || !b.monitorId) return res.status(400).json({ error: 'Не выбран монитор' });
      let monitors;
      try { monitors = (await control.get('/api/monitors', 15_000)).data; } catch { return res.status(502).json({ error: 'Control недоступен, попробуйте позже' }); }
      const m = monitors.find((x) => x.id === b.monitorId);
      if (!m) return res.status(404).json({ error: 'Такого монитора нет в Control' });
      const link = await store.create({
        token: store.newToken(),
        monitorId: m.id,
        monitorName: m.name,
        label: cleanLabel(b.label),
        // по умолчанию скрыто всё: показываем больше только если админ явно разрешил
        hideUrl: b.hideUrl !== false,
        hideErrors: b.hideErrors !== false,
        hideRecovery: b.hideRecovery !== false,
      }, now());
      res.status(201).json(view(req, link));
    } catch (e) { next(e); }
  });

  const idParam = (req) => (/^\d{1,9}$/.test(req.params.id) ? parseInt(req.params.id, 10) : null);
  const withLink = (fn) => async (req, res, next) => {
    try {
      const id = idParam(req);
      const link = id === null ? null : await store.getById(id);
      if (!link) return res.status(404).json({ error: 'Ссылка не найдена' });
      await fn(req, res, link);
    } catch (e) { next(e); }
  };

  adminApi.patch('/links/:id', withLink(async (req, res, link) => {
    const b = req.body || {};
    const p = {};
    if (b.label !== undefined) p.label = cleanLabel(b.label);
    for (const k of ['hideUrl', 'hideErrors', 'hideRecovery']) if (typeof b[k] === 'boolean') p[k] = b[k];
    res.json(view(req, await store.update(link.id, p)));
  }));
  adminApi.post('/links/:id/revoke', withLink(async (req, res, link) => res.json(view(req, await store.revoke(link.id, now())))));
  adminApi.post('/links/:id/restore', withLink(async (req, res, link) => res.json(view(req, await store.restore(link.id)))));
  adminApi.delete('/links/:id', withLink(async (req, res, link) => { await store.remove(link.id); res.json({ ok: true }); }));

  app.use('/api/admin', adminApi);

  // ---------------------------------------------------------------- ошибки
  app.use((req, res) => (req.path.startsWith('/api/') ? res.status(404).json({ error: 'not found' }) : sendNotFound(res)));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', req.method, req.path, err.message);
    res.status(status).json({ error: status === 500 ? 'Внутренняя ошибка' : err.message });
  });

  app.locals.limiter = limiter;
  return app;
}

module.exports = { createApp };
