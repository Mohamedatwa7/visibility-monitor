'use client';

/**
 * Samsung Visibility Monitor — dashboard.
 *
 * Wired to the standalone Express API in banner-monitor/server.js:
 *   GET  /api/sites        -> latest banner count + device/search shares + 60-run history per site
 *   GET  /api/log          -> recent run events (polled)
 *   POST /api/run          -> trigger a run now ("Run check now")
 *   GET/PUT /api/recipients -> manage the alert list
 *
 * Business view: every metric is shown with week-over-week (WoW) and
 * month-over-month (MoM) deltas computed from run history, plus trend charts.
 *
 * Set the API base via NEXT_PUBLIC_BANNER_API (defaults to http://localhost:4000).
 * NOTE: the static loader (public/index.html) injects only these React hooks:
 * useCallback, useEffect, useMemo, useState — don't use others here.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE =
  (typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_BANNER_API) ||
  'http://localhost:4000';

async function api(path, opts) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const DAY = 86400000;

// Latest value of `key` recorded at or before (latest run - daysAgo).
// History is chronological; returns null when we don't have data that old yet.
function valueAgo(history, key, daysAgo) {
  if (!history || history.length < 2) return null;
  const latestTs = new Date(history[history.length - 1].run_at).getTime();
  const cutoff = latestTs - daysAgo * DAY;
  let best = null;
  for (const h of history) {
    if (new Date(h.run_at).getTime() <= cutoff && h[key] != null) best = h[key];
  }
  return best;
}

/* ---------- small presentational pieces ---------- */

// WoW / MoM delta chip. Positive Samsung movement is green, negative red.
function Delta({ label, now, then, unit }) {
  const S = styles;
  if (now == null || then == null) {
    return (
      <span style={S.chipMuted} title={`Not enough history for ${label} yet`}>
        {label} —
      </span>
    );
  }
  const diff = Math.round((now - then) * 10) / 10;
  const up = diff > 0;
  const flat = diff === 0;
  const chip = flat ? S.chipFlat : up ? S.chipUp : S.chipDown;
  const arrow = flat ? '•' : up ? '▲' : '▼';
  const val = `${up ? '+' : ''}${diff}${unit || ''}`;
  return (
    <span style={chip} title={`${label}: ${then}${unit || ''} → ${now}${unit || ''}`}>
      {label} {arrow} {val}
    </span>
  );
}

function ProgressBar({ pct, color }) {
  const S = styles;
  return (
    <div style={S.barTrack}>
      <div style={{ ...S.barFill, width: `${Math.max(0, Math.min(100, pct || 0))}%`, background: color }} />
    </div>
  );
}

// The three Samsung-share metrics that can appear on a trend chart.
const TREND_SERIES = [
  { key: 'bannerSharePct', label: 'Hero banners', color: '#7c3aed' },
  { key: 'deviceSharePct', label: 'Device pages', color: '#2563eb' },
  { key: 'searchSharePct', label: 'Search', color: '#059669' },
];

