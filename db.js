const crypto = require('crypto');

// Хранилище ссылок. Единственная таблица share_links; к таблицам Control
// сервис не прикасается, поэтому может жить в той же базе Neon.
function createStore(pool) {
  const toLink = (r) => r && ({
    id: Number(r.id),
    token: r.token,
    monitorId: r.monitor_id,
    monitorName: r.monitor_name,
    label: r.label || '',
    hideUrl: !!r.hide_url,
    hideErrors: !!r.hide_errors,
    hideRecovery: !!r.hide_recovery,
    createdAt: Number(r.created_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
    views: Number(r.views || 0),
    lastViewAt: r.last_view_at === null || r.last_view_at === undefined ? null : Number(r.last_view_at),
  });

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS share_links (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        monitor_id TEXT NOT NULL,
        monitor_name TEXT,
        label TEXT,
        hide_url BOOLEAN NOT NULL DEFAULT TRUE,
        hide_errors BOOLEAN NOT NULL DEFAULT TRUE,
        hide_recovery BOOLEAN NOT NULL DEFAULT TRUE,
        created_at BIGINT NOT NULL,
        revoked_at BIGINT,
        views INTEGER NOT NULL DEFAULT 0,
        last_view_at BIGINT
      )`);
  }

  const one = async (sql, args) => toLink((await pool.query(sql, args)).rows[0]);

  return {
    init,
    newToken: () => crypto.randomBytes(24).toString('base64url'),

    async create({ token, monitorId, monitorName, label, hideUrl, hideErrors, hideRecovery }, now = Date.now()) {
      return one(
        `INSERT INTO share_links (token, monitor_id, monitor_name, label, hide_url, hide_errors, hide_recovery, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [token, monitorId, monitorName || null, label || null, hideUrl, hideErrors, hideRecovery, now]
      );
    },

    getByToken: (token) => one(`SELECT * FROM share_links WHERE token = $1`, [token]),
    getById: (id) => one(`SELECT * FROM share_links WHERE id = $1`, [id]),

    async list() {
      const { rows } = await pool.query(`SELECT * FROM share_links ORDER BY created_at DESC, id DESC`);
      return rows.map(toLink);
    },

    // Меняются только перечисленные поля: остальное (токен, монитор) неизменно.
    async update(id, p) {
      const sets = [];
      const args = [];
      const add = (col, v) => { args.push(v); sets.push(`${col} = $${args.length}`); };
      if (p.label !== undefined) add('label', p.label || null);
      if (p.hideUrl !== undefined) add('hide_url', !!p.hideUrl);
      if (p.hideErrors !== undefined) add('hide_errors', !!p.hideErrors);
      if (p.hideRecovery !== undefined) add('hide_recovery', !!p.hideRecovery);
      if (!sets.length) return this.getById(id);
      args.push(id);
      return one(`UPDATE share_links SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`, args);
    },

    revoke: (id, now = Date.now()) => one(`UPDATE share_links SET revoked_at = $1 WHERE id = $2 RETURNING *`, [now, id]),
    restore: (id) => one(`UPDATE share_links SET revoked_at = NULL WHERE id = $1 RETURNING *`, [id]),

    async remove(id) {
      const r = await pool.query(`DELETE FROM share_links WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },

    addView: (id, now = Date.now()) =>
      pool.query(`UPDATE share_links SET views = views + 1, last_view_at = $1 WHERE id = $2`, [now, id]),
  };
}

module.exports = { createStore };
