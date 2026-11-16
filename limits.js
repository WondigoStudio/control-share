// Простое ограничение частоты запросов в памяти процесса: хватает для одного
// небольшого сервиса и защищает и сам сервис, и Control (за ним ходит кэш).
class RateLimiter {
  constructor() {
    this.map = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    if (this.timer.unref) this.timer.unref();
  }

  // true - запрос разрешён; false - лимит исчерпан
  take(key, limit, windowMs, now = Date.now()) {
    let e = this.map.get(key);
    if (!e || e.reset <= now) {
      e = { n: 0, reset: now + windowMs };
      this.map.set(key, e);
    }
    e.n += 1;
    return e.n <= limit;
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.map) if (e.reset <= now) this.map.delete(k);
  }
}

module.exports = { RateLimiter };
