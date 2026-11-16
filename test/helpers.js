const http = require('http');
const { newDb } = require('pg-mem');
const { createApp } = require('../app');
const { createStore } = require('../db');
const { ControlClient } = require('../control');

const TOKEN = 'ctl-read-token';
const ADMIN_PW = 'correct-horse-battery';

// Заглушка Control: те же пути и формы ответов, но с "секретами" в полях,
// которые на публичную страницу попадать не должны.
function startStubControl() {
  const state = { down: false, hits: [], badAuth: 0, monitors: null };
  const monitors = () => state.monitors || [
    {
      id: 'site1', name: 'Magic Shop', type: 'http', target: 'https://secret-host.example/private', status: 'down',
      lastResponseMs: 0, lastCheckedAt: Date.now() - 20_000, lastError: 'ECONNREFUSED 10.0.0.5:443 secretcause',
      lastErrorDiagnosis: { category: 'CONNECTION_REFUSED', label: 'Сервер отказал в соединении', explanation: 'Порт закрыт', suggestion: 'SUGGEST-ADMIN-ONLY' },
      hosting: 'render', group: 'prod', uptime24h: 98.5, uptime7d: 99.91, ssl: { valid: true, daysLeft: 41, error: null },
      domain: { domain: 'secret-host.example', valid: true, daysLeft: 200 }, lastStatusCode: 502, intervalSec: 60,
      hasAutoRestart: true, maintenance: { enabled: false, until: null }, recoveryProvider: 'render', flapping: false,
      botToken: 'BOT-SECRET', deployHookUrl: 'https://api.render.example/deploy?key=HOOK-SECRET',
    },
    { id: 'site2', name: 'Other', type: 'http', target: 'https://other.example', status: 'up', lastResponseMs: 120, lastCheckedAt: Date.now() - 5000,
      uptime24h: 100, uptime7d: 100, intervalSec: 60, maintenance: { enabled: false }, ssl: null },
  ];
  const now = Date.now();
  const isDown = (i) => i >= 150 && i < 154;
  const history = Array.from({ length: 288 }, (_, i) => ({
    id: i, monitor_id: 'site1', ts: now - (288 - i) * 300_000, ok: isDown(i) ? 0 : 1,
    response_ms: isDown(i) ? null : Math.round(140 + 60 * Math.sin(i / 14) + (i % 7) * 6 + (i === 90 ? 400 : 0)),
    status_code: isDown(i) ? 502 : 200, error: isDown(i) ? 'ECONNREFUSED 10.0.0.5:443 secretcause' : null,
  }));
  const heat = Array.from({ length: 70 }, (_, k) => ({
    day: new Date(now - (69 - k) * 86400000).toISOString().slice(0, 10), uptime: k === 40 ? 91.5 : k === 55 ? 98.2 : k === 20 ? 99.5 : 100,
  }));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.hits.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer ' + TOKEN) { state.badAuth++; res.writeHead(401); return res.end('{}'); }
    if (state.down) return req.socket.destroy();
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = url.pathname;
    if (p === '/api/monitors') return json(monitors());
    let m;
    if ((m = /^\/api\/monitors\/([^/]+)\/history$/.exec(p))) return json(history);
    if (/\/stats$/.test(p)) return json({ avg: 130, min: 100, max: 160 });
    if (/\/heatmap$/.test(p)) return json(heat);
    if (/\/incidents$/.test(p)) return json([{
      id: 7, start: now - 3600_000, end: null, ongoing: true, durationMs: 3600_000, error: 'ECONNREFUSED 10.0.0.5:443 secretcause', checksFailed: 5,
      diagnosis: { category: 'CONNECTION_REFUSED', label: 'Сервер отказал в соединении', explanation: 'Порт закрыт', suggestion: 'SUGGEST-ADMIN-ONLY' },
      recovery: { attempted: true, provider: 'render', result: 'deploy hook ok' }, notificationSent: true,
    }]);
    if (/\/restarts$/.test(p)) return json([{ id: 1, monitor_id: 'site1', ts: now - 3000_000, success: 1, error: null }, { id: 2, monitor_id: 'site1', ts: now - 2000_000, success: 0, error: 'hook failed secretcause2' }]);
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

async function boot({ clock } = {}) {
  const stub = await startStubControl();
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const store = createStore(pool);
  await store.init();
  const control = new ControlClient({ baseUrl: stub.url, token: TOKEN, timeoutMs: 3000, now: clock || Date.now });
  const app = createApp({
    store, control,
    config: { adminPassword: ADMIN_PW, sessionSecret: null, publicBaseUrl: null, cookieSecure: false, trustProxy: 1 },
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) TestBrowser/1.0';

  const call = async (method, path, { body, cookie, headers, ua } = {}) => {
    const h = { 'User-Agent': ua === undefined ? UA : ua, ...(headers || {}) };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* html */ }
    return { status: res.status, headers: res.headers, raw, json };
  };
  const login = async () => {
    const r = await call('POST', '/api/admin/login', { body: { password: ADMIN_PW } });
    return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const close = async () => { app.locals.limiter.timer && clearInterval(app.locals.limiter.timer); await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); await stub.close(); };
  return { base, call, login, stub, store, close, control, UA };
}

module.exports = { boot, TOKEN, ADMIN_PW };
