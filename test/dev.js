// Ручной запуск для проверки в браузере: заглушка Control + тестовая БД в памяти.
const { boot, ADMIN_PW } = require('./helpers');
(async () => {
  const env = await boot();
  console.log('BASE', env.base, 'PASSWORD', ADMIN_PW);
})();
