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

/* ---------- competition analysis ---------- */

// Brand palette + labels (researched Gulf-market competitor set, 2026-07).
const BRAND_META = {
  samsung: { label: 'Samsung', color: '#1428a0' },
  apple: { label: 'Apple', color: '#64748b' },
  xiaomi: { label: 'Xiaomi', color: '#ff6900' },
  honor: { label: 'Honor', color: '#0ea5e9' },
  huawei: { label: 'Huawei', color: '#ce0e2d' },
  oppo: { label: 'Oppo', color: '#046a38' },
  vivo: { label: 'vivo', color: '#415fff' },
  realme: { label: 'realme', color: '#f2c94c' },
  nothing: { label: 'Nothing', color: '#111111' },
  google: { label: 'Google', color: '#34a853' },
  infinix: { label: 'Infinix', color: '#8b5cf6' },
  tecno: { label: 'Tecno', color: '#06b6d4' },
  lg: { label: 'LG', color: '#a50034' },
  tcl: { label: 'TCL', color: '#e11d48' },
  hisense: { label: 'Hisense', color: '#00a651' },
  sony: { label: 'Sony', color: '#334155' },
  bosch: { label: 'Bosch', color: '#ea0016' },
  beko: { label: 'Beko', color: '#003b7e' },
  midea: { label: 'Midea', color: '#0091d0' },
  haier: { label: 'Haier', color: '#1d4ed8' },
  dyson: { label: 'Dyson', color: '#7f56d9' },
  jbl: { label: 'JBL', color: '#f97316' },
  other: { label: 'Other', color: '#cbd5e1' },
};
const brandMeta = (id) => BRAND_META[id] || { label: id, color: '#94a3b8' };

const DIVISION_LABELS = {
  mobile: 'Smartphones',
  tv: 'TV & AV',
  appliance: 'Home Appliances',
  wearable: 'Wearables',
  audio: 'Audio',
  computing: 'Tablets & PCs',
};

function mergeBrandMaps(...maps) {
  const out = {};
  for (const m of maps) {
    if (!m) continue;
    for (const k of Object.keys(m)) out[k] = (out[k] || 0) + m[k];
  }
  return out;
}

// Samsung's rank among identified brands (ties share a rank; 'other' excluded).
function samsungRank(map) {
  const entries = Object.entries(map || {}).filter(([b]) => b !== 'other');
  if (!entries.length || !map.samsung) return null;
  const better = entries.filter(([b, n]) => b !== 'samsung' && n > map.samsung).length;
  return better + 1;
}

// Ranked brand leaderboard: one row per brand with its own bar, name, and
// numbers inline — readable without any color legend.
function Leaderboard({ title, data, subtitle }) {
  const S = styles;
  const entries = Object.entries(data || {}).filter(([b]) => b !== 'other');
  const otherN = (data && data.other) || 0;
  const total = entries.reduce((n, [, v]) => n + v, 0) + otherN;
  if (!total) return null;
  if (!entries.length) {
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={S.lbHead}>
          <span style={S.lbTitle}>{title}</span>
          <span style={S.lbSub}>no branded placements among {total} on the page</span>
        </div>
      </div>
    );
  }
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 5);
  const restN = entries.slice(5).reduce((n, [, v]) => n + v, 0) + otherN;
  const max = top[0][1];

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={S.lbHead}>
        <span style={S.lbTitle}>{title}</span>
        {subtitle && <span style={S.lbSub}>{subtitle}</span>}
      </div>
      {top.map(([b, n], i) => {
        const meta = brandMeta(b);
        const pct = Math.round((n / total) * 1000) / 10;
        const isSamsung = b === 'samsung';
        return (
          <div key={b} style={{ ...S.lbRow, ...(isSamsung ? S.lbRowSamsung : {}) }}>
            <span style={S.lbRank}>{i + 1}</span>
            <span style={{ ...S.lbBrand, fontWeight: isSamsung ? 800 : 600 }}>{meta.label}</span>
            <div style={S.lbBarTrack}>
              <div style={{ ...S.lbBarFill, width: `${(n / max) * 100}%`, background: meta.color }} />
            </div>
            <span style={{ ...S.lbNum, fontWeight: isSamsung ? 800 : 600 }}>
              {n} <span style={S.lbPct}>({pct}%)</span>
            </span>
          </div>
        );
      })}
      {restN > 0 && (
        <div style={{ ...S.lbRow, opacity: 0.55 }}>
          <span style={S.lbRank}>·</span>
          <span style={S.lbBrand}>Others</span>
          <div style={S.lbBarTrack}>
            <div style={{ ...S.lbBarFill, width: `${Math.min((restN / max) * 100, 100)}%`, background: '#cbd5e1' }} />
          </div>
          <span style={S.lbNum}>{restN}</span>
        </div>
      )}
    </div>
  );
}

