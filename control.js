// Клиент к Control: только GET по read-only токену, с кэшем.
//  - кэш защищает Control (бесплатный Render) от публичного трафика;
//  - одинаковые запросы, пришедшие одновременно, превращаются в один;
//  - если Control спит или недоступен, отдаём последние известные данные
//    с пометкой stale, а не ошибку.
const ALLOWED = /^\/api\/(monitors|monitors\/[^/]+\/(history|incidents|stats|heatmap|restarts))$/;

class ControlError extends Error {}

class ControlClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 25_000, maxStaleMs = 6 * 3600_000, maxEntries = 400, now = Date.now }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxStaleMs = maxStaleMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.cache = new Map(); // ключ -> { data, at, promise }
  }

  // path вместе с query; ttlMs - сколько данные считаются свежими
  async get(pathWithQuery, ttlMs) {
    const pathOnly = pathWithQuery.split('?')[0];
    if (!ALLOWED.test(pathOnly)) throw new ControlError('путь не разрешён: ' + pathOnly);

    const key = pathWithQuery;
    const e = this.cache.get(key);
    const t = this.now();
    if (e && e.data !== undefined && t - e.at < ttlMs) return { data: e.data, stale: false, at: e.at };
    if (e && e.promise) return e.promise;

    const promise = this._fetch(pathWithQuery)
      .then((data) => {
        const at = this.now();
        this.cache.set(key, { data, at });
        this._trim();
        return { data, stale: false, at };
      })
      .catch((err) => {
        // promise у записи снимаем в любом случае, иначе следующий запрос зависнет на упавшем
        if (e && e.data !== undefined) this.cache.set(key, { data: e.data, at: e.at });
        else this.cache.delete(key);
        if (e && e.data !== undefined && this.now() - e.at < this.maxStaleMs) return { data: e.data, stale: true, at: e.at };
        throw err instanceof ControlError ? err : new ControlError(err.message || 'Control недоступен');
      });

    this.cache.set(key, { data: e ? e.data : undefined, at: e ? e.at : 0, promise });
    return promise;
  }

  async _fetch(pathWithQuery) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.baseUrl + pathWithQuery, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + this.token, Accept: 'application/json' },
        signal: ctrl.signal,
        redirect: 'error',
      });
      if (!res.ok) throw new ControlError(`Control ответил ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new ControlError('Control не ответил вовремя');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _trim() {
    if (this.cache.size <= this.maxEntries) return;
    const old = [...this.cache.entries()].filter(([, v]) => !v.promise).sort((a, b) => a[1].at - b[1].at);
    for (const [k] of old.slice(0, this.cache.size - this.maxEntries)) this.cache.delete(k);
  }
}

module.exports = { ControlClient, ControlError };
