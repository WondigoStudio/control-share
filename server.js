const { Pool, types } = require('pg');
const { createApp } = require('./app');
const { createStore } = require('./db');
const { ControlClient } = require('./control');

// BIGINT (время в мс) pg по умолчанию отдаёт строкой; нам нужны числа.
types.setTypeParser(20, (v) => parseInt(v, 10));

// Файл .env читаем вручную (без лишней зависимости), на Render переменные задаются в панели.
try {
  const fs = require('fs');
  for (const line of fs.readFileSync(require('path').join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env нет - это нормально */ }

function need(name, hint) {
  const v = process.env[name];
  if (!v) {
    console.error(`Не задана переменная окружения ${name}${hint ? ': ' + hint : ''}. См. README.`);
    process.exit(1);
  }
  return v;
}

const controlUrl = need('CONTROL_URL', 'адрес вашего сервера Control, например https://my-control.onrender.com');
const token = need('CONTROL_API_TOKEN', 'тот же токен только на чтение, что используется в App Hub');
const dbUrl = need('DATABASE_URL', 'строка подключения к Postgres (можно та же база Neon)');
const adminPassword = need('ADMIN_PASSWORD', 'пароль страницы /admin');
if (adminPassword.length < 10) {
  console.error('ADMIN_PASSWORD слишком короткий: нужно минимум 10 символов.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

(async () => {
  const store = createStore(pool);
  await store.init();
  const app = createApp({
    store,
    control: new ControlClient({ baseUrl: controlUrl, token }),
    config: {
      adminPassword,
      sessionSecret: process.env.SESSION_SECRET || null,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
      cookieSecure: process.env.COOKIE_SECURE !== 'false',
      trustProxy: 1,
    },
  });
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[share] слушаю порт ${port}; Control: ${controlUrl}`));
})().catch((e) => {
  console.error('[share] не удалось запуститься:', e.message);
  process.exit(1);
});