// One-line division summary: Samsung's rank + share, and who to watch.
function DivisionLine({ label, brands }) {
  const S = styles;
  const entries = Object.entries(brands || {}).filter(([b]) => b !== 'other');
  const total = entries.reduce((n, [, v]) => n + v, 0);
  if (!total) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const rank = samsungRank(brands);
  const samsungN = brands.samsung || 0;
  const pct = Math.round((samsungN / total) * 1000) / 10;
  const rival = entries.find(([b]) => b !== 'samsung');
  const rivalTxt = rival ? `${brandMeta(rival[0]).label} ${rival[1]}` : '';
  const good = rank === 1;

  return (
    <div style={S.divLine}>
      <span style={S.divName}>{label}</span>
      <span style={{ ...S.divRankChip, ...(good ? S.chipUp : S.chipWarn) }}>
        {rank ? `#${rank}` : '—'}
      </span>
      <span style={S.divDetail}>
        Samsung {samsungN}/{total} ({pct}%){rivalTxt ? ` · ${good ? 'next' : 'leader'}: ${rivalTxt}` : ''}
      </span>
    </div>
  );
}

// Multi-brand share trend: one line per top brand, hover/drag to inspect —
// this is where week-over-week competitive movement shows up. `field` picks
// the metric: 'placementBrands' (homepage) or 'catalogBrands' (device catalog).
function CompetitionTrend({ site, field, title }) {
  const S = styles;
  const [hover, setHover] = useState(null);
  const pts = (site.history || [])
    .filter((h) => h[field])
    .map((h) => ({ run_at: h.run_at, competitionBrands: h[field] }));
  if (pts.length < 2) return <div style={S.noTrend}>{title} trend appears after a few daily checks.</div>;

  // Top 5 brands by latest share, Samsung always included.
  const latest = pts[pts.length - 1].competitionBrands;
  const brands = Object.entries(latest)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([b]) => b);
  if (!brands.includes('samsung') && latest.samsung != null) brands.splice(4, 1, 'samsung');

  const w = 280;
  const h = 104;
  const padL = 26;
  const padR = 8;
  const padT = 8;
  const padB = 8;
  const maxPct = Math.max(10, ...pts.flatMap((p) => brands.map((b) => p.competitionBrands[b] || 0))) * 1.15;
  const x = (i) => padL + (i * (w - padL - padR)) / (pts.length - 1);
  const y = (v) => h - padB - ((v || 0) / maxPct) * (h - padT - padB);
  const line = (b) =>
    pts
      .map((p, i) => {
        const v = p.competitionBrands[b];
        return v == null ? null : `${i === 0 || pts[i - 1].competitionBrands[b] == null ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      })
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
    <div style={{ marginTop: 4 }}>
      <div style={S.chartTitleRow}>
        <span style={S.chartTitle}>{title} — top brands (%)</span>
        <span style={S.chartHint}>hover / drag</span>
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
          {brands.map((b) => (
            <path
              key={b}
              d={line(b)}
              fill="none"
              stroke={brandMeta(b).color}
              strokeWidth={b === 'samsung' ? 2.4 : 1.6}
              strokeLinecap="round"
              opacity={b === 'samsung' ? 1 : 0.85}
            />
          ))}
          {hp && (
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={h - padB} stroke="#64748b" strokeWidth="1" strokeDasharray="3 3" />
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
            {brands
              .filter((b) => hp.competitionBrands[b] != null)
              .sort((a, b) => hp.competitionBrands[b] - hp.competitionBrands[a])
              .map((b) => (
                <div key={b} style={S.tooltipRow}>
                  <i style={{ ...S.legendDot, background: brandMeta(b).color }} /> {brandMeta(b).label}:{' '}
                  <strong>{hp.competitionBrands[b]}%</strong>
                </div>
              ))}
          </div>
        )}
      </div>
      <div style={{ ...S.legendRow, flexWrap: 'wrap' }}>
        {brands.map((b) => (
          <span key={b} style={S.legendItem}>
            <i style={{ ...S.legendDot, background: brandMeta(b).color }} /> {brandMeta(b).label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Per-site competition panel: brand leaderboards per metric + division lines.
// Rendered as the BACK face of each site card — `onFlip` flips back to metrics.
function CompetitionCard({ site, onFlip }) {
  const S = styles;
  const c = site.competition || {};
  const placements = mergeBrandMaps(c.hero, c.promo, c.tiles);
  const divisions = Object.entries(c.divisions || {}).filter(
    ([, brands]) => Object.keys(brands).length >= 2 // head-to-head needs 2+ brands
  );
  const hasAny =
    Object.keys(placements).length || (c.devices && Object.keys(c.devices).length) || (c.search && Object.keys(c.search).length);

  return (
    <div style={{ ...S.card, height: '100%', boxSizing: 'border-box' }}>
      <div style={S.cardTop}>
        <div>
          <div style={S.siteName}>{site.name}</div>
          <div style={S.region}>Competition analysis · Samsung vs rival brands</div>
        </div>
        <button style={S.flipBtn} onClick={onFlip} title="Back to Samsung metrics">
          ⇄ Overview
        </button>
      </div>

      {!hasAny && (
        <div style={S.noTrend}>No competition data captured yet — brand breakdowns appear after the next check.</div>
      )}

      {hasAny && (
        <>
          {/* Homepage placements, broken down by placement type */}
          <div style={{ marginTop: 2 }}>
            <div style={S.divisionHead}>Homepage placements</div>
            <Leaderboard title="Hero banners" data={c.hero} />
            <Leaderboard title="Promo cards" data={c.promo} />
            <Leaderboard title="Product tiles" data={c.tiles} />
            <CompetitionTrend site={site} field="placementBrands" title="Homepage placements" />
          </div>

          {/* Device catalog */}
          {c.devices && (
            <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 8, marginTop: 10 }}>
              <div style={S.divisionHead}>Device catalog</div>
              <Leaderboard title="Share of catalog" subtitle="first 5 pages" data={c.devices} />
              <CompetitionTrend site={site} field="catalogBrands" title="Device catalog" />
            </div>
          )}

          {/* Search */}
          {c.search && (
            <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 8, marginTop: 10 }}>
              <Leaderboard title="Search results" subtitle="common phone searches" data={c.search} />
            </div>
          )}

          {divisions.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={S.divisionHead}>Samsung's position by division</div>
              {divisions.map(([div, brands]) => (
                <DivisionLine key={div} label={DIVISION_LABELS[div] || div} brands={brands} />
              ))}
            </div>
          )}
        </>
      )}
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

// Where Samsung's devices actually SIT on the catalog. Every Samsung device
// is a numbered chip (#5, #12, …) colored by shelf zone so each position is
// individually readable: green = top 10 (prime), blue = 11–24 (first page
// view), gray = deeper.
function ShelfPositions({ deviceShare }) {
  const S = styles;
  const pos = (deviceShare && deviceShare.positions) || [];
  const total = (deviceShare && deviceShare.total) || 0;
  if (!pos.length || !total) return null;
  const sorted = pos.slice().sort((a, b) => a - b);
  const first = sorted[0];
  const median = sorted[Math.floor(sorted.length / 2)];
  const zones = [
    { label: 'Top 10 (prime)', style: S.posChipPrime, n: sorted.filter((p) => p <= 10).length },
    { label: '11–24', style: S.posChipGood, n: sorted.filter((p) => p > 10 && p <= 24).length },
    { label: 'deeper', style: S.posChipDeep, n: sorted.filter((p) => p > 24).length },
  ];
  const chipStyle = (p) => (p <= 10 ? S.posChipPrime : p <= 24 ? S.posChipGood : S.posChipDeep);

  return (
    <div style={{ marginTop: 6 }}>
      <div style={S.shelfHead}>
        <span style={S.shelfTitle}>Where Samsung devices appear ({sorted.length} of {total} slots)</span>
        <span style={S.shelfStats}>
          first at <strong>#{first}</strong> · half beyond <strong>#{median}</strong>
        </span>
      </div>
      <div style={S.posChipWrap}>
        {sorted.map((p) => (
          <span key={p} style={{ ...S.posChip, ...chipStyle(p) }}>
            #{p}
          </span>
        ))}
      </div>
      <div style={S.shelfCaption}>
        {zones
          .filter((z) => z.n > 0)
          .map((z, i) => (
            <span key={z.label} style={{ marginRight: 10 }}>
              <span style={{ ...S.posLegendDot, ...z.style }} /> {z.label}: <strong>{z.n}</strong>
            </span>
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

/* ---------- social share of voice ---------- */

const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' };

const SOCIAL_PERIODS = [
  ['all', 'Since Jan'],
  ['90', '90 days'],
  ['30', '30 days'],
  ['7', '7 days'],
];
const SOCIAL_PLATFORMS = [['all', 'All'], ...Object.entries(PLATFORM_LABELS)];
const SOCIAL_CONTENT = [
  ['all', 'All posts'],
  ['samsung', 'Samsung'],
  ['competitor', 'Competitors'],
  ['s26', 'Galaxy S26'],
];

// Compact engagement numbers for the post feed (1.2k, 34k).
function fmtCount(n) {
  if (!n) return '0';
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

// One row per company: how much of its (filtered) social posting features
// Samsung vs competitor brands. Click to focus the post feed on that company.
function SocialRow({ s, selected, onSelect }) {
  const S = styles;
  const pct = (n) => (s.total ? Math.round((n / s.total) * 1000) / 10 : 0);
  const samsungPct = pct(s.samsung);
  const rivalPct = pct(s.competitor);
  const topRivals = Object.entries(s.brands || {})
    .filter(([b]) => b !== 'samsung')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const platforms = ['instagram', 'tiktok', 'facebook']
    .map((pf) => (s.byPlatform[pf] ? `${PLATFORM_LABELS[pf]} ${s.byPlatform[pf]}` : null))
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      style={{ ...S.socialRow, ...(selected ? S.socialRowSelected : {}) }}
      onClick={onSelect}
      title={selected ? 'Feed is focused on this company — click to show all' : 'Click to focus the post feed on this company'}
    >
      <div style={S.socialSite}>
        <div style={S.socialName}>{s.name}</div>
        <div style={S.socialPlatforms}>{platforms || 'no posts captured yet'}</div>
      </div>
      <div style={S.socialBarWrap}>
        <div style={S.socialBar} title={`Samsung ${samsungPct}% · competitors ${rivalPct}% · other ${Math.max(0, Math.round((100 - samsungPct - rivalPct) * 10) / 10)}%`}>
          <div style={{ ...S.socialSeg, width: `${samsungPct}%`, background: '#1428a0' }} />
          <div style={{ ...S.socialSeg, width: `${rivalPct}%`, background: '#e11d48' }} />
        </div>
        <div style={S.socialCaption}>
          Samsung <strong>{s.samsung}</strong> ({samsungPct}%) · competitors <strong>{s.competitor}</strong> ({rivalPct}%)
          {topRivals.length > 0 && <span style={{ color: '#94a3b8' }}> — {topRivals.map(([b, n]) => `${brandMeta(b).label} ${n}`).join(', ')}</span>}
        </div>
      </div>
      <span style={S.chipInfo} title="Posts mentioning the Galaxy S26 series">
        S26 · {s.s26}
      </span>
      <div style={S.socialNums}>
        <div style={S.socialTotal}>{s.total}</div>
        <div style={S.countLabel}>posts</div>
      </div>
    </div>
  );
}

// One post in the feed: who/where/when + trimmed caption + engagement.
function SocialPost({ p, siteName }) {
  const S = styles;
  const rivals = (p.brands || []).filter((b) => b !== 'samsung').slice(0, 3);
  const stats = [`♥ ${fmtCount(p.likes)}`, `💬 ${fmtCount(p.comments)}`];
  if (p.views) stats.push(`▶ ${fmtCount(p.views)}`);
  return (
    <a href={p.url || '#'} target="_blank" rel="noreferrer" style={S.postRow}>
      <div style={S.postMeta}>
        <span style={S.postSite}>{siteName}</span>
        <span>{PLATFORM_LABELS[p.platform] || p.platform}</span>
        <span>{fmtTime(p.at)}</span>
        {p.s26 ? (
          <span style={S.chipInfo}>Galaxy S26</span>
        ) : (
          p.samsung && (
            <span style={S.postBrand}>
              <i style={{ ...S.legendDot, background: brandMeta('samsung').color }} /> Samsung
            </span>
          )
        )}
        {rivals.map((b) => (
          <span key={b} style={S.postBrand}>
            <i style={{ ...S.legendDot, background: brandMeta(b).color }} /> {brandMeta(b).label}
          </span>
        ))}
        <span style={S.postStats}>{stats.join(' · ')}</span>
      </div>
      <div style={S.postCaption}>{p.caption || '(no caption)'}</div>
    </a>
  );
}

const FEED_PAGE = 8;

// The API returns the raw classified post list; every aggregate here is
// recomputed locally so the period/platform/content filters are instant.
function SocialSection({ social, visible }) {
  const S = styles;
  const [period, setPeriod] = useState('all');
  const [platform, setPlatform] = useState('all');
  const [content, setContent] = useState('all');
  const [feedSite, setFeedSite] = useState(null);
  const [feedLimit, setFeedLimit] = useState(FEED_PAGE);

  const posts = social && Array.isArray(social.posts) ? social.posts : [];
  const nameOf = useMemo(
    () => Object.fromEntries(((social && social.sites) || []).map((s) => [s.id, s.name])),
    [social]
  );
  const visibleIds = useMemo(() => new Set(visible.map((v) => v.id)), [visible]);

  const filtered = useMemo(() => {
    const cutoff = period === 'all' ? null : new Date(Date.now() - Number(period) * DAY).toISOString();
    return posts.filter(
      (p) =>
        visibleIds.has(p.site) &&
        (!cutoff || p.at >= cutoff) &&
        (platform === 'all' || p.platform === platform) &&
        (content === 'all' ||
          (content === 'samsung' && p.samsung) ||
          (content === 'competitor' && !p.samsung && (p.brands || []).some((b) => b !== 'samsung')) ||
          (content === 's26' && p.s26))
    );
  }, [posts, visibleIds, period, platform, content]);

  // Per-company aggregates over the filtered posts, in site-card order.
  const rows = useMemo(() => {
    const bySite = {};
    for (const p of filtered) {
      const a = (bySite[p.site] = bySite[p.site] || {
        total: 0,
        samsung: 0,
        competitor: 0, // competitor mentioned, Samsung not
        s26: 0,
        brands: {}, // brand -> posts mentioning it (any mention)
        byPlatform: {},
      });
      a.total++;
      if (p.samsung) a.samsung++;
      else if ((p.brands || []).some((b) => b !== 'samsung')) a.competitor++;
      if (p.s26) a.s26++;
      for (const b of p.brands || []) a.brands[b] = (a.brands[b] || 0) + 1;
      a.byPlatform[p.platform] = (a.byPlatform[p.platform] || 0) + 1;
    }
    return visible.filter((v) => bySite[v.id]).map((v) => ({ id: v.id, name: v.name, ...bySite[v.id] }));
  }, [filtered, visible]);

  const feed = useMemo(
    () => (feedSite ? filtered.filter((p) => p.site === feedSite) : filtered),
    [filtered, feedSite]
  );

  if (!posts.length) return null;

  const total = filtered.length;
  const samsung = rows.reduce((n, r) => n + r.samsung, 0);
  const s26 = rows.reduce((n, r) => n + r.s26, 0);
  const sinceLabel = new Date(social.since).toLocaleString(undefined, { month: 'short', year: 'numeric' });
  const setFilter = (set) => (v) => {
    set(v);
    setFeedLimit(FEED_PAGE);
  };
  const chips = (opts, val, set) =>
    opts.map(([v, label]) => (
      <button
        key={v}
        style={{ ...S.filterChip, ...(val === v ? S.filterChipOn : {}) }}
        onClick={() => setFilter(set)(v)}
      >
        {label}
      </button>
    ));

  return (
    <section style={{ marginBottom: 24 }}>
      <div style={S.sectionHead}>
        <h2 style={{ ...S.h2, margin: 0 }}>Social media — share of voice</h2>
        <span style={S.sectionSub}>
          Instagram, TikTok & Facebook posts by each company since {sinceLabel} — Samsung vs competitor brands
        </span>
      </div>
      <div style={S.panel}>
        <div style={S.socialFilters}>
          <span style={S.filterLabel}>Period</span>
          {chips(SOCIAL_PERIODS, period, setPeriod)}
          <span style={{ ...S.filterLabel, marginLeft: 8 }}>Platform</span>
          {chips(SOCIAL_PLATFORMS, platform, setPlatform)}
          <span style={{ ...S.filterLabel, marginLeft: 8 }}>Content</span>
          {chips(SOCIAL_CONTENT, content, setContent)}
        </div>
        <div style={S.socialSummary}>
          <span><strong>{total}</strong> posts match</span>
          <span>
            <i style={{ ...S.legendDot, background: '#1428a0' }} /> Samsung <strong>{samsung}</strong> ({total ? Math.round((samsung / total) * 1000) / 10 : 0}%)
          </span>
          <span>
            <i style={{ ...S.legendDot, background: '#e11d48' }} /> competitor brands
          </span>
          <span style={S.chipInfo}>Galaxy S26 posts · {s26}</span>
        </div>
        {total === 0 && <div style={S.noTrend}>No posts match these filters.</div>}
        {total > 0 && (
          <div style={S.socialCols}>
            <div>
              {rows.map((s) => (
                <SocialRow
                  key={s.id}
                  s={s}
                  selected={feedSite === s.id}
                  onSelect={() => setFeedSite(feedSite === s.id ? null : s.id)}
                />
              ))}
              <div style={S.socialHint}>Click a company to focus the post feed.</div>
            </div>
            <div>
              <div style={S.feedHead}>
                Latest posts{feedSite ? ` — ${nameOf[feedSite] || feedSite}` : ''}
                <span style={{ fontWeight: 500, color: '#94a3b8' }}>({feed.length})</span>
                {feedSite && (
                  <button style={S.feedClear} onClick={() => setFeedSite(null)}>
                    show all ✕
                  </button>
                )}
              </div>
              {feed.slice(0, feedLimit).map((p) => (
                <SocialPost key={`${p.platform}:${p.id}`} p={p} siteName={nameOf[p.site] || p.site} />
              ))}
              {feed.length > feedLimit && (
                <button style={S.feedMore} onClick={() => setFeedLimit(feedLimit + 20)}>
                  Show more ({feed.length - feedLimit} remaining)
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
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
  const [countryFilter, setCountryFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  // Which site cards are flipped to their competition-analysis back face.
  const [flipped, setFlipped] = useState({});
  const toggleFlip = useCallback((id) => setFlipped((f) => ({ ...f, [id]: !f[id] })), []);

  const loadSites = useCallback(async () => {
    const { sites } = await api('/api/sites');
    setSites(sites);
  }, []);

  const [social, setSocial] = useState(null);
  const loadSocial = useCallback(async () => {
    try {
      setSocial(await api('/api/social'));
    } catch {
      /* section simply hides until social data exists */
    }
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
        await Promise.all([loadSites(), loadLog(), loadRecipients(), loadSocial()]);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadSites, loadLog, loadRecipients, loadSocial]);

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

  // ---- filters (country + operators/retailers) ----
  const countries = useMemo(() => Array.from(new Set(sites.map((s) => s.region))).sort(), [sites]);
  // Card order: operators first, then retailers, each grouped by country
  // (alphabetical) and by name within a country. Grouping same-type sites
  // together also keeps grid rows at similar heights (operator cards carry
  // fewer metrics than retailer cards).
  const visible = useMemo(
    () =>
      sites
        .filter(
          (s) => (countryFilter === 'all' || s.region === countryFilter) && (typeFilter === 'all' || s.type === typeFilter)
        )
        .sort((a, b) => {
          const typeRank = (s) => (s.type === 'operator' ? 0 : 1);
          return (
            typeRank(a) - typeRank(b) ||
            (a.region || '').localeCompare(b.region || '') ||
            (a.name || '').localeCompare(b.name || '')
          );
        }),
    [sites, countryFilter, typeFilter]
  );
  const visibleIds = useMemo(() => new Set(visible.map((s) => s.id)), [visible]);

  // ---- headline KPIs with WoW deltas ----
  const kpis = useMemo(() => {
    // Weighted aggregate share across the FILTERED sites: sum of Samsung
    // counts over sum of totals, now and 7 days ago (from raw history
    // numerators/denominators), so every KPI is a true share, not an average
    // of percentages.
    const aggShare = (sitesArr, nKey, dKey, daysAgo) => {
      let n = 0;
      let d = 0;
      for (const s of sitesArr) {
        const h = s.history || [];
        let entry = null;
        if (daysAgo == null) {
          entry = h[h.length - 1] || null;
        } else if (h.length) {
          const latestTs = new Date(h[h.length - 1].run_at).getTime();
          const cutoff = latestTs - daysAgo * DAY;
          for (const e of h) if (new Date(e.run_at).getTime() <= cutoff && e[dKey]) entry = e;
        }
        if (entry && entry[dKey]) {
          n += entry[nKey] || 0;
          d += entry[dKey];
        }
      }
      return d ? Math.round((n / d) * 1000) / 10 : null;
    };

    return {
      heroShare: aggShare(visible, 'heroN', 'heroD', null),
      heroShareWoW: aggShare(visible, 'heroN', 'heroD', 7),
      shelfShare: aggShare(visible, 'devN', 'devD', null),
      shelfShareWoW: aggShare(visible, 'devN', 'devD', 7),
      searchShare: aggShare(visible, 'searchN', 'searchD', null),
      searchShareWoW: aggShare(visible, 'searchN', 'searchD', 7),
      lastRun: sites.reduce((t, s) => (s.lastRunAt && (!t || s.lastRunAt > t) ? s.lastRunAt : t), null),
    };
  }, [sites, visible]);

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

      {/* ---- filters ---- */}
      <section style={S.filterBar}>
        <div style={S.filterGroup}>
          <span style={S.filterLabel}>Country</span>
          {['all', ...countries].map((c) => (
            <button
              key={c}
              style={{ ...S.filterChip, ...(countryFilter === c ? S.filterChipOn : {}) }}
              onClick={() => setCountryFilter(c)}
            >
              {c === 'all' ? 'All' : c}
            </button>
          ))}
        </div>
        <div style={S.filterGroup}>
          <span style={S.filterLabel}>Type</span>
          {[
            ['all', 'All'],
            ['operator', 'Operators'],
            ['retailer', 'Retailers'],
          ].map(([v, label]) => (
            <button
              key={v}
              style={{ ...S.filterChip, ...(typeFilter === v ? S.filterChipOn : {}) }}
              onClick={() => setTypeFilter(v)}
            >
              {label}
            </button>
          ))}
        </div>
        <span style={S.filterCount}>
          {visible.length} of {sites.length} sites
        </span>
      </section>

      {/* ---- KPI strip: Samsung's aggregate shares across the filtered sites ---- */}
      <section style={S.kpiRow}>
        <div style={S.kpi}>
          <div style={S.kpiLabel}>Share of hero banners</div>
          <div style={S.kpiValue}>{kpis.heroShare == null ? '—' : `${kpis.heroShare}%`}</div>
          <div style={S.kpiChips}>
            <Delta label="WoW" now={kpis.heroShare} then={kpis.heroShareWoW} unit=" pt" />
          </div>
          <div style={S.kpiSub}>Samsung's share of hero-banner slots on the landing pages</div>
        </div>
        <div style={S.kpi}>
          <div style={S.kpiLabel}>Share of shelf</div>
          <div style={S.kpiValue}>{kpis.shelfShare == null ? '—' : `${kpis.shelfShare}%`}</div>
          <div style={S.kpiChips}>
            <Delta label="WoW" now={kpis.shelfShare} then={kpis.shelfShareWoW} unit=" pt" />
          </div>
          <div style={S.kpiSub}>Samsung devices among all devices on the catalog shelves</div>
        </div>
        <div style={S.kpi}>
          <div style={S.kpiLabel}>Share of search</div>
          <div style={S.kpiValue}>{kpis.searchShare == null ? '—' : `${kpis.searchShare}%`}</div>
          <div style={S.kpiChips}>
            <Delta label="WoW" now={kpis.searchShare} then={kpis.searchShareWoW} unit=" pt" />
          </div>
          <div style={S.kpiSub}>Samsung's share of results for common phone searches</div>
        </div>
        <div style={S.kpi}>
          <div style={S.kpiLabel}>Sites monitored</div>
          <div style={S.kpiValue}>{visible.length}</div>
          <div style={S.kpiSub}>{visible.map((s) => s.name).join(' · ')}</div>
        </div>
      </section>

      {/* ---- per-site cards ---- */}
      <section style={S.grid}>
        {visible.map((s) => {
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
          const isFlipped = !!flipped[s.id];
          return (
            // Flip container: front = Samsung metrics, back = competition
            // analysis. The visible face sits in normal flow and sets the
            // height; the hidden face is absolutely positioned and clipped.
            <div key={s.id} style={S.flipOuter}>
              <div style={{ ...S.flipInner, transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }}>
              <div style={{ ...S.card, ...S.flipFace, ...(isFlipped ? S.flipFaceHidden : {}) }}>
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
                {s.competition && s.competition.s26Reviews && (
                  <a
                    href={s.competition.s26Reviews.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ ...S.chipInfo, textDecoration: 'none' }}
                    title="Galaxy S26 Ultra rating on this site"
                  >
                    S26U ★{s.competition.s26Reviews.rating} · {s.competition.s26Reviews.count} reviews
                  </a>
                )}
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
                  <ShelfPositions deviceShare={s.deviceShare} />
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
                <button
                  style={{ ...S.flipBtn, marginLeft: 'auto' }}
                  onClick={() => toggleFlip(s.id)}
                  title="Flip to Samsung vs competitor brand breakdowns"
                >
                  ⇄ Competition
                </button>
              </div>
              </div>

              <div style={{ ...S.flipFace, ...S.flipFaceBack, ...(isFlipped ? {} : S.flipFaceHidden) }}>
                <CompetitionCard site={s} onFlip={() => toggleFlip(s.id)} />
              </div>
              </div>
            </div>
          );
        })}
      </section>

      {/* ---- social share of voice ---- */}
      <SocialSection social={social} visible={visible} />

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
              {log.filter((e) => visibleIds.has(e.site_id)).map((e) => (
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

  filterBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 18,
    flexWrap: 'wrap',
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 12,
    padding: '10px 16px',
    marginBottom: 14,
  },
  filterGroup: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  filterLabel: { fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.04em', marginRight: 2 },
  filterChip: {
    background: '#f8fafc',
    color: '#475569',
    border: '1px solid #e2e8f0',
    borderRadius: 999,
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  filterChipOn: { background: '#1428a0', color: '#fff', borderColor: '#1428a0' },
  filterCount: { marginLeft: 'auto', fontSize: 12, color: '#94a3b8' },
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

  // Card flip (front = metrics, back = competition analysis). The hidden face
  // is absolutely positioned so the visible one drives the card's height.
  flipOuter: { perspective: 1400 },
  flipInner: {
    position: 'relative',
    transformStyle: 'preserve-3d',
    transition: 'transform .55s cubic-bezier(.4,.1,.2,1)',
    height: '100%',
  },
  flipFace: {
    backfaceVisibility: 'hidden',
    WebkitBackfaceVisibility: 'hidden',
    boxSizing: 'border-box',
    // Fill the grid cell (rows stretch to the tallest card) so card borders
    // line up across a row instead of ending at ragged heights.
    height: '100%',
    minHeight: 0,
  },
  flipFaceBack: { transform: 'rotateY(180deg)' },
  flipFaceHidden: { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' },
  flipBtn: {
    background: '#f8fafc',
    color: '#1e3a8a',
    border: '1px solid #dbeafe',
    borderRadius: 999,
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },

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
  sectionHead: { display: 'flex', alignItems: 'baseline', gap: 12, margin: '4px 0 10px', flexWrap: 'wrap' },
  sectionSub: { color: '#94a3b8', fontSize: 12 },
  lbHead: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 },
  lbTitle: { fontSize: 13, fontWeight: 700, color: '#334155' },
  lbSub: { fontSize: 11, color: '#94a3b8' },
  lbRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px', borderRadius: 6 },
  lbRowSamsung: { background: '#eef4ff' },
  lbRank: { width: 14, textAlign: 'right', fontSize: 11, color: '#94a3b8', fontWeight: 700, flexShrink: 0 },
  lbBrand: { width: 68, fontSize: 12, color: '#0f172a', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  lbBarTrack: { flex: 1, height: 9, borderRadius: 999, background: '#f1f5f9', overflow: 'hidden' },
  lbBarFill: { height: '100%', borderRadius: 999 },
  lbNum: { width: 74, textAlign: 'right', fontSize: 12, color: '#0f172a', flexShrink: 0 },
  lbPct: { color: '#94a3b8', fontSize: 11, fontWeight: 500 },
  divLine: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid #f8fafc' },
  shelfHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, gap: 8, flexWrap: 'wrap' },
  shelfTitle: { fontSize: 12, fontWeight: 700, color: '#334155' },
  shelfStats: { fontSize: 11, color: '#64748b' },
  shelfCaption: { fontSize: 10.5, color: '#64748b', marginTop: 5 },
  posChipWrap: { display: 'flex', flexWrap: 'wrap', gap: 3, maxHeight: 92, overflowY: 'auto', padding: '2px 0' },
  posChip: { fontSize: 10, fontWeight: 700, borderRadius: 5, padding: '1.5px 5px', border: '1px solid transparent' },
  posChipPrime: { background: '#ecfdf5', color: '#047857', borderColor: '#a7f3d0' },
  posChipGood: { background: '#eff6ff', color: '#1d4ed8', borderColor: '#bfdbfe' },
  posChipDeep: { background: '#f1f5f9', color: '#64748b', borderColor: '#e2e8f0' },
  posLegendDot: { display: 'inline-block', width: 9, height: 9, borderRadius: 3, verticalAlign: 'middle', border: '1px solid transparent' },
  divName: { width: 118, fontSize: 12, fontWeight: 700, color: '#334155', flexShrink: 0 },
  divRankChip: { flexShrink: 0 },
  divDetail: { fontSize: 11.5, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  divisionHead: {
    fontSize: 11,
    fontWeight: 700,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '.05em',
    borderTop: '1px solid #f1f5f9',
    padding: '8px 0 6px',
  },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#64748b' },
  legendDot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },

  link: { color: '#2563eb', textDecoration: 'none', fontWeight: 600, fontSize: 13 },
  cardFooter: { display: 'flex', gap: 16, borderTop: '1px solid #f1f5f9', paddingTop: 10, marginTop: 'auto' },

  // Social share-of-voice rows
  socialSummary: {
    display: 'flex',
    alignItems: 'center',
    gap: 18,
    flexWrap: 'wrap',
    fontSize: 12.5,
    color: '#475569',
    paddingBottom: 10,
    borderBottom: '1px solid #f1f5f9',
    marginBottom: 6,
  },
  socialFilters: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    paddingBottom: 10,
    marginBottom: 10,
    borderBottom: '1px solid #f1f5f9',
  },
  socialCols: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))', gap: 24, alignItems: 'start' },
  socialRow: { display: 'flex', alignItems: 'center', gap: 14, padding: '9px 6px', borderBottom: '1px solid #f8fafc', borderRadius: 8, cursor: 'pointer' },
  socialSite: { width: 150, flexShrink: 0 },
  socialName: { fontWeight: 700, fontSize: 13 },
  socialPlatforms: { fontSize: 10.5, color: '#94a3b8', marginTop: 2 },
  socialBarWrap: { flex: 1, minWidth: 0 },
  socialBar: { display: 'flex', height: 10, borderRadius: 999, background: '#f1f5f9', overflow: 'hidden' },
  socialSeg: { height: '100%' },
  socialCaption: { fontSize: 11, color: '#64748b', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  socialNums: { textAlign: 'right', width: 56, flexShrink: 0 },
  socialTotal: { fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1 },
  socialRowSelected: { background: '#eef4ff' },
  socialHint: { fontSize: 10.5, color: '#cbd5e1', marginTop: 8 },

  // Social post feed
  feedHead: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, fontWeight: 700, color: '#334155', margin: '1px 0 4px' },
  feedClear: {
    background: '#f8fafc',
    color: '#475569',
    border: '1px solid #e2e8f0',
    borderRadius: 999,
    padding: '2px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    marginLeft: 'auto',
  },
  postRow: { display: 'block', padding: '8px 0', borderBottom: '1px solid #f8fafc', textDecoration: 'none', color: 'inherit' },
  postMeta: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: '#94a3b8' },
  postSite: { fontWeight: 700, color: '#334155', fontSize: 12 },
  postBrand: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: '#64748b' },
  postStats: { marginLeft: 'auto', whiteSpace: 'nowrap' },
  postCaption: { fontSize: 12, color: '#475569', marginTop: 3, lineHeight: 1.5 },
  feedMore: {
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    color: '#475569',
    cursor: 'pointer',
    marginTop: 10,
  },

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