// Labeled, interactive share-trend chart. Hover (or drag) across it to scrub:
// a guide line + tooltip show the exact values recorded at that run.
function TrendChart({ title, history }) {
  const S = styles;
  const [hover, setHover] = useState(null);

  const series = TREND_SERIES.filter((sd) => (history || []).some((p) => p[sd.key] != null));
  const pts = (history || []).filter((p) => series.some((sd) => p[sd.key] != null));
  if (!series.length || pts.length < 2) {
    return <div style={S.noTrend}>Collecting trend data — check back after a few runs.</div>;
  }

  const w = 280;
  const h = 104;
  const padL = 26;
  const padR = 8;
  const padT = 8;
  const padB = 8;
  const maxPct = Math.max(10, ...pts.flatMap((p) => series.map((sd) => p[sd.key] || 0))) * 1.15;
  const x = (i) => padL + (i * (w - padL - padR)) / (pts.length - 1);
  const y = (v) => h - padB - ((v || 0) / maxPct) * (h - padT - padB);
  const line = (key) =>
    pts
      .map((p, i) =>
        p[key] == null ? null : `${i === 0 || pts[i - 1][key] == null ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`
      )
      .filter(Boolean)
      .join(' ');

  const scrub = (clientX, target) => {
    const rect = target.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * w;
    const i = Math.round(((px - padL) / (w - padL - padR)) * (pts.length - 1));
    setHover(Math.max(0, Math.min(pts.length - 1, i)));
  };

  const hp = hover == null ? null : pts[hover];
  const gridVals = [0, Math.round(maxPct / 2), Math.round(maxPct)];

  return (
    <div>
      <div style={S.chartTitleRow}>
        <span style={S.chartTitle}>{title}</span>
        <span style={S.chartHint}>hover / drag to inspect</span>
      </div>
      <div style={{ position: 'relative' }}>
        <svg
          width="100%"
          viewBox={`0 0 ${w} ${h}`}
          style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}
          onMouseMove={(e) => scrub(e.clientX, e.currentTarget)}
          onMouseLeave={() => setHover(null)}
          onTouchMove={(e) => e.touches[0] && scrub(e.touches[0].clientX, e.currentTarget)}
          onTouchEnd={() => setHover(null)}
        >
          {gridVals.map((v) => (
            <g key={v}>
              <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="#f1f5f9" strokeWidth="1" />
              <text x={padL - 4} y={y(v) + 2.5} textAnchor="end" fontSize="7" fill="#94a3b8">
                {v}%
              </text>
            </g>
          ))}
          {series.map((sd) => (
            <path key={sd.key} d={line(sd.key)} fill="none" stroke={sd.color} strokeWidth="2" strokeLinecap="round" />
          ))}
          {pts.map((p, i) => (
            <g key={i}>
              {series.map(
                (sd) =>
                  p[sd.key] != null && <circle key={sd.key} cx={x(i)} cy={y(p[sd.key])} r="2.2" fill={sd.color} />
              )}
            </g>
          ))}
          {hp && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={h - padB} stroke="#64748b" strokeWidth="1" strokeDasharray="3 3" />
              {series.map(
                (sd) =>
                  hp[sd.key] != null && (
                    <circle key={sd.key} cx={x(hover)} cy={y(hp[sd.key])} r="4" fill={sd.color} stroke="#fff" strokeWidth="1.5" />
                  )
              )}
            </g>
          )}
        </svg>
        {hp && (
          <div
            style={{
              ...S.tooltip,
              left: `${(x(hover) / w) * 100}%`,
              transform: x(hover) > w * 0.55 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
          >
            <div style={S.tooltipDate}>{fmtTime(hp.run_at)}</div>
            {hp.count != null && (
              <div style={S.tooltipRow}>
                <i style={{ ...S.legendDot, background: '#7c3aed' }} /> Samsung banners: <strong>{hp.count}</strong>
              </div>
            )}
            {series.map(
              (sd) =>
                hp[sd.key] != null && (
                  <div key={sd.key} style={S.tooltipRow}>
                    <i style={{ ...S.legendDot, background: sd.color }} /> {sd.label}: <strong>{hp[sd.key]}%</strong>
                  </div>
                )
            )}
          </div>
        )}
      </div>
      <div style={S.legendRow}>
        {series.map((sd) => (
          <span key={sd.key} style={S.legendItem}>
            <i style={{ ...S.legendDot, background: sd.color }} /> {sd.label}
          </span>
        ))}
        <span style={{ ...S.legendItem, marginLeft: 'auto', color: '#9ca3af' }}>
          {fmtTime(pts[0].run_at)} – {fmtTime(pts[pts.length - 1].run_at)}
        </span>
      </div>
    </div>
  );
}

