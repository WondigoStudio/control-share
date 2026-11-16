// Превращает ответы Control в то, что можно показывать посторонним.
// Это единственное место, где данные попадают на публичную страницу, и оно
// устроено по принципу белого списка: берём поля по одному, сырые объекты
// из Control наружу не передаём никогда.

const RANGES = { '24h': 24, '7d': 168, '30d': 720 };
const MAX_POINTS = 480;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : null);

// [[время, мс, 1|0], ...]. Слишком длинный ряд укрупняем, падения при этом не теряем.
function compactSeries(rows) {
  if (!Array.isArray(rows)) return [];
  const pts = rows
    .filter((r) => r && num(r.ts) !== null)
    .map((r) => [r.ts, num(r.response_ms), r.ok ? 1 : 0]);
  if (pts.length <= MAX_POINTS) return pts;
  const size = Math.ceil(pts.length / MAX_POINTS);
  const out = [];
  for (let i = 0; i < pts.length; i += size) {
    const g = pts.slice(i, i + size);
    const ms = g.map((p) => p[1]).filter((v) => v !== null);
    out.push([g[0][0], ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, g.every((p) => p[2]) ? 1 : 0]);
  }
  return out;
}

function publicStatus(m) {
  if (m.maintenance && m.maintenance.enabled) return 'maintenance';
  return m.status === 'up' || m.status === 'down' ? m.status : 'unknown';
}

function buildPublicData(link, { monitor, history, stats, heatmap, incidents, restarts }, range, meta) {
  const m = monitor;
  const out = {
    title: link.label || m.name || link.monitorName || 'Сервис',
    status: publicStatus(m),
    checkedAt: num(m.lastCheckedAt),
    responseMs: num(m.lastResponseMs),
    uptime24h: num(m.uptime24h),
    uptime7d: num(m.uptime7d),
    intervalSec: num(m.intervalSec),
    ssl: m.ssl && num(m.ssl.daysLeft) !== null ? { valid: !!m.ssl.valid, daysLeft: m.ssl.daysLeft } : null,
    range,
    stats: stats ? { avg: num(stats.avg), min: num(stats.min), max: num(stats.max) } : null,
    series: compactSeries(history),
    heatmap: Array.isArray(heatmap)
      ? heatmap.filter((d) => d && typeof d.day === 'string').map((d) => ({ day: d.day.slice(0, 10), uptime: num(d.uptime) }))
      : [],
    incidents: [],
    updatedAt: meta.updatedAt,
    stale: !!meta.stale,
    partial: !!meta.partial,
  };

  if (!link.hideUrl) out.target = text(m.target, 200);

  if (!link.hideErrors && m.status === 'down') {
    const d = m.lastErrorDiagnosis || {};
    out.error = { label: text(d.label, 120), explanation: text(d.explanation, 400), message: text(m.lastError, 300) };
  }

  if (Array.isArray(incidents)) {
    out.incidents = incidents.slice(0, 30).map((i) => {
      const r = { start: num(i.start), end: num(i.end), ongoing: !!i.ongoing, durationMs: num(i.durationMs) };
      if (!link.hideErrors) {
        const d = i.diagnosis || {};
        r.label = text(d.label, 120);
        r.explanation = text(d.explanation, 400);
        r.message = text(i.error, 300);
      }
      if (!link.hideRecovery) r.autoRestarted = !!(i.recovery && i.recovery.attempted);
      return r;
    });
  }

  if (!link.hideRecovery) {
    out.recovery = {
      enabled: !!m.hasAutoRestart,
      log: Array.isArray(restarts)
        ? restarts.slice(0, 10).map((r) => {
            const e = { ts: num(r.ts), success: !!r.success };
            if (!link.hideErrors) e.message = text(r.error, 200);
            return e;
          })
        : [],
    };
  }
  return out;
}

module.exports = { buildPublicData, RANGES, compactSeries };
