const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, TOKEN } = require('./helpers');
const { compactSeries } = require('../sanitize');

const SECRETS = ['secret-host', 'ECONNREFUSED', 'secretcause', 'SUGGEST-ADMIN-ONLY', 'BOT-SECRET', 'HOOK-SECRET', 'render', '10.0.0.5', 'deploy'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withEnv(fn, opts) {
  const env = await boot(opts);
  try { await fn(env); } finally { await env.close(); }
}
async function makeLink(env, over = {}) {
  const { cookie } = await env.login();
  const r = await env.call('POST', '/api/admin/links', { cookie, body: { monitorId: 'site1', ...over } });
  assert.equal(r.status, 201, r.raw);
  return { link: r.json, cookie };
}
const tokenOf = (link) => link.token;

test('служебные адреса и заголовки безопасности', () => withEnv(async (env) => {
  assert.equal((await env.call('GET', '/healthz')).raw, 'ok');
  assert.match((await env.call('GET', '/robots.txt')).raw, /Disallow: \//);
  const { link } = await makeLink(env);
  const page = await env.call('GET', '/s/' + tokenOf(link));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.doesNotMatch(page.raw, /<script>(?!<)/); // нет встроенных скриптов
}));

test('админка закрыта паролем', () => withEnv(async (env) => {
  for (const [m, p] of [['GET', '/api/admin/links'], ['GET', '/api/admin/monitors'], ['GET', '/api/admin/me']]) {
    assert.equal((await env.call(m, p)).status, 401, p);
  }
  assert.equal((await env.call('POST', '/api/admin/links', { body: { monitorId: 'site1' } })).status, 401);
  assert.equal((await env.call('POST', '/api/admin/login', { body: { password: 'wrong' } })).status, 401);
  assert.equal((await env.call('POST', '/api/admin/login', { body: {} })).status, 401);
  const { r, cookie } = await env.login();
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.equal((await env.call('GET', '/api/admin/me', { cookie })).status, 200);
  // подделанная кука не проходит
  assert.equal((await env.call('GET', '/api/admin/me', { cookie: 'share_admin=eyJleHAiOjk5OTk5OTk5OTk5OTl9.AAAA' })).status, 401);
  assert.equal((await env.call('GET', '/api/admin/me', { cookie: cookie.slice(0, -2) + 'xx' })).status, 401);
}));

test('защита от подделки запросов и перебора пароля', () => withEnv(async (env) => {
  const { cookie } = await env.login();
  const evil = await env.call('POST', '/api/admin/links', { cookie, headers: { Origin: 'https://evil.example' }, body: { monitorId: 'site1' } });
  assert.equal(evil.status, 403);
  const form = await fetch(env.base + '/api/admin/links', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{"monitorId":"site1"}' });
  assert.equal(form.status, 415);
  let last;
  for (let i = 0; i < 11; i++) last = await env.call('POST', '/api/admin/login', { body: { password: 'bad' + i } });
  assert.equal(last.status, 429);
}));

test('создание ссылки: проверки и значения по умолчанию', () => withEnv(async (env) => {
  const { cookie } = await env.login();
  assert.equal((await env.call('POST', '/api/admin/links', { cookie, body: {} })).status, 400);
  assert.equal((await env.call('POST', '/api/admin/links', { cookie, body: { monitorId: 'nope' } })).status, 404);
  const r = await env.call('POST', '/api/admin/links', { cookie, body: { monitorId: 'site1', label: '  Мой <b>магазин</b>\n' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.token.length, 32);
  assert.match(r.json.url, new RegExp('/s/' + r.json.token + '$'));
  assert.deepEqual([r.json.hideUrl, r.json.hideErrors, r.json.hideRecovery], [true, true, true]);
  assert.equal(r.json.label, 'Мой <b>магазин</b>');
  const r2 = await env.call('POST', '/api/admin/links', { cookie, body: { monitorId: 'site1' } });
  assert.notEqual(r.json.token, r2.json.token);
  const mons = await env.call('GET', '/api/admin/monitors', { cookie });
  assert.deepEqual(mons.json.map((m) => m.id), ['site1', 'site2']);
  assert.ok(!JSON.stringify(mons.json).includes('secret-host'));
}));

test('по умолчанию на публичную страницу не попадает ни один секрет', () => withEnv(async (env) => {
  const { link } = await makeLink(env);
  const r = await env.call('GET', `/api/s/${tokenOf(link)}?range=24h`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'down');
  assert.equal(r.json.title, 'Magic Shop');
  assert.equal(r.json.uptime7d, 99.91);
  assert.ok(r.json.series.length > 0);
  assert.equal(r.json.incidents.length, 1);
  assert.equal(r.json.incidents[0].ongoing, true);
  for (const s of SECRETS) assert.ok(!r.raw.includes(s), 'утечка: ' + s);
  assert.equal(r.json.target, undefined);
  assert.equal(r.json.error, undefined);
  assert.equal(r.json.recovery, undefined);
  assert.equal(r.headers.get('cache-control'), 'no-store');
}));

test('когда админ разрешил, показывается больше, но не секреты Control', () => withEnv(async (env) => {
  const { link } = await makeLink(env, { hideUrl: false, hideErrors: false, hideRecovery: false });
  const r = await env.call('GET', `/api/s/${tokenOf(link)}`);
  assert.equal(r.json.target, 'https://secret-host.example/private');
  assert.equal(r.json.error.label, 'Сервер отказал в соединении');
  assert.match(r.json.error.message, /ECONNREFUSED/);
  assert.equal(r.json.recovery.enabled, true);
  assert.equal(r.json.recovery.log.length, 2);
  assert.equal(r.json.incidents[0].autoRestarted, true);
  // подсказки "что делать админу", токены, deploy hook и провайдер хостинга не публикуются никогда
  for (const s of ['SUGGEST-ADMIN-ONLY', 'BOT-SECRET', 'HOOK-SECRET', 'render', 'deploy hook']) assert.ok(!r.raw.includes(s), 'утечка: ' + s);
}));

test('переключатели можно менять после создания', () => withEnv(async (env) => {
  const { link, cookie } = await makeLink(env);
  const p = await env.call('PATCH', '/api/admin/links/' + link.id, { cookie, body: { hideUrl: false, label: 'Витрина' } });
  assert.equal(p.status, 200);
  const r = await env.call('GET', `/api/s/${tokenOf(link)}`);
  assert.equal(r.json.title, 'Витрина');
  assert.ok(r.json.target);
  assert.equal(r.json.error, undefined);
  assert.equal((await env.call('PATCH', '/api/admin/links/99999', { cookie, body: { hideUrl: true } })).status, 404);
  assert.equal((await env.call('PATCH', '/api/admin/links/abc', { cookie, body: {} })).status, 404);
}));

test('отзыв, восстановление и удаление ссылки', () => withEnv(async (env) => {
  const { link, cookie } = await makeLink(env);
  const t = tokenOf(link);
  assert.equal((await env.call('GET', '/s/' + t)).status, 200);
  assert.equal((await env.call('POST', `/api/admin/links/${link.id}/revoke`, { cookie, body: {} })).status, 200);
  const page = await env.call('GET', '/s/' + t);
  const data = await env.call('GET', '/api/s/' + t);
  assert.equal(page.status, 404);
  assert.equal(data.status, 404);
  assert.doesNotMatch(page.raw, /Magic Shop/);
  assert.equal((await env.call('POST', `/api/admin/links/${link.id}/restore`, { cookie, body: {} })).status, 200);
  assert.equal((await env.call('GET', '/api/s/' + t)).status, 200);
  assert.equal((await env.call('DELETE', '/api/admin/links/' + link.id, { cookie, body: {} })).status, 200);
  assert.equal((await env.call('GET', '/api/s/' + t)).status, 404);
  for (const bad of ['short', 'x'.repeat(100), '../../etc/passwd', '%00', 'a b c d e f g h i j k l m n o p q']) {
    assert.equal((await env.call('GET', '/s/' + encodeURIComponent(bad))).status, 404, bad);
  }
}));

test('счётчик просмотров: боты, повторы и сам админ не считаются', () => withEnv(async (env) => {
  const { link, cookie } = await makeLink(env);
  const t = tokenOf(link);
  const views = async () => { await sleep(80); return (await env.call('GET', '/api/admin/links', { cookie })).json[0]; };
  await env.call('GET', '/s/' + t, { ua: 'TelegramBot (like TwitterBot)' });
  await env.call('GET', '/s/' + t, { ua: 'Googlebot/2.1' });
  await env.call('GET', '/s/' + t, { cookie }); // админ
  assert.equal((await views()).views, 0);
  await env.call('GET', '/s/' + t);
  await env.call('GET', '/s/' + t); // тот же человек, обновил страницу
  assert.equal((await views()).views, 1);
  await env.call('GET', '/s/' + t, { ua: 'Mozilla/5.0 (iPhone) Safari/604.1' });
  const v = await views();
  assert.equal(v.views, 2);
  assert.ok(v.lastViewAt > 0);
  await env.call('GET', '/api/s/' + t); // опрос данных не считается
  assert.equal((await views()).views, 2);
}));

test('Control получает только разрешённые GET-запросы с токеном', () => withEnv(async (env) => {
  const { link, cookie } = await makeLink(env, { hideRecovery: false });
  await env.call('GET', `/api/s/${tokenOf(link)}?range=30d`);
  await env.call('GET', '/api/admin/monitors', { cookie });
  assert.ok(env.stub.state.hits.length >= 5);
  for (const h of env.stub.state.hits) {
    assert.equal(h.method, 'GET');
    assert.equal(h.auth, 'Bearer ' + TOKEN);
    assert.match(h.path, /^\/api\/monitors(\/site1\/(history|incidents|stats|heatmap|restarts))?$/);
    assert.ok(!h.path.includes('/api/config'));
  }
  assert.equal(env.stub.state.badAuth, 0);
  assert.ok(env.stub.state.hits.some((h) => h.path.endsWith('/history') && h.query === '?hours=720'));
}));

test('диапазон: неизвестное значение превращается в 24 часа', () => withEnv(async (env) => {
  const { link } = await makeLink(env);
  const a = await env.call('GET', `/api/s/${tokenOf(link)}?range=bogus`);
  assert.equal(a.json.range, '24h');
  const b = await env.call('GET', `/api/s/${tokenOf(link)}?range=7d`);
  assert.equal(b.json.range, '7d');
  assert.ok(env.stub.state.hits.some((h) => h.query === '?hours=168'));
  assert.ok(!env.stub.state.hits.some((h) => h.query.includes('bogus')));
}));

test('кэш: толпа посетителей не превращается в толпу запросов к Control', () => withEnv(async (env) => {
  const { link } = await makeLink(env);
  const t = tokenOf(link);
  const before = env.stub.state.hits.length;
  const rs = await Promise.all(Array.from({ length: 25 }, () => env.call('GET', '/api/s/' + t)));
  assert.ok(rs.every((r) => r.status === 200));
  await env.call('GET', '/api/s/' + t);
  const mine = env.stub.state.hits.slice(before);
  const count = (re) => mine.filter((h) => re.test(h.path)).length;
  assert.ok(count(/^\/api\/monitors$/) <= 1); // список мог быть закэширован ещё при создании ссылки
  assert.equal(count(/history$/), 1);
  assert.equal(count(/heatmap$/), 1);
}));

test('Control спит: отдаём прошлые данные с пометкой, без кэша - 503', async () => {
  let clock = Date.now();
  await withEnv(async (env) => {
    const { link } = await makeLink(env);
    const t = tokenOf(link);
    assert.equal((await env.call('GET', '/api/s/' + t)).json.stale, false);
    env.stub.state.down = true;
    clock += 10 * 60_000; // кэш протух
    const r = await env.call('GET', '/api/s/' + t);
    assert.equal(r.status, 200);
    assert.equal(r.json.stale, true);
    assert.equal(r.json.title, 'Magic Shop');
    const page = await env.call('GET', '/s/' + t); // сама страница от Control не зависит
    assert.equal(page.status, 200);
    clock += 8 * 3600_000; // слишком старые данные уже не показываем
    assert.equal((await env.call('GET', '/api/s/' + t)).status, 503);
    env.stub.state.down = false;
    assert.equal((await env.call('GET', '/api/s/' + t)).status, 200); // и сервис сам восстанавливается
  }, { clock: () => clock });
  await withEnv(async (env) => {
    const { cookie } = await env.login();
    env.stub.state.down = true;
    const r = await env.call('POST', '/api/admin/links', { cookie, body: { monitorId: 'site1' } });
    assert.equal(r.status, 502);
  });
});

test('монитор удалён в Control: ссылка перестаёт открываться', async () => {
  let clock = Date.now();
  await withEnv(async (env) => {
    const { link } = await makeLink(env);
    assert.equal((await env.call('GET', '/api/s/' + tokenOf(link))).status, 200);
    env.stub.state.monitors = [{ id: 'site2', name: 'Other', status: 'up', maintenance: {} }];
    clock += 60_000; // список в кэше живёт 15 секунд
    assert.equal((await env.call('GET', '/api/s/' + tokenOf(link))).status, 404);
  }, { clock: () => clock });
});

test('название на странице экранируется', () => withEnv(async (env) => {
  const { link } = await makeLink(env, { label: '<script>alert(1)</script>"x' });
  const page = await env.call('GET', '/s/' + tokenOf(link));
  assert.ok(!page.raw.includes('<script>alert(1)'));
  assert.match(page.raw, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;x/);
}));

test('режим обслуживания показывается как плановые работы', async () => {
  let clock = Date.now();
  await withEnv(async (env) => {
    const { link } = await makeLink(env);
    env.stub.state.monitors = [{ id: 'site1', name: 'Magic Shop', status: 'up', maintenance: { enabled: true }, uptime24h: 100, uptime7d: 100 }];
    clock += 60_000;
    assert.equal((await env.call('GET', '/api/s/' + tokenOf(link))).json.status, 'maintenance');
  }, { clock: () => clock });
});

test('длинный ряд укрупняется, падения не теряются', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ ts: i * 60_000, ok: i === 1001 ? 0 : 1, response_ms: 100 }));
  const s = compactSeries(rows);
  assert.ok(s.length <= 500 && s.length > 300);
  assert.ok(s.some((p) => p[2] === 0));
  assert.deepEqual(compactSeries(null), []);
});