// Full-screen gallery of one site's Samsung assets, grouped into the three
// placement sections. Opened from the "Assets" link in a site card's footer.
function AssetsModal({ site, onClose }) {
  const S = styles;
  if (!site) return null;
  const sections = [
    { title: 'Hero banners', items: (site.assets && site.assets.hero) || [] },
    { title: 'Promo cards', items: (site.assets && site.assets.promo) || [] },
    { title: 'Product tiles', items: (site.assets && site.assets.tiles) || [] },
  ].filter((sec) => sec.items.length > 0);

  return (
    <div style={S.modalBackdrop} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <div>
            <div style={S.modalTitle}>{site.name} — Samsung assets</div>
            <div style={S.modalSub}>From the last check ({fmtTime(site.lastRunAt)})</div>
          </div>
          <button style={S.modalClose} onClick={onClose}>✕</button>
        </div>
        {sections.length === 0 && <div style={S.noTrend}>No Samsung assets captured in the last run.</div>}
        {sections.map((sec) => (
          <div key={sec.title} style={{ marginBottom: 18 }}>
            <div style={S.assetSectionTitle}>
              {sec.title} <span style={{ color: '#94a3b8', fontWeight: 500 }}>({sec.items.length})</span>
            </div>
            <div style={S.assetGrid}>
              {sec.items.map((a, i) => (
                <a
                  key={i}
                  href={a.href || a.src || '#'}
                  target="_blank"
                  rel="noreferrer"
                  style={S.assetCard}
                  title={a.alt || a.href || a.src}
                >
                  {a.src ? (
                    <img src={a.src} alt={a.alt || ''} style={S.assetImg} loading="lazy" />
                  ) : (
                    <div style={S.assetNoImg}>link-only placement</div>
                  )}
                  <div style={S.assetLabel}>{a.alt || (a.href || a.src || '').split('/').filter(Boolean).pop()}</div>
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TermChips({ searchShare }) {
  const S = styles;
  if (!searchShare || !Array.isArray(searchShare.results) || searchShare.results.length < 2) return null;
  return (
    <div style={S.termRow}>
      {searchShare.results.map((r, i) =>
        r.error ? (
          <span key={i} style={S.termChipErr} title={r.error}>“{r.term}” ✕</span>
        ) : (
          <span key={i} style={S.termChip} title={`${r.samsung} of ${r.total} results are Samsung`}>
            “{r.term}” {r.sharePct}%
          </span>
        )
      )}
    </div>
  );
}

/* ---------- main component ---------- */

export default function BannerMonitorDashboard() {
  const [sites, setSites] = useState([]);
  const [log, setLog] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [recipientText, setRecipientText] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [savedNote, setSavedNote] = useState('');
  const [assetsSite, setAssetsSite] = useState(null);

  const loadSites = useCallback(async () => {
    const { sites } = await api('/api/sites');
    setSites(sites);
  }, []);

  const loadLog = useCallback(async () => {
    try {
      const { events } = await api('/api/log?limit=30');
      setLog(events);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadRecipients = useCallback(async () => {
    const { recipients } = await api('/api/recipients');
    setRecipients(recipients);
    setRecipientText(recipients.join('\n'));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([loadSites(), loadLog(), loadRecipients()]);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadSites, loadLog, loadRecipients]);

  useEffect(() => {
    const id = setInterval(loadLog, 10000);
    return () => clearInterval(id);
  }, [loadLog]);

  const [runNote, setRunNote] = useState('');

  const runCheck = useCallback(async () => {
    setRunning(true);
    setError(null);
    setRunNote('');
    try {
      const result = await api('/api/run', { method: 'POST' });
      if (result && result.queued) {
        // Cloud mode: the check runs on GitHub Actions — results land in ~5 min.
        setRunNote('Check started in the cloud — new numbers appear here in ~5 minutes.');
        setTimeout(() => setRunNote(''), 60000);
      } else {
        await Promise.all([loadSites(), loadLog()]);
      }
    } catch (e) {
      setError(`Run failed: ${e.message}`);
    } finally {
      setRunning(false);
    }
  }, [loadSites, loadLog]);

  const saveRecipients = useCallback(async () => {
    const list = recipientText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const { recipients } = await api('/api/recipients', {
        method: 'PUT',
        body: JSON.stringify({ recipients: list }),
      });
      setRecipients(recipients);
      setRecipientText(recipients.join('\n'));
      setSavedNote('Saved ✓');
      setTimeout(() => setSavedNote(''), 2000);
    } catch (e) {
      setError(`Saving recipients failed: ${e.message}`);
    }
  }, [recipientText]);

  // ---- headline KPIs with WoW deltas ----
  const kpis = useMemo(() => {
    const totalBanners = sites.reduce((n, s) => n + (typeof s.count === 'number' ? s.count : 0), 0);
    const totalOnPages = sites.reduce((n, s) => n + (typeof s.bannerTotal === 'number' ? s.bannerTotal : 0), 0);
    const bannerSharePct = totalOnPages ? Math.round((totalBanners / totalOnPages) * 1000) / 10 : null;
    const bannersWoWThen = sites.reduce((acc, s) => {
      const v = valueAgo(s.history, 'count', 7);
      return v == null ? acc : (acc || 0) + v;
    }, null);

    const avg = (key) => {
      const vals = sites.map((s) => (s[key] ? s[key].sharePct : null)).filter((v) => v != null);
      return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    };
    const avgAgo = (key, days) => {
      const vals = sites.map((s) => valueAgo(s.history, key, days)).filter((v) => v != null);
      return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    };

    return {
      totalBanners,
      totalOnPages,
      bannerSharePct,
      bannersWoWThen,
      avgDevice: avg('deviceShare'),
      avgDeviceWoW: avgAgo('deviceSharePct', 7),
      avgSearch: avg('searchShare'),
      avgSearchWoW: avgAgo('searchSharePct', 7),
      lastRun: sites.reduce((t, s) => (s.lastRunAt && (!t || s.lastRunAt > t) ? s.lastRunAt : t), null),
    };
  }, [sites]);

  const S = styles;

  if (loading) return <div style={{ ...S.page, ...S.boot }}>Loading Samsung Visibility Monitor…</div>;

  return (
    <div style={S.page}>
      {/* ---- hero header ---- */}
      <header style={S.hero}>
        <div>
          <div style={S.brandRow}>
            <span style={S.logoDot} />
            <h1 style={S.h1}>Samsung Visibility Monitor</h1>
          </div>
          <p style={S.heroSub}>
            Banners, device-page shelf share and search share across {sites.length} partner retail sites
          </p>
        </div>
        <div style={S.heroRight}>
          <div style={S.heroMeta}>{runNote || `Last check: ${fmtTime(kpis.lastRun)}`}</div>
          <button style={{ ...S.btn, ...(running ? S.btnDisabled : {}) }} onClick={runCheck} disabled={running}>
            {running ? 'Starting check…' : '▶ Run check now'}
          </button>
        </div>
      </header>

      {error && <div style={S.error}>{error}</div>}

      {/* ---- KPI strip ---- */}
      <section style={S.kpiRow}>
        <div style={S.kpi}>
          <div style={S.kpiLabel}>Samsung hero banners live</div>
          <div style={S.kpiValue}>{kpis.totalBanners}</div>
          <div style={S.kpiChips}>
            <Delta label="WoW" now={kpis.totalBanners} then={kpis.bannersWoWThen} />
          </div>
          {kpis.bannerSharePct != null && (
            <div style={S.kpiSub}>
              {kpis.bannerSharePct}% of the {kpis.totalOnPages} hero banners across all landing pages
            </div>
          )}
        </div>
        <div style={S.kpi}>
          <div style={S.kpiLabel}>Avg device-page share</div>
          <div style={S.kpiValue}>{kpis.avgDevice == null ? '—' : `${kpis.avgDevice}%`}</div>
          <div style={S.kpiChips}>
            <Delta label="WoW" now={kpis.avgDevice} then={kpis.avgDeviceWoW} unit=" pt" />
          </div>
        </div>
        <div style={S.kpi}>
          <div style={S.kpiLabel}>Avg search share</div>
          <div style={S.kpiValue}>{kpis.avgSearch == null ? '—' : `${kpis.avgSearch}%`}</div>
          <div style={S.kpiChips}>
            <Delta label="WoW" now={kpis.avgSearch} then={kpis.avgSearchWoW} unit=" pt" />
          </div>
        </div>
        <div style={S.kpi}>
          <div style={S.kpiLabel}>Sites monitored</div>
          <div style={S.kpiValue}>{sites.length}</div>
          <div style={S.kpiSub}>{sites.map((s) => s.name).join(' · ')}</div>
        </div>
      </section>

      {/* ---- per-site cards ---- */}
      <section style={S.grid}>
        {sites.map((s) => {
          const countWoW = valueAgo(s.history, 'count', 7);
          const countMoM = valueAgo(s.history, 'count', 30);
          const banWoW = valueAgo(s.history, 'bannerSharePct', 7);
          const banMoM = valueAgo(s.history, 'bannerSharePct', 30);
          const devWoW = valueAgo(s.history, 'deviceSharePct', 7);
          const devMoM = valueAgo(s.history, 'deviceSharePct', 30);
          const seaWoW = valueAgo(s.history, 'searchSharePct', 7);
          const seaMoM = valueAgo(s.history, 'searchSharePct', 30);
          const bannerPct =
            s.bannerTotal && s.count != null ? Math.round((s.count / s.bannerTotal) * 1000) / 10 : null;
          const tileWoW = valueAgo(s.history, 'tileCount', 7);
          const tileMoM = valueAgo(s.history, 'tileCount', 30);
          const tilePct =
            s.tileTotal && s.tileCount != null ? Math.round((s.tileCount / s.tileTotal) * 1000) / 10 : null;
          const promoWoW = valueAgo(s.history, 'promoCount', 7);
          const promoMoM = valueAgo(s.history, 'promoCount', 30);
          const promoPct =
            s.promoTotal && s.promoCount != null ? Math.round((s.promoCount / s.promoTotal) * 1000) / 10 : null;
          return (
            <div key={s.id} style={S.card}>
              <div style={S.cardTop}>
                <div>
                  <div style={S.siteName}>{s.name}</div>
                  <div style={S.region}>{s.region} · last run {fmtTime(s.lastRunAt)}</div>
                </div>
                <div style={S.countWrap}>
                  <div style={S.count}>{s.count == null ? '—' : s.count}</div>
                  <div style={S.countLabel}>Hero banners</div>
                </div>
              </div>

              <div style={S.chipRow}>
                <Delta label="WoW" now={s.count} then={countWoW} />
                <Delta label="MoM" now={s.count} then={countMoM} />
              </div>

              {s.bannerTotal != null && s.bannerTotal > 0 && (
                <div style={S.metricBlock}>
                  <div style={S.metricHead}>
                    <span style={S.metricName}>Hero banners</span>
                    <span style={S.metricVal}>
                      {s.count}/{s.bannerTotal}
                      {bannerPct != null && <strong style={{ color: '#7c3aed' }}> {bannerPct}%</strong>}
                    </span>
                  </div>
                  <ProgressBar pct={bannerPct} color="#7c3aed" />
                  <div style={S.chipRow}>
                    <Delta label="WoW" now={bannerPct} then={banWoW} unit=" pt" />
                    <Delta label="MoM" now={bannerPct} then={banMoM} unit=" pt" />
                  </div>
                </div>
              )}

              {s.promoTotal != null && s.promoTotal > 0 && (
                <div style={S.metricBlock}>
                  <div style={S.metricHead}>
                    <span style={S.metricName}>Promo cards</span>
                    <span style={S.metricVal}>
                      {s.promoCount}/{s.promoTotal}
                      {promoPct != null && <strong style={{ color: '#d97706' }}> {promoPct}%</strong>}
                    </span>
                  </div>
                  <ProgressBar pct={promoPct} color="#d97706" />
                  <div style={S.chipRow}>
                    <Delta label="WoW" now={s.promoCount} then={promoWoW} />
                    <Delta label="MoM" now={s.promoCount} then={promoMoM} />
                  </div>
                </div>
              )}

              {s.tileTotal != null && s.tileTotal > 0 && (
                <div style={S.metricBlock}>
                  <div style={S.metricHead}>
                    <span style={S.metricName}>Samsung product tiles</span>
                    <span style={S.metricVal}>
                      {s.tileCount}/{s.tileTotal}
                      {tilePct != null && <strong style={{ color: '#db2777' }}> {tilePct}%</strong>}
                    </span>
                  </div>
                  <ProgressBar pct={tilePct} color="#db2777" />
                  <div style={S.chipRow}>
                    <Delta label="WoW" now={s.tileCount} then={tileWoW} />
                    <Delta label="MoM" now={s.tileCount} then={tileMoM} />
                  </div>
                </div>
              )}

              {s.deviceShare && (
                <div style={S.metricBlock}>
                  <div style={S.metricHead}>
                    <span style={S.metricName}>Device pages</span>
                    <span style={S.metricVal}>
                      {s.deviceShare.samsung}/{s.deviceShare.total}
                      <strong style={{ color: '#2563eb' }}> {s.deviceShare.sharePct}%</strong>
                    </span>
                  </div>
                  <ProgressBar pct={s.deviceShare.sharePct} color="#2563eb" />
                  <div style={S.chipRow}>
                    <Delta label="WoW" now={s.deviceShare.sharePct} then={devWoW} unit=" pt" />
                    <Delta label="MoM" now={s.deviceShare.sharePct} then={devMoM} unit=" pt" />
                    {s.deviceShare.pages > 1 && <span style={S.chipInfo}>first {s.deviceShare.pages} pages</span>}
                  </div>
                </div>
              )}

              {s.searchShare && (
                <div style={S.metricBlock}>
                  <div style={S.metricHead}>
                    <span style={S.metricName}>
                      Search{s.searchShare.kind === 'facet' ? ' (brand facet)' : ''}
                    </span>
                    <span style={S.metricVal}>
                      {s.searchShare.samsung}/{s.searchShare.total}
                      <strong style={{ color: '#059669' }}> {s.searchShare.sharePct}%</strong>
                    </span>
                  </div>
                  <ProgressBar pct={s.searchShare.sharePct} color="#059669" />
                  <div style={S.chipRow}>
                    <Delta label="WoW" now={s.searchShare.sharePct} then={seaWoW} unit=" pt" />
                    <Delta label="MoM" now={s.searchShare.sharePct} then={seaMoM} unit=" pt" />
                  </div>
                  <TermChips searchShare={s.searchShare} />
                </div>
              )}

              <div style={S.trendBlock}>
                <TrendChart title={`${s.name} — Samsung share trends (%)`} history={s.history} />
              </div>

              <div style={S.cardFooter}>
                <a href={s.url} target="_blank" rel="noreferrer" style={S.link}>Open site ↗</a>
                {s.screenshotPath && (
                  <a
                    href={
                      /^https?:\/\//.test(s.screenshotPath)
                        ? s.screenshotPath // cloud mode: stored as a public URL
                        : `${API_BASE}/screenshots/${encodeURIComponent(s.screenshotPath.split(/[\\/]/).pop())}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    style={S.link}
                  >
                    Screenshot ↗
                  </a>
                )}
                {s.assets && (s.assets.hero.length || s.assets.promo.length || s.assets.tiles.length) > 0 && (
                  <a
                    href="#assets"
                    style={S.link}
                    onClick={(e) => {
                      e.preventDefault();
                      setAssetsSite(s);
                    }}
                  >
                    Assets ↗
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {/* ---- activity + recipients ---- */}
      <section style={S.twoCol}>
        <div style={S.panel}>
          <h2 style={S.h2}>Recent activity</h2>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>When</th>
                <th style={S.th}>Site</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Banners</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Device %</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Search %</th>
              </tr>
            </thead>
            <tbody>
              {log.map((e) => (
                <tr key={e.id}>
                  <td style={S.td}>{fmtTime(e.run_at)}</td>
                  <td style={S.td}>{e.site}</td>
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 600 }}>{e.count}</td>
                  <td style={{ ...S.td, textAlign: 'right', color: '#2563eb' }}>
                    {e.deviceSharePct == null ? '—' : `${e.deviceSharePct}%`}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', color: '#059669' }}>
                    {e.searchSharePct == null ? '—' : `${e.searchSharePct}%`}
                  </td>
                </tr>
              ))}
              {log.length === 0 && (
                <tr>
                  <td style={S.td} colSpan={5}>No runs yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={S.panel}>
          <h2 style={S.h2}>Alert recipients</h2>
          <p style={S.help}>
            One email per line (or comma-separated). Alerts fire when a banner count or a
            Samsung share changes vs the previous check.
          </p>
          <textarea
            style={S.textarea}
            value={recipientText}
            onChange={(e) => setRecipientText(e.target.value)}
            rows={6}
            placeholder="ops@company.com&#10;lead@company.com"
          />
          <div style={S.recipFooter}>
            <button style={S.btnSmall} onClick={saveRecipients}>Save recipients</button>
            <span style={S.savedNote}>{savedNote || `${recipients.length} configured`}</span>
          </div>
        </div>
      </section>

      <footer style={S.footer}>
        Automated by banner-monitor · counts are selector-based and tuned per site · WoW/MoM deltas
        need at least 7/30 days of history before they appear.
      </footer>

      <AssetsModal site={assetsSite} onClose={() => setAssetsSite(null)} />
    </div>
  );
}

/* ---------- styles ---------- */

const styles = {
  page: {
    fontFamily: "'Segoe UI Variable','Segoe UI',-apple-system,Roboto,Arial,sans-serif",
    maxWidth: 1180,
    margin: '0 auto',
    padding: '24px 24px 40px',
    color: '#0f172a',
  },
  boot: { color: '#64748b', paddingTop: 80, textAlign: 'center' },

  hero: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    flexWrap: 'wrap',
    background: 'linear-gradient(120deg,#0f172a 0%,#1e3a8a 70%,#2563eb 100%)',
    borderRadius: 18,
    padding: '26px 30px',
    color: '#fff',
    marginBottom: 20,
    boxShadow: '0 10px 30px rgba(30,58,138,.25)',
  },
  brandRow: { display: 'flex', alignItems: 'center', gap: 10 },
  logoDot: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: 'radial-gradient(circle at 35% 35%, #93c5fd, #2563eb)',
    boxShadow: '0 0 12px rgba(147,197,253,.9)',
    display: 'inline-block',
  },
  h1: { fontSize: 24, margin: 0, fontWeight: 700, letterSpacing: '-0.01em' },
  heroSub: { color: 'rgba(255,255,255,.75)', margin: '6px 0 0', fontSize: 14 },
  heroRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 },
  heroMeta: { color: 'rgba(255,255,255,.65)', fontSize: 12 },
  btn: {
    background: '#fff',
    color: '#1e3a8a',
    border: 0,
    borderRadius: 10,
    padding: '11px 20px',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,.18)',
  },
  btnDisabled: { opacity: 0.6, cursor: 'default' },

  error: {
    background: '#fef2f2',
    color: '#b91c1c',
    border: '1px solid #fecaca',
    borderRadius: 10,
    padding: '10px 14px',
    marginBottom: 16,
  },

  kpiRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))',
    gap: 14,
    marginBottom: 22,
  },
  kpi: {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 14,
    padding: '14px 18px',
    boxShadow: '0 1px 3px rgba(15,23,42,.05)',
  },
  kpiLabel: { color: '#64748b', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' },
  kpiValue: { fontSize: 30, fontWeight: 800, margin: '4px 0 6px', letterSpacing: '-0.02em' },
  kpiChips: { display: 'flex', gap: 6 },
  kpiSub: { color: '#94a3b8', fontSize: 11, lineHeight: 1.5 },

  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(330px,1fr))', gap: 16, marginBottom: 24 },
  card: {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 16,
    padding: 20,
    boxShadow: '0 1px 3px rgba(15,23,42,.05)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  siteName: { fontWeight: 800, fontSize: 17, letterSpacing: '-0.01em' },
  region: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  countWrap: { textAlign: 'right' },
  count: { fontSize: 34, fontWeight: 800, color: '#7c3aed', lineHeight: 1, letterSpacing: '-0.02em' },
  countLabel: { color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' },

  chipRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  chipUp: { background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 700 },
  chipDown: { background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 700 },
  chipFlat: { background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 700 },
  chipMuted: { background: '#f8fafc', color: '#94a3b8', border: '1px dashed #e2e8f0', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600 },
  chipWarn: { background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 700 },
  chipInfo: { background: '#eff6ff', color: '#1d4ed8', border: '1px solid #dbeafe', borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600 },

  metricBlock: { borderTop: '1px solid #f1f5f9', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 },
  metricHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  metricName: { fontSize: 13, fontWeight: 700, color: '#334155' },
  metricVal: { fontSize: 13, color: '#64748b' },
  barTrack: { height: 8, borderRadius: 999, background: '#f1f5f9', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 999, transition: 'width .4s ease' },

  termRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 },
  termChip: { background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', borderRadius: 8, padding: '3px 8px', fontSize: 11, fontWeight: 600 },
  termChipErr: { background: '#fff7ed', color: '#c2410c', border: '1px solid #fed7aa', borderRadius: 8, padding: '3px 8px', fontSize: 11, fontWeight: 600 },

  trendBlock: { borderTop: '1px solid #f1f5f9', paddingTop: 10 },
  noTrend: { color: '#94a3b8', fontSize: 12, padding: '10px 0' },
  chartTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
  chartTitle: { fontSize: 12, fontWeight: 700, color: '#334155' },
  chartHint: { fontSize: 10, color: '#cbd5e1' },
  tooltip: {
    position: 'absolute',
    top: 0,
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    boxShadow: '0 6px 18px rgba(15,23,42,.14)',
    padding: '7px 10px',
    fontSize: 11,
    color: '#334155',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    zIndex: 5,
  },
  tooltipDate: { fontWeight: 700, color: '#0f172a', marginBottom: 4 },
  tooltipRow: { display: 'flex', alignItems: 'center', gap: 5, lineHeight: 1.6 },
  legendRow: { display: 'flex', gap: 14, alignItems: 'center', marginTop: 4 },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#64748b' },
  legendDot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },

  link: { color: '#2563eb', textDecoration: 'none', fontWeight: 600, fontSize: 13 },
  cardFooter: { display: 'flex', gap: 16, borderTop: '1px solid #f1f5f9', paddingTop: 10, marginTop: 'auto' },

  twoCol: { display: 'grid', gridTemplateColumns: 'minmax(0,3fr) minmax(0,2fr)', gap: 16 },
  panel: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 20, boxShadow: '0 1px 3px rgba(15,23,42,.05)' },
  h2: { fontSize: 15, margin: '0 0 12px', fontWeight: 700 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', padding: '4px 4px 8px', borderBottom: '1px solid #e2e8f0' },
  td: { padding: '7px 4px', borderBottom: '1px solid #f8fafc' },
  help: { color: '#64748b', fontSize: 12, margin: '0 0 8px', lineHeight: 1.5 },
  textarea: { width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 10, padding: 10, fontFamily: 'Consolas,monospace', fontSize: 13 },
  recipFooter: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 },
  btnSmall: { background: '#0f172a', color: '#fff', border: 0, borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  savedNote: { color: '#64748b', fontSize: 12 },
  footer: { color: '#94a3b8', fontSize: 12, marginTop: 20, textAlign: 'center', lineHeight: 1.6 },

  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15,23,42,.55)',
    zIndex: 50,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '5vh 16px',
    overflowY: 'auto',
  },
  modal: {
    background: '#fff',
    borderRadius: 16,
    padding: 24,
    maxWidth: 860,
    width: '100%',
    maxHeight: '88vh',
    overflowY: 'auto',
    boxShadow: '0 24px 60px rgba(15,23,42,.35)',
  },
  modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' },
  modalSub: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  modalClose: {
    background: '#f1f5f9',
    border: 0,
    borderRadius: 8,
    width: 32,
    height: 32,
    fontSize: 14,
    cursor: 'pointer',
    color: '#475569',
  },
  assetSectionTitle: { fontSize: 14, fontWeight: 700, color: '#334155', margin: '0 0 8px' },
  assetGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 10 },
  assetCard: {
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: 8,
    textDecoration: 'none',
    color: '#334155',
    background: '#f8fafc',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  assetImg: { width: '100%', height: 110, objectFit: 'contain', borderRadius: 6, background: '#fff' },
  assetNoImg: {
    width: '100%',
    height: 110,
    borderRadius: 6,
    background: '#eef2ff',
    color: '#4338ca',
    fontSize: 11,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  assetLabel: {
    fontSize: 11,
    lineHeight: 1.4,
    color: '#475569',
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
};
