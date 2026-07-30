'use client';

/**
 * Samsung Visibility Monitor — dashboard.
 *
 * Wired to the standalone Express API in banner-monitor/server.js:
 *   GET  /api/sites        -> latest banner count + device/search shares + 60-run history per site
 *   GET  /api/log          -> recent run events (polled)
 *   GET  /api/social       -> classified social posts since Jan 2026
 *   POST /api/run          -> trigger a run now ("Run check")
 *   GET/PUT /api/recipients -> manage the alert list
 *
 * Design: "Signal Dark" — matched to the Samsung Sentiment dashboard
 * (D:\SamsungSentiment): Inter + Geist Mono, near-black blue surfaces with
 * ambient auroras, glass panels, electric blue->cyan accents, uppercase
 * kickers, icon top-nav. Views:
 *   Home     : stakeholder landing — hero, live counters, quick insights, modules
 *   Websites : ranked table of sites -> per-site drill-down detail
 *   Social   : share-of-voice analytics (Samsung vs named competitors)
 *   Activity : run log + alert recipients
 *
 * Set the API base via NEXT_PUBLIC_BANNER_API (defaults to http://localhost:4000).
 * NOTE: the static loader (public/index.html) injects only these React hooks:
 * useCallback, useEffect, useMemo, useState — don't use others here (no useRef).
 * Keep the syntax ES2019-friendly (no ?. / ??): Babel standalone only transforms JSX.
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

/* ---------- formatting ---------- */

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

// Compact engagement numbers for the social feed (1.2k, 34k).
function fmtCount(n) {
  if (!n) return '0';
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

// 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 11 -> "11th"…
function ordinal(n) {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

const DAY = 86400000;

// Latest value of `key` recorded at or before (latest run - daysAgo).
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

/* ---------- brands & divisions ---------- */

// Brand palette + labels, tuned for light surfaces (Samsung = the signature
// teal of this dashboard's own "tide" palette).
const SAMSUNG = '#0d9488';
const BRAND_META = {
  samsung: { label: 'Samsung', color: SAMSUNG },
  apple: { label: 'Apple', color: '#52525b' },
  xiaomi: { label: 'Xiaomi', color: '#ea580c' },
  honor: { label: 'Honor', color: '#0284c7' },
  huawei: { label: 'Huawei', color: '#dc2626' },
  oppo: { label: 'Oppo', color: '#15803d' },
  vivo: { label: 'vivo', color: '#4f46e5' },
  realme: { label: 'realme', color: '#ca8a04' },
  nothing: { label: 'Nothing', color: '#27272a' },
  google: { label: 'Google', color: '#16a34a' },
  infinix: { label: 'Infinix', color: '#9333ea' },
  tecno: { label: 'Tecno', color: '#c026d3' },
  lg: { label: 'LG', color: '#be123c' },
  tcl: { label: 'TCL', color: '#db2777' },
  hisense: { label: 'Hisense', color: '#65a30d' },
  sony: { label: 'Sony', color: '#475569' },
  bosch: { label: 'Bosch', color: '#991b1b' },
  beko: { label: 'Beko', color: '#2563eb' },
  midea: { label: 'Midea', color: '#0369a1' },
  haier: { label: 'Haier', color: '#1d4ed8' },
  dyson: { label: 'Dyson', color: '#7c3aed' },
  jbl: { label: 'JBL', color: '#c2410c' },
  other: { label: 'Other', color: '#94a3b8' },
};
const brandMeta = (id) => BRAND_META[id] || { label: id, color: '#71717a' };

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

// Sort brand [id, count] entries by count desc — Samsung wins every tie.
const brandSort = (a, b) => b[1] - a[1] || (a[0] === 'samsung' ? -1 : b[0] === 'samsung' ? 1 : 0);

/* ---------- Samsung device families (product filter) ---------- */

// Classified client-side from each stored placement's alt text + link URL.
const DEVICE_FAMILIES = [
  { key: 'sseries', label: 'Galaxy S', re: /galaxy[\s_-]*s\s?\d{2}|\bs\d{2}[\s_-]?(ultra|plus|fe|edge|\+)?\b/i },
  { key: 'foldflip', label: 'Fold & Flip', re: /\bfold|\bflip|galaxy[\s_-]*z\b/i },
  { key: 'aseries', label: 'Galaxy A', re: /galaxy[\s_-]*a\s?\d{2}\b|\ba\d{2}[\s_-]?(5g)?\b/i },
  { key: 'watch', label: 'Watch', re: /galaxy[\s_-]*watch|\bwatch[\s_-]?(\d|ultra|classic|fe)/i },
  { key: 'tab', label: 'Tab', re: /galaxy[\s_-]*tab|\btab[\s_-]?(s\d{1,2}|a\d|active)\b/i },
  { key: 'buds', label: 'Buds', re: /galaxy[\s_-]*buds|\bbuds\b/i },
];

const familyLabel = (key) => {
  const f = DEVICE_FAMILIES.find((x) => x.key === key);
  return f ? f.label : key;
};

const familiesOf = (a) => {
  const text = `${a.alt || ''} ${a.href || ''} ${a.src || ''}`;
  return DEVICE_FAMILIES.filter((f) => f.re.test(text)).map((f) => f.key);
};

// Per-family placement counts across a site's Samsung assets (hero/promo/tiles).
function deviceCountsOf(site) {
  const counts = {};
  const assets = site.assets || {};
  for (const sec of ['hero', 'promo', 'tiles']) {
    for (const a of assets[sec] || []) {
      for (const k of familiesOf(a)) {
        const c = (counts[k] = counts[k] || { total: 0, hero: 0, promo: 0, tiles: 0 });
        c.total++;
        c[sec]++;
      }
    }
  }
  return counts;
}

/* ---------- share math ---------- */

// The five per-site Samsung share metrics, normalized to one shape.
function siteMetrics(s) {
  const pct = (n, d) => (d && n != null ? Math.round((n / d) * 1000) / 10 : null);
  return [
    {
      key: 'hero',
      label: 'Hero banners',
      color: SAMSUNG,
      n: s.count,
      d: s.bannerTotal,
      pct: pct(s.count, s.bannerTotal),
      wow: valueAgo(s.history, 'bannerSharePct', 7),
      mom: valueAgo(s.history, 'bannerSharePct', 30),
      note: 'share of hero-banner slots on the landing page',
    },
    {
      key: 'promo',
      label: 'Promo cards',
      color: '#d97706',
      n: s.promoCount,
      d: s.promoTotal,
      pct: pct(s.promoCount, s.promoTotal),
      wow: valueAgo(s.history, 'promoSharePct', 7),
      mom: valueAgo(s.history, 'promoSharePct', 30),
      note: 'share of promotional cards on the landing page',
    },
    {
      key: 'tiles',
      label: 'Product tiles',
      color: '#db2777',
      n: s.tileCount,
      d: s.tileTotal,
      pct: pct(s.tileCount, s.tileTotal),
      wow: valueAgo(s.history, 'tileSharePct', 7),
      mom: valueAgo(s.history, 'tileSharePct', 30),
      note: 'share of product tiles on the landing page',
    },
    {
      key: 'shelf',
      label: 'Catalog shelf',
      color: '#2563eb',
      n: s.deviceShare ? s.deviceShare.samsung : null,
      d: s.deviceShare ? s.deviceShare.total : null,
      pct: s.deviceShare ? s.deviceShare.sharePct : null,
      wow: valueAgo(s.history, 'deviceSharePct', 7),
      mom: valueAgo(s.history, 'deviceSharePct', 30),
      note: 'Samsung devices among all devices on the catalog shelf',
    },
    {
      key: 'search',
      label: 'Search results',
      color: '#7c3aed',
      n: s.searchShare ? s.searchShare.samsung : null,
      d: s.searchShare ? s.searchShare.total : null,
      pct: s.searchShare ? s.searchShare.sharePct : null,
      wow: valueAgo(s.history, 'searchSharePct', 7),
      mom: valueAgo(s.history, 'searchSharePct', 30),
      note: 'share of results for common phone searches',
    },
  ];
}

// Funnel weights for the visibility score — hero is the premium slot, search
// carries the highest purchase intent. The score renormalizes over whichever
// metrics a site actually has, so operator sites without shelf/search data
// stay comparable.
const SCORE_WEIGHTS = { hero: 30, search: 25, shelf: 20, promo: 15, tiles: 10 };
const SCORE_TIP =
  'Weighted visibility score: hero 30% (position-adjusted) · search 25% · shelf 20% · promo 15% · tiles 10% — renormalized over the metrics measured on this site';

// Carousel rotation drop-off: the first slide gets most of the attention.
// Runs recorded before positions existed count each banner in full.
const slideFactor = (pos) => (pos == null ? 1 : pos === 1 ? 1 : pos === 2 ? 0.6 : 0.4);

// Position-adjusted hero share: each Samsung slide is scaled by its slot's
// attention factor before dividing by the carousel size.
function heroAdjustedPct(s) {
  const heroAssets = (s.assets && s.assets.hero) || [];
  if (!s.bannerTotal || !heroAssets.length) return null;
  const eff = heroAssets.reduce((sum, a) => sum + slideFactor(a.pos), 0);
  return Math.round((eff / s.bannerTotal) * 1000) / 10;
}

// One number that answers "how is this site doing?" — the weighted score
// (previously a plain average of the shares).
function visibilityScore(s) {
  let num = 0;
  let den = 0;
  for (const m of siteMetrics(s)) {
    let v = m.pct;
    if (m.key === 'hero') {
      const adj = heroAdjustedPct(s);
      if (adj != null) v = adj;
    }
    if (v == null) continue;
    num += SCORE_WEIGHTS[m.key] * v;
    den += SCORE_WEIGHTS[m.key];
  }
  return den ? Math.round((num / den) * 10) / 10 : null;
}

// Weighted aggregate share across sites (true share, not average of pcts).
function aggShare(sitesArr, nKey, dKey, daysAgo) {
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
}

/* ---------- icons (lucide-style, matched to the sentiment dashboard) ---------- */

function Icon({ d, children, size }) {
  return (
    <svg
      width={size || 18}
      height={size || 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {d ? <path d={d} /> : null}
      {children}
    </svg>
  );
}
const IconHome = (p) => (
  <Icon size={p && p.size}>
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </Icon>
);
const IconGlobe = (p) => (
  <Icon size={p && p.size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </Icon>
);
const IconMessage = (p) => (
  <Icon size={p && p.size}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M7 8h10" />
    <path d="M7 12h6" />
  </Icon>
);
const IconActivity = (p) => (
  <Icon size={p && p.size}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </Icon>
);
const IconArrow = (p) => (
  <Icon size={p && p.size}>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </Icon>
);
const IconPlay = (p) => (
  <Icon size={p && p.size}>
    <polygon points="6 3 20 12 6 21 6 3" />
  </Icon>
);

/* ---------- atoms ---------- */

// WoW / MoM movement as quiet colored text.
function Move({ label, now, then, unit }) {
  const T = styles;
  if (now == null || then == null) {
    return (
      <span style={T.moveMuted} title={`Not enough history for ${label} yet`}>
        {label} —
      </span>
    );
  }
  const diff = Math.round((now - then) * 10) / 10;
  const up = diff > 0;
  const flat = diff === 0;
  const style = flat ? T.moveFlat : up ? T.moveUp : T.moveDown;
  const arrow = flat ? '•' : up ? '▲' : '▼';
  return (
    <span style={style} title={`${label}: ${then}${unit || ''} → ${now}${unit || ''}`}>
      {label} {arrow} {up ? '+' : ''}
      {diff}
      {unit || ''}
    </span>
  );
}

function Bar({ pct, color }) {
  const T = styles;
  return (
    <div style={T.barTrack}>
      <div style={{ ...T.barFill, width: `${Math.max(0, Math.min(100, pct || 0))}%`, background: color }} />
    </div>
  );
}

// Small translucent tag.
const TAG_TONES = {
  neutral: { background: 'rgba(19,36,32,0.06)', color: '#4d5f5a' },
  blue: { background: 'rgba(13,148,136,0.16)', color: '#0f766e' },
  green: { background: 'rgba(21,128,61,0.14)', color: '#15803d' },
  red: { background: 'rgba(185,28,28,0.14)', color: '#b91c1c' },
  yellow: { background: 'rgba(217,119,6,0.12)', color: '#b45309' },
};
function Tag({ tone, title, children }) {
  const T = styles;
  return (
    <span style={{ ...T.tag, ...(TAG_TONES[tone] || TAG_TONES.neutral) }} title={title}>
      {children}
    </span>
  );
}

// Animated count-up (starts when the value arrives). No useRef in the loader,
// so the run-once guard is plain state.
function Counter({ value, suffix }) {
  const [display, setDisplay] = useState(null);
  useEffect(() => {
    if (value == null) return;
    let raf;
    const t0 = performance.now();
    const dur = 1300;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {value == null || display == null ? '—' : display.toLocaleString() + (suffix || '')}
    </span>
  );
}

/* ---------- charts ---------- */

const TREND_SERIES = [
  { key: 'bannerSharePct', label: 'Hero banners', color: SAMSUNG },
  { key: 'deviceSharePct', label: 'Catalog shelf', color: '#2563eb' },
  { key: 'searchSharePct', label: 'Search', color: '#7c3aed' },
];

const GRID_LINE = 'rgba(19,36,32,0.08)';
const AXIS_TEXT = '#82918c';

// Interactive share-trend chart with hover scrub.
function TrendChart({ title, history }) {
  const T = styles;
  const [hover, setHover] = useState(null);

  const series = TREND_SERIES.filter((sd) => (history || []).some((p) => p[sd.key] != null));
  const pts = (history || []).filter((p) => series.some((sd) => p[sd.key] != null));
  if (!series.length || pts.length < 2) {
    return <div style={T.empty}>Collecting trend data — check back after a few runs.</div>;
  }

  const w = 560;
  const h = 150;
  const padL = 30;
  const padR = 10;
  const padT = 10;
  const padB = 10;
  const maxPct = Math.max(10, ...pts.flatMap((p) => series.map((sd) => p[sd.key] || 0))) * 1.15;
  const x = (i) => padL + (i * (w - padL - padR)) / (pts.length - 1);
  const y = (v) => h - padB - ((v || 0) / maxPct) * (h - padT - padB);
  const line = (key) =>
    pts
      .map((p, i) =>
        p[key] == null
          ? null
          : `${i === 0 || pts[i - 1][key] == null ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`
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
      <div style={T.chartHead}>
        <span style={T.chartTitle}>{title}</span>
        <span style={T.chartHint}>hover to inspect</span>
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
              <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke={GRID_LINE} strokeWidth="1" />
              <text x={padL - 5} y={y(v) + 3} textAnchor="end" fontSize="9" fill={AXIS_TEXT}>
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
                  p[sd.key] != null && <circle key={sd.key} cx={x(i)} cy={y(p[sd.key])} r="2.4" fill={sd.color} />
              )}
            </g>
          ))}
          {hp && (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={padT}
                y2={h - padB}
                stroke="#9aa1b5"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              {series.map(
                (sd) =>
                  hp[sd.key] != null && (
                    <circle key={sd.key} cx={x(hover)} cy={y(hp[sd.key])} r="4" fill={sd.color} stroke="#ffffff" strokeWidth="1.5" />
                  )
              )}
            </g>
          )}
        </svg>
        {hp && (
          <div
            style={{
              ...T.tooltip,
              left: `${(x(hover) / w) * 100}%`,
              transform: x(hover) > w * 0.55 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
          >
            <div style={T.tooltipDate}>{fmtTime(hp.run_at)}</div>
            {series.map(
              (sd) =>
                hp[sd.key] != null && (
                  <div key={sd.key} style={T.tooltipRow}>
                    <i style={{ ...T.dot, background: sd.color }} /> {sd.label}: <strong>{hp[sd.key]}%</strong>
                  </div>
                )
            )}
          </div>
        )}
      </div>
      <div style={T.legendRow}>
        {series.map((sd) => (
          <span key={sd.key} style={T.legendItem}>
            <i style={{ ...T.dot, background: sd.color }} /> {sd.label}
          </span>
        ))}
        <span style={{ ...T.legendItem, marginLeft: 'auto', color: AXIS_TEXT }}>
          {fmtTime(pts[0].run_at)} – {fmtTime(pts[pts.length - 1].run_at)}
        </span>
      </div>
    </div>
  );
}

// Multi-brand share trend, Samsung always included.
function CompetitionTrend({ site, field, title }) {
  const T = styles;
  const [hover, setHover] = useState(null);
  const pts = (site.history || [])
    .filter((h) => h[field])
    .map((h) => ({ run_at: h.run_at, brands: h[field] }));
  if (pts.length < 2) return <div style={T.empty}>{title} trend appears after a few daily checks.</div>;

  const latest = pts[pts.length - 1].brands;
  const brands = Object.entries(latest)
    .sort(brandSort)
    .slice(0, 5)
    .map(([b]) => b);
  if (!brands.includes('samsung') && latest.samsung != null) brands.splice(4, 1, 'samsung');

  const w = 560;
  const h = 150;
  const padL = 30;
  const padR = 10;
  const padT = 10;
  const padB = 10;
  const maxPct = Math.max(10, ...pts.flatMap((p) => brands.map((b) => p.brands[b] || 0))) * 1.15;
  const x = (i) => padL + (i * (w - padL - padR)) / (pts.length - 1);
  const y = (v) => h - padB - ((v || 0) / maxPct) * (h - padT - padB);
  const line = (b) =>
    pts
      .map((p, i) => {
        const v = p.brands[b];
        return v == null ? null : `${i === 0 || pts[i - 1].brands[b] == null ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
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
    <div style={{ marginTop: 6 }}>
      <div style={T.chartHead}>
        <span style={T.chartTitle}>{title} — top brands (%)</span>
        <span style={T.chartHint}>hover to inspect</span>
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
              <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke={GRID_LINE} strokeWidth="1" />
              <text x={padL - 5} y={y(v) + 3} textAnchor="end" fontSize="9" fill={AXIS_TEXT}>
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
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={h - padB} stroke="#9aa1b5" strokeWidth="1" strokeDasharray="3 3" />
          )}
        </svg>
        {hp && (
          <div
            style={{
              ...T.tooltip,
              left: `${(x(hover) / w) * 100}%`,
              transform: x(hover) > w * 0.55 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
          >
            <div style={T.tooltipDate}>{fmtTime(hp.run_at)}</div>
            {brands
              .filter((b) => hp.brands[b] != null)
              .sort((a, b) => hp.brands[b] - hp.brands[a] || (a === 'samsung' ? -1 : b === 'samsung' ? 1 : 0))
              .map((b) => (
                <div key={b} style={T.tooltipRow}>
                  <i style={{ ...T.dot, background: brandMeta(b).color }} /> {brandMeta(b).label}:{' '}
                  <strong>{hp.brands[b]}%</strong>
                </div>
              ))}
          </div>
        )}
      </div>
      <div style={{ ...T.legendRow, flexWrap: 'wrap' }}>
        {brands.map((b) => (
          <span key={b} style={T.legendItem}>
            <i style={{ ...T.dot, background: brandMeta(b).color }} /> {brandMeta(b).label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Posting-chart palette, exec-report style: Samsung owns the only saturated
// color (its brand blue), competitors recede into graduated slate grays — the
// chart reads as "blue = Samsung's share of the conversation" at a glance,
// with the legend naming each gray. Index follows the chart's rival order.
const CHART_SAMSUNG = '#1428a0';
const RIVAL_CHART_COLORS = ['#64748b', '#94a3b8', '#c3ccd6', '#374151'];
const rivalChartColor = (i) => RIVAL_CHART_COLORS[((i % RIVAL_CHART_COLORS.length) + RIVAL_CHART_COLORS.length) % RIVAL_CHART_COLORS.length];

// Stacked posting-volume columns: Samsung at the base, each named competitor
// above in its chart color; % on top = Samsung's share of the brand
// conversation. Weekly view = last 13 weeks.
function PostingChart({ posts, bucket, title, rivals }) {
  const T = styles;
  const startOfWeek = (iso) => {
    const d = new Date(iso);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
    return d.toISOString().slice(0, 10);
  };
  const keyOf = bucket === 'week' ? (p) => startOfWeek(p.at) : (p) => String(p.at).slice(0, 7);
  const labelOf =
    bucket === 'week'
      ? (k) => new Date(`${k}T00:00:00Z`).toLocaleString(undefined, { day: 'numeric', month: 'short' })
      : (k) => new Date(`${k}-01T00:00:00Z`).toLocaleString(undefined, { month: 'short' });

  const buckets = {};
  for (const p of posts) {
    const key = keyOf(p);
    const m = (buckets[key] = buckets[key] || { samsung: 0, byRival: {} });
    if (p.samsung) {
      m.samsung++;
    } else {
      const b = (p.brands || []).find((x) => rivals.includes(x));
      if (b) m.byRival[b] = (m.byRival[b] || 0) + 1;
    }
  }
  let keys = Object.keys(buckets).sort();
  if (bucket === 'week') keys = keys.slice(-13);
  if (keys.length < 2) {
    return <div style={T.empty}>Not enough data in this selection for a {bucket}-by-{bucket} view.</div>;
  }
  const shown = (m) => m.samsung + rivals.reduce((n, b) => n + (m.byRival[b] || 0), 0);
  const max = Math.max(1, ...keys.map((k) => shown(buckets[k])));
  const H = 120;
  const px = (n) => Math.round((n / max) * H);

  return (
    <div>
      <div style={T.chartHead}>
        <span style={T.chartTitle}>{title}</span>
        <span style={T.chartHint}>% = Samsung vs competitors</span>
      </div>
      <div style={T.colRow}>
        {keys.map((k) => {
          const m = buckets[k];
          const total = shown(m);
          const sov = total ? Math.round((m.samsung / total) * 100) : null;
          const label = labelOf(k);
          const parts = [
            `Samsung ${m.samsung}`,
            ...rivals.filter((b) => m.byRival[b]).map((b) => `${brandMeta(b).label} ${m.byRival[b]}`),
          ];
          return (
            <div key={k} style={T.col} title={`${bucket === 'week' ? 'Week of ' : ''}${label}: ${parts.join(' · ')}`}>
              <div style={T.colPct}>{sov == null ? '–' : `${sov}%`}</div>
              <div style={{ ...T.colBar, height: Math.max(px(total), 3) }}>
                {rivals
                  .slice()
                  .reverse()
                  .map(
                    (b) =>
                      m.byRival[b] > 0 && (
                        <div key={b} style={{ background: rivalChartColor(rivals.indexOf(b)), height: px(m.byRival[b]) }} />
                      )
                  )}
                <div style={{ background: CHART_SAMSUNG, height: px(m.samsung) }} />
              </div>
              <div style={T.colLabel}>{label}</div>
              <div style={T.colTotal}>{total}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- site detail pieces ---------- */

function ShelfPositions({ deviceShare }) {
  const T = styles;
  const pos = (deviceShare && deviceShare.positions) || [];
  const total = (deviceShare && deviceShare.total) || 0;
  if (!pos.length || !total) return null;
  const sorted = pos.slice().sort((a, b) => a - b);
  const first = sorted[0];
  const median = sorted[Math.floor(sorted.length / 2)];
  const chipStyle = (p) => (p <= 10 ? T.posPrime : p <= 24 ? T.posGood : T.posDeep);
  const zones = [
    { label: 'top 10', style: T.posPrime, n: sorted.filter((p) => p <= 10).length },
    { label: '11–24', style: T.posGood, n: sorted.filter((p) => p > 10 && p <= 24).length },
    { label: 'deeper', style: T.posDeep, n: sorted.filter((p) => p > 24).length },
  ];
  return (
    <div>
      <div style={T.blockHead}>
        <span style={T.blockTitle}>Shelf positions ({sorted.length} of {total} slots)</span>
        <span style={T.blockMeta}>
          first at #{first} · half beyond #{median}
        </span>
      </div>
      <div style={T.posWrap}>
        {sorted.map((p) => (
          <span key={p} style={{ ...T.pos, ...chipStyle(p) }}>
            #{p}
          </span>
        ))}
      </div>
      <div style={T.blockCaption}>
        {zones
          .filter((z) => z.n > 0)
          .map((z) => (
            <span key={z.label} style={{ marginRight: 12 }}>
              <span style={{ ...T.posDot, ...z.style }} /> {z.label}: <strong>{z.n}</strong>
            </span>
          ))}
      </div>
    </div>
  );
}

function TermChips({ searchShare }) {
  const T = styles;
  if (!searchShare || !Array.isArray(searchShare.results) || searchShare.results.length < 2) return null;
  return (
    <div style={T.termRow}>
      {searchShare.results.map((r, i) =>
        r.error ? (
          <Tag key={i} tone="red" title={r.error}>
            “{r.term}” failed
          </Tag>
        ) : (
          <Tag key={i} tone="green" title={`${r.samsung} of ${r.total} results are Samsung`}>
            “{r.term}” {r.sharePct}%
          </Tag>
        )
      )}
    </div>
  );
}

function BrandBoard({ title, data, subtitle }) {
  const T = styles;
  const entries = Object.entries(data || {}).filter(([b]) => b !== 'other');
  const otherN = (data && data.other) || 0;
  const total = entries.reduce((n, [, v]) => n + v, 0) + otherN;
  if (!total) return null;
  if (!entries.length) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={T.blockHead}>
          <span style={T.blockTitle}>{title}</span>
          <span style={T.blockMeta}>no branded placements among {total}</span>
        </div>
      </div>
    );
  }
  entries.sort(brandSort);
  const top = entries.slice(0, 5);
  const restN = entries.slice(5).reduce((n, [, v]) => n + v, 0) + otherN;
  const max = top[0][1];

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={T.blockHead}>
        <span style={T.blockTitle}>{title}</span>
        {subtitle && <span style={T.blockMeta}>{subtitle}</span>}
      </div>
      {top.map(([b, n], i) => {
        const meta = brandMeta(b);
        const pctV = Math.round((n / total) * 1000) / 10;
        const isSamsung = b === 'samsung';
        return (
          <div key={b} style={{ ...T.boardRow, ...(isSamsung ? T.boardRowHi : {}) }}>
            <span style={T.boardRank}>{i + 1}</span>
            <span style={{ ...T.boardBrand, fontWeight: isSamsung ? 700 : 500 }}>{meta.label}</span>
            <div style={T.boardTrack}>
              <div style={{ ...T.boardFill, width: `${(n / max) * 100}%`, background: meta.color }} />
            </div>
            <span style={{ ...T.boardNum, fontWeight: isSamsung ? 700 : 500 }}>
              {n} <span style={T.boardPct}>({pctV}%)</span>
            </span>
          </div>
        );
      })}
      {restN > 0 && (
        <div style={{ ...T.boardRow, opacity: 0.5 }}>
          <span style={T.boardRank}>·</span>
          <span style={T.boardBrand}>Others</span>
          <div style={T.boardTrack}>
            <div style={{ ...T.boardFill, width: `${Math.min((restN / max) * 100, 100)}%`, background: '#3f4354' }} />
          </div>
          <span style={T.boardNum}>{restN}</span>
        </div>
      )}
    </div>
  );
}

function DivisionLine({ label, brands }) {
  const T = styles;
  const entries = Object.entries(brands || {}).filter(([b]) => b !== 'other');
  const total = entries.reduce((n, [, v]) => n + v, 0);
  if (!total) return null;
  entries.sort(brandSort);
  const rank = samsungRank(brands);
  const samsungN = brands.samsung || 0;
  const pctV = Math.round((samsungN / total) * 1000) / 10;
  const rival = entries.find(([b]) => b !== 'samsung');
  const rivalTxt = rival ? `${brandMeta(rival[0]).label} ${rival[1]}` : '';
  const good = rank === 1;
  return (
    <div style={T.divLine}>
      <span style={T.divName}>{label}</span>
      <Tag tone={good ? 'green' : 'yellow'}>{rank ? `#${rank}` : '—'}</Tag>
      <span style={T.divDetail}>
        Samsung {samsungN}/{total} ({pctV}%)
        {rivalTxt ? ` · ${good ? 'next' : 'leader'}: ${rivalTxt}` : ''}
      </span>
    </div>
  );
}

// Samsung placements captured in the last run, grouped by section.
function AssetsSection({ site, productFilter }) {
  const T = styles;
  const filtering = productFilter && productFilter !== 'all';
  const keep = (items) => (filtering ? items.filter((a) => familiesOf(a).includes(productFilter)) : items);
  const sections = [
    { title: 'Hero banners', items: keep((site.assets && site.assets.hero) || []) },
    { title: 'Promo cards', items: keep((site.assets && site.assets.promo) || []) },
    { title: 'Product tiles', items: keep((site.assets && site.assets.tiles) || []) },
  ].filter((sec) => sec.items.length > 0);
  if (!sections.length) {
    return (
      <div style={T.empty}>
        {filtering
          ? `No ${familyLabel(productFilter)} placements captured in the last run.`
          : 'No Samsung placements captured in the last run.'}
      </div>
    );
  }
  return (
    <div>
      {sections.map((sec) => (
        <div key={sec.title} style={{ marginBottom: 16 }}>
          <div style={T.blockHead}>
            <span style={T.blockTitle}>
              {sec.title} <span style={{ color: AXIS_TEXT, fontWeight: 500 }}>({sec.items.length})</span>
            </span>
          </div>
          <div style={T.assetGrid}>
            {sec.items.map((a, i) => (
              <a
                key={i}
                href={a.href || a.src || '#'}
                target="_blank"
                rel="noreferrer"
                style={T.assetCard}
                title={a.alt || a.href || a.src}
              >
                {a.src ? (
                  <img src={a.src} alt={a.alt || ''} style={T.assetImg} loading="lazy" />
                ) : (
                  <div style={T.assetNoImg}>link-only placement</div>
                )}
                <div style={T.assetLabel}>{a.alt || (a.href || a.src || '').split('/').filter(Boolean).pop()}</div>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Websites view ---------- */

function SiteTable({ sites, deviceFilter, deviceCounts, onOpen }) {
  const T = styles;
  // Column sorting: click a metric header to sort by it (desc, click again
  // for asc); null = the incoming default ranking (avg share).
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('desc');
  // With a device family selected, the placement columns (hero/promo/tiles)
  // narrow to that family's share of each section. Shelf and search are
  // scraped as totals only, so they have no per-family breakdown.
  const famMode = deviceFilter !== 'all';
  const famName = famMode ? familyLabel(deviceFilter) : null;
  const COLS = [
    {
      key: 'hero',
      label: 'Hero',
      tip: famMode
        ? `${famName} placements as a share of the hero-banner slots on the landing page`
        : "Samsung's share of the hero-banner slots on the site's landing page",
    },
    {
      key: 'promo',
      label: 'Promo',
      tip: famMode
        ? `${famName} placements as a share of the promotional cards on the landing page`
        : "Samsung's share of the promotional cards on the landing page",
    },
    {
      key: 'tiles',
      label: 'Tiles',
      tip: famMode
        ? `${famName} placements as a share of the product tiles on the landing page`
        : "Samsung's share of the product tiles on the landing page",
    },
    {
      key: 'shelf',
      label: 'Shelf',
      tip: famMode
        ? 'The catalog shelf has no per-device breakdown — clear the Device filter to see it'
        : 'Samsung devices among all devices on the catalog shelf (first pages)',
    },
    {
      key: 'search',
      label: 'Search',
      tip: famMode
        ? 'Search results have no per-device breakdown — clear the Device filter to see them'
        : "Samsung's share of the results for common phone searches",
    },
  ];
  const avgTip = famMode
    ? `Weighted ${famName} visibility: hero 30 · promo 15 · tiles 10, renormalized over the sections with data`
    : SCORE_TIP;

  // Precompute every row's values so column sorting is just a comparator.
  let rows = sites.map((s) => {
    const dSel = famMode ? (deviceCounts[s.id] || {})[deviceFilter] : null;
    const dimmed = famMode && !dSel;
    let cells;
    let avg;
    if (famMode) {
      const c = dSel || { hero: 0, promo: 0, tiles: 0 };
      const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
      const fam = {
        hero: pct(c.hero, s.bannerTotal),
        promo: pct(c.promo, s.promoTotal),
        tiles: pct(c.tiles, s.tileTotal),
        shelf: null,
        search: null,
      };
      cells = COLS.map((col) => ({
        key: col.key,
        pct: fam[col.key],
        dir: null,
        na: col.key === 'shelf' || col.key === 'search',
      }));
      let num = 0;
      let den = 0;
      for (const k of ['hero', 'promo', 'tiles']) {
        if (fam[k] == null) continue;
        num += SCORE_WEIGHTS[k] * fam[k];
        den += SCORE_WEIGHTS[k];
      }
      avg = den ? Math.round((num / den) * 10) / 10 : null;
    } else {
      cells = siteMetrics(s).map((m) => ({
        key: m.key,
        pct: m.pct,
        dir: m.pct != null && m.wow != null ? Math.sign(Math.round((m.pct - m.wow) * 10)) : null,
        na: false,
      }));
      avg = visibilityScore(s);
    }
    return { s, dSel, dimmed, cells, avg };
  });

  if (sortKey) {
    const val = (r) => (sortKey === 'avg' ? r.avg : (r.cells.find((cl) => cl.key === sortKey) || {}).pct);
    const mul = sortDir === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // missing values always sink to the bottom
      if (bv == null) return -1;
      return (av - bv) * mul;
    });
  }

  const clickSort = (key, na) => {
    if (na) return;
    if (sortKey === key) setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };
  const sortMark = (key) => (sortKey === key ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '');

  return (
    <div style={T.tableWrap}>
      <table style={T.table}>
        <thead>
          <tr>
            <th style={{ ...T.th, width: 30 }}>#</th>
            <th style={{ ...T.th, textAlign: 'left' }}>Site</th>
            <th
              className="vm-press"
              style={{ ...T.th, textAlign: 'left', width: 180, cursor: 'pointer' }}
              title={`${avgTip} — click to sort`}
              onClick={() => clickSort('avg', false)}
            >
              {famMode ? `${famName} visibility score` : 'Visibility score'}
              {sortMark('avg')}
            </th>
            {COLS.map((c) => {
              const na = famMode && (c.key === 'shelf' || c.key === 'search');
              return (
                <th
                  key={c.key}
                  className={na ? undefined : 'vm-press'}
                  style={{ ...T.th, cursor: na ? 'help' : 'pointer' }}
                  title={na ? c.tip : `${c.tip} — click to sort`}
                  onClick={() => clickSort(c.key, na)}
                >
                  {c.label}
                  {sortMark(c.key)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ s, dSel, dimmed, cells, avg }, i) => {
            return (
              <tr
                key={s.id}
                className="vm-row"
                style={{ ...T.tr, ...(dimmed ? { opacity: 0.35 } : {}) }}
                onClick={() => onOpen(s.id)}
                title={`Open ${s.name}`}
              >
                <td style={{ ...T.td, ...T.tdRank }}>{i + 1}</td>
                <td style={T.td}>
                  <div style={T.tdSite}>{s.name}</div>
                  <div style={T.tdMeta}>
                    {s.region} · {s.type === 'operator' ? 'operator' : 'retailer'}
                    {famMode && dSel
                      ? ` · ${famName}: ${dSel.total} placement${dSel.total === 1 ? '' : 's'}`
                      : ''}
                  </div>
                </td>
                <td style={T.td}>
                  <div style={T.tdAvgRow}>
                    <span style={T.tdAvg}>{avg == null ? '—' : `${avg}%`}</span>
                    <div style={{ flex: 1 }}>
                      <Bar pct={avg} color={SAMSUNG} />
                    </div>
                  </div>
                </td>
                {cells.map((m) => (
                  <td
                    key={m.key}
                    style={{ ...T.td, ...T.tdNum }}
                    title={m.na ? `No per-device breakdown for ${m.key === 'shelf' ? 'the catalog shelf' : 'search results'}` : undefined}
                  >
                    {m.pct == null ? (
                      <span style={{ color: '#a9b6b1' }}>—</span>
                    ) : (
                      <span>
                        {m.pct}%
                        {m.dir != null && m.dir !== 0 && (
                          <span style={{ color: m.dir > 0 ? '#15803d' : '#b91c1c', fontSize: 10, marginLeft: 3 }}>
                            {m.dir > 0 ? '▲' : '▼'}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Full drill-down page for one site. The product chips filter the captured
// placements below (names only — no counts).
function SiteDetail({ site, onBack }) {
  const T = styles;
  const [product, setProduct] = useState('all');
  // One flip for the whole overview: both cards rotate together — metrics ->
  // brand leaderboards, trends -> competition-over-time — so a single click
  // shows the complete competition picture.
  const [flipped, setFlipped] = useState(false);
  const metrics = siteMetrics(site);
  const avg = visibilityScore(site);
  const dCounts = deviceCountsOf(site);
  const present = DEVICE_FAMILIES.filter((f) => dCounts[f.key]);
  // Where Samsung's hero banners sit in the carousel (1 = the slide shown
  // first). `pos` is recorded by the scraper per placement; older runs
  // without it simply show nothing.
  const heroSlots = ((site.assets && site.assets.hero) || [])
    .map((a) => a.pos)
    .filter((n) => n != null)
    .sort((a, b) => a - b);
  const c = site.competition || {};
  const placements = mergeBrandMaps(c.hero, c.promo, c.tiles);
  const divisions = Object.entries(c.divisions || {}).filter(([, brands]) => Object.keys(brands).length >= 2);
  const hasCompetition =
    Object.keys(placements).length ||
    (c.devices && Object.keys(c.devices).length) ||
    (c.search && Object.keys(c.search).length);

  return (
    <div className="vm-enter">
      <button className="vm-press" style={T.backLink} onClick={onBack}>
        ← All partner sites
      </button>

      <div style={T.detailHead}>
        <div>
          <h1 style={T.detailTitle}>{site.name}</h1>
          <div style={T.detailMeta}>
            {site.region} · {site.type === 'operator' ? 'operator' : 'retailer'} · last run{' '}
            {fmtTime(site.lastRunAt)} ·{' '}
            <a href={site.url} target="_blank" rel="noreferrer" style={T.link}>
              open site ↗
            </a>
          </div>
          {c.s26Reviews && (
            <div style={{ marginTop: 10 }}>
              <a href={c.s26Reviews.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                <Tag tone="yellow" title="Galaxy S26 Ultra rating on this site">
                  S26 Ultra ★{c.s26Reviews.rating} · {c.s26Reviews.count} reviews
                </Tag>
              </a>
            </div>
          )}
        </div>
        <div style={T.detailAvg} title={SCORE_TIP}>
          <div style={T.detailAvgNum}>{avg == null ? '—' : `${avg}%`}</div>
          <div style={T.detailAvgLabel}>visibility score</div>
        </div>
      </div>

      {/* one unified switch: flips both cards together */}
      <div style={T.viewToggleRow}>
        <button
          className="vm-press"
          style={{ ...T.chip, ...(!flipped ? T.chipOn : {}) }}
          onClick={() => setFlipped(false)}
        >
          Samsung overview
        </button>
        <button
          className="vm-press"
          style={{ ...T.chip, ...(flipped ? T.chipOn : {}) }}
          onClick={() => setFlipped(true)}
        >
          Competition analysis
        </button>
      </div>

      <div style={T.detailGrid}>
        <div style={T.flipOuter}>
          <div style={{ ...T.flipInner, transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }}>
            {/* front: Samsung metrics */}
            <div style={{ ...T.panel, ...T.flipFace, ...(flipped ? T.flipHidden : {}) }}>
              <div style={T.panelTitle}>Samsung's share, metric by metric</div>
              {metrics.map((m) =>
            m.pct == null && m.d == null ? null : (
              <div key={m.key} style={T.metricRow}>
                <div style={T.metricTop}>
                  <span style={T.metricLabel} title={m.note}>
                    {m.label}
                  </span>
                  <span style={T.metricVal}>
                    <span style={T.metricFrac}>
                      {m.n == null ? '—' : m.n}/{m.d == null ? '—' : m.d}
                    </span>
                    <strong style={{ color: m.color, marginLeft: 8 }}>{m.pct == null ? '—' : `${m.pct}%`}</strong>
                  </span>
                </div>
                <Bar pct={m.pct} color={m.color} />
                <div style={T.metricMoves}>
                  <Move label="WoW" now={m.pct} then={m.wow} unit="%" />
                  <Move label="MoM" now={m.pct} then={m.mom} unit="%" />
                  {m.key === 'hero' && heroSlots.length > 0 && (
                    <Tag
                      tone={heroSlots[0] === 1 ? 'green' : 'neutral'}
                      title="Where Samsung's banners sit in the hero carousel — 1st is the slide visitors see before any rotation"
                    >
                      Hero banner position: {heroSlots.map(ordinal).join(' & ')}
                    </Tag>
                  )}
                  {m.key === 'shelf' && site.deviceShare && site.deviceShare.pages > 1 && (
                    <span style={T.moveMuted}>first {site.deviceShare.pages} pages</span>
                  )}
                  {m.key === 'search' && site.searchShare && site.searchShare.kind === 'facet' && (
                    <span style={T.moveMuted}>brand facet</span>
                  )}
                </div>
              </div>
            )
          )}
              <TermChips searchShare={site.searchShare} />
            </div>

            {/* back: competition brand leaderboards */}
            <div style={{ ...T.panel, ...T.flipFace, ...T.flipBack, ...(flipped ? {} : T.flipHidden) }}>
              <div style={T.panelTitle}>Samsung vs rival brands</div>
              {!hasCompetition && (
                <div style={T.empty}>
                  No competition data captured yet — brand breakdowns appear after the next check.
                </div>
              )}
              {hasCompetition ? (
                <div>
                  <div style={T.compHead}>Homepage placements</div>
                  <BrandBoard title="Hero banners" data={c.hero} />
                  <BrandBoard title="Promo cards" data={c.promo} />
                  <BrandBoard title="Product tiles" data={c.tiles} />
                  {c.search && <BrandBoard title="Search results" subtitle="common phone searches" data={c.search} />}
                  {divisions.length > 0 && (
                    <div>
                      <div style={T.compHead}>Position by division</div>
                      {divisions.map(([div, brands]) => (
                        <DivisionLine key={div} label={DIVISION_LABELS[div] || div} brands={brands} />
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div style={T.flipOuter}>
          <div style={{ ...T.flipInner, transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }}>
            {/* front: Samsung trends + shelf positions */}
            <div style={{ ...T.panel, ...T.flipFace, ...(flipped ? T.flipHidden : {}) }}>
              <div style={T.panelTitle}>Trends & shelf positions</div>
              <TrendChart title="Samsung share over time (%)" history={site.history} />
              {site.deviceShare && Array.isArray(site.deviceShare.positions) && site.deviceShare.positions.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <ShelfPositions deviceShare={site.deviceShare} />
                </div>
              )}
            </div>

            {/* back: competition over time */}
            <div style={{ ...T.panel, ...T.flipFace, ...T.flipBack, ...(flipped ? {} : T.flipHidden) }}>
              <div style={T.panelTitle}>Competition over time</div>
              {!hasCompetition && (
                <div style={T.empty}>
                  No competition data captured yet — brand trends appear after the next check.
                </div>
              )}
              {hasCompetition ? (
                <div>
                  {c.devices && <BrandBoard title="Device catalog" subtitle="first pages" data={c.devices} />}
                  <CompetitionTrend site={site} field="placementBrands" title="Homepage placements" />
                  {c.devices && <CompetitionTrend site={site} field="catalogBrands" title="Device catalog" />}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* placements gallery with a product filter (names only) */}
      <div style={{ ...T.panel, marginTop: 18 }}>
        <div style={{ ...T.panelTitle, marginBottom: 10 }}>Captured placements</div>
        {present.length > 0 && (
          <div style={T.productRow}>
            <span style={T.filterLabel}>Product</span>
            <button
              className="vm-press"
              style={{ ...T.chip, ...(product === 'all' ? T.chipOn : {}) }}
              onClick={() => setProduct('all')}
            >
              All
            </button>
            {present.map((f) => (
              <button
                key={f.key}
                className="vm-press"
                style={{ ...T.chip, ...(product === f.key ? T.chipOn : {}) }}
                onClick={() => setProduct(product === f.key ? 'all' : f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        <AssetsSection site={site} productFilter={product} />
      </div>

    </div>
  );
}

function SitesView({ sites, deviceCounts, selectedSite, setSelectedSite }) {
  const T = styles;
  const [country, setCountry] = useState('all');
  const [type, setType] = useState('all');
  const [device, setDevice] = useState('all');

  const countries = useMemo(() => Array.from(new Set(sites.map((s) => s.region))).sort(), [sites]);

  const visible = useMemo(() => {
    const famCount = (id) => ((deviceCounts[id] || {})[device] || {}).total || 0;
    // The family's weighted placement score — the same number the score
    // column shows in device-filter mode, so the ranking matches the display.
    const famAvg = (s) => {
      const c = (deviceCounts[s.id] || {})[device];
      if (!c) return null;
      const pct = (n, d) => (d ? (n / d) * 100 : null);
      const fam = { hero: pct(c.hero, s.bannerTotal), promo: pct(c.promo, s.promoTotal), tiles: pct(c.tiles, s.tileTotal) };
      let num = 0;
      let den = 0;
      for (const k of ['hero', 'promo', 'tiles']) {
        if (fam[k] == null) continue;
        num += SCORE_WEIGHTS[k] * fam[k];
        den += SCORE_WEIGHTS[k];
      }
      return den ? num / den : null;
    };
    const rank = (v) => (v == null ? -1 : v);
    return sites
      .filter((s) => (country === 'all' || s.region === country) && (type === 'all' || s.type === type))
      .sort((a, b) => {
        if (device !== 'all') {
          return rank(famAvg(b)) - rank(famAvg(a)) || famCount(b.id) - famCount(a.id);
        }
        return rank(visibilityScore(b)) - rank(visibilityScore(a));
      });
  }, [sites, country, type, device, deviceCounts]);

  const famPlacements = visible.reduce((n, s) => n + (((deviceCounts[s.id] || {})[device] || {}).total || 0), 0);
  const famSites = visible.filter((s) => (((deviceCounts[s.id] || {})[device] || {}).total || 0) > 0).length;

  // Headline KPIs over the sites currently in view (country/type filters apply).
  const kpis = useMemo(() => {
    const ranked = visible
      .map((s) => ({ s, avg: visibilityScore(s) }))
      .filter((r) => r.avg != null)
      .sort((a, b) => b.avg - a.avg);
    return {
      hero: aggShare(visible, 'heroN', 'heroD', null),
      heroWow: aggShare(visible, 'heroN', 'heroD', 7),
      shelf: aggShare(visible, 'devN', 'devD', null),
      shelfWow: aggShare(visible, 'devN', 'devD', 7),
      search: aggShare(visible, 'searchN', 'searchD', null),
      searchWow: aggShare(visible, 'searchN', 'searchD', 7),
      best: ranked[0] || null,
    };
  }, [visible]);

  const detail = selectedSite ? sites.find((s) => s.id === selectedSite) : null;
  if (detail) {
    return <SiteDetail site={detail} onBack={() => setSelectedSite(null)} />;
  }

  const chip = (val, cur, set, label) => (
    <button
      key={val}
      className="vm-press"
      style={{ ...T.chip, ...(cur === val ? T.chipOn : {}) }}
      onClick={() => set(val)}
    >
      {label}
    </button>
  );

  return (
    <div className="vm-enter">
      <div style={T.kicker}>Partner Sites</div>
      <h1 style={T.pageTitle}>Partner site visibility</h1>
      <p style={T.pageSub}>
        Samsung's share of hero banners, promo cards, product tiles, catalog shelf and search on each partner site.
        Ranked by visibility score — click a site for the full breakdown, or a column header to sort by that metric.
      </p>

      {/* headline KPIs over the sites in view */}
      <div style={T.statRow}>
        <div className="vm-enter" style={T.stat}>
          <div style={T.statLabel}>Share of hero banners</div>
          <div style={T.statValueRow}>
            <div style={T.statValue}>{kpis.hero == null ? '—' : `${kpis.hero}%`}</div>
            <Move label="WoW" now={kpis.hero} then={kpis.heroWow} unit="%" />
          </div>
          <div style={T.statSub}>Samsung's share of hero-banner slots across the sites in view</div>
        </div>
        <div className="vm-enter" style={{ ...T.stat, animationDelay: '45ms' }}>
          <div style={T.statLabel}>Share of catalog shelf</div>
          <div style={T.statValueRow}>
            <div style={T.statValue}>{kpis.shelf == null ? '—' : `${kpis.shelf}%`}</div>
            <Move label="WoW" now={kpis.shelf} then={kpis.shelfWow} unit="%" />
          </div>
          <div style={T.statSub}>Samsung devices among all devices on the catalog shelves</div>
        </div>
        <div className="vm-enter" style={{ ...T.stat, animationDelay: '90ms' }}>
          <div style={T.statLabel}>Share of search results</div>
          <div style={T.statValueRow}>
            <div style={T.statValue}>{kpis.search == null ? '—' : `${kpis.search}%`}</div>
            <Move label="WoW" now={kpis.search} then={kpis.searchWow} unit="%" />
          </div>
          <div style={T.statSub}>Samsung's share of results for common phone searches</div>
        </div>
        <div
          className="vm-enter vm-press"
          style={{ ...T.stat, ...T.statBest, animationDelay: '135ms' }}
          onClick={() => kpis.best && setSelectedSite(kpis.best.s.id)}
          title={kpis.best ? `Open ${kpis.best.s.name}'s full breakdown` : undefined}
        >
          <div style={{ ...T.statLabel, color: '#0f766e' }}>★ Best performer</div>
          <div style={T.statValueRow}>
            <div style={{ ...T.statValue, color: SAMSUNG, fontSize: 27 }}>
              {kpis.best ? kpis.best.s.name : '—'}
            </div>
            {kpis.best && <span style={T.bestPct}>{kpis.best.avg}%</span>}
          </div>
          <div style={T.statSub}>
            {kpis.best ? 'highest visibility score in this view — click to open' : 'no measured sites in this view'}
          </div>
        </div>
      </div>

      <div style={T.filterRow}>
        <span style={T.filterLabel}>Country</span>
        {['all', ...countries].map((cIt) => chip(cIt, country, setCountry, cIt === 'all' ? 'All' : cIt))}
        <span style={{ ...T.filterLabel, marginLeft: 14 }}>Type</span>
        {[
          ['all', 'All'],
          ['operator', 'Operators'],
          ['retailer', 'Retailers'],
        ].map(([v, l]) => chip(v, type, setType, l))}
      </div>
      <div style={T.filterRow}>
        <span style={T.filterLabel}>Device</span>
        {[['all', 'All'], ...DEVICE_FAMILIES.map((f) => [f.key, f.label])].map(([v, l]) => chip(v, device, setDevice, l))}
        <span style={T.filterCount}>
          {device !== 'all'
            ? `${famPlacements} ${familyLabel(device)} placement${famPlacements === 1 ? '' : 's'} on ${famSites} of ${visible.length} sites`
            : `${visible.length} site${visible.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <SiteTable sites={visible} deviceFilter={device} deviceCounts={deviceCounts} onOpen={setSelectedSite} />
      <div style={T.footnote}>
        Counts are selector-based and tuned per site · WoW/MoM movement needs 7/30 days of history · a dimmed row has no
        placements for the selected device family.
      </div>
    </div>
  );
}

/* ---------- Social view ---------- */

const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' };

const SOCIAL_PERIODS = [
  ['all', 'Since Jan 2026'],
  ['90', 'Last 90 days'],
  ['30', 'Last 30 days'],
  ['7', 'Last 7 days'],
];
const SOCIAL_PLATFORMS = [['all', 'All platforms'], ...Object.entries(PLATFORM_LABELS)];
const SOCIAL_CONTENT = [
  ['all', 'All posts'],
  ['samsung', 'Samsung posts'],
  ['competitor', 'Competitor posts'],
  ['s26', 'Galaxy S26'],
];
const FEED_PAGE = 8;

// Launch products the spotlight KPI can switch between. S26 uses the
// backend's classification of the full caption; the others are matched
// client-side against the stored caption snippet.
const SPOTLIGHT_PRODUCTS = [
  { key: 's26', label: 'S26', full: 'Galaxy S26 series', match: (p) => !!p.s26 },
  {
    key: 'fold8',
    label: 'Fold8/Flip8',
    full: 'Fold8, Fold8 Ultra & Flip8',
    re: /(?:z\s*)?fold\s?8(?:\s*ultra)?|(?:z\s*)?flip\s?8/i,
  },
  { key: 'watch9', label: 'Watch9', full: 'Galaxy Watch9', re: /watch\s?9(?!\d)/i },
  { key: 'watchu2', label: 'Watch Ultra2', full: 'Galaxy Watch Ultra 2', re: /watch\s?ultra\s?2(?!\d)/i },
];
const spotlightHit = (sp, p) => (sp.match ? sp.match(p) : sp.re.test(p.caption || ''));

function CompanyRow({ rank, s, selected, onSelect }) {
  const T = styles;
  const samsungPct = s.total ? Math.round((s.samsung / s.total) * 1000) / 10 : 0;
  const rivals = Object.entries(s.rivalBrands || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const topRival = rivals[0] || null;
  const topRivalPct = topRival ? Math.round((topRival[1] / s.total) * 1000) / 10 : 0;
  const lead = Math.round((samsungPct - topRivalPct) * 10) / 10;
  const platforms = ['instagram', 'tiktok', 'facebook']
    .map((pf) => (s.samsungByPf[pf] ? `${PLATFORM_LABELS[pf]} ${s.samsungByPf[pf]}` : null))
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className="vm-row"
      style={{ ...T.socialRow, ...(selected ? T.socialRowOn : {}) }}
      onClick={onSelect}
      title={selected ? 'Feed is focused on this company — click to show all' : "Click to see this company's Samsung posts"}
    >
      <span style={T.boardRank}>{rank}</span>
      <div style={T.socialSite}>
        <div style={T.socialName}>{s.name}</div>
        <div style={T.socialMeta}>{platforms ? `Samsung posts: ${platforms}` : 'no Samsung posts in this selection'}</div>
      </div>
      <div style={T.socialBarWrap}>
        <Bar pct={samsungPct} color={SAMSUNG} />
        <div style={T.socialCaption}>
          <strong>{s.samsung}</strong> of {s.total} posts feature Samsung (<strong>{samsungPct}%</strong>)
        </div>
        {rivals.length > 0 && (
          <div style={T.socialRivals}>
            <span style={{ color: AXIS_TEXT }}>Competitors:</span>
            {rivals.map(([b, n]) => (
              <span key={b} style={T.brandChip}>
                <i style={{ ...T.dot, background: brandMeta(b).color }} /> {brandMeta(b).label}{' '}
                {Math.round((n / s.total) * 1000) / 10}%
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={T.socialLead}>
        <div
          style={{ ...T.socialLeadNum, color: lead > 0 ? '#15803d' : lead < 0 ? '#b91c1c' : '#5c6b66' }}
          title={
            topRival
              ? `Samsung ${samsungPct}% vs ${brandMeta(topRival[0]).label} ${topRivalPct}% of this company's posts`
              : `Samsung ${samsungPct}% — no competitor mentions here`
          }
        >
          {lead > 0 ? '+' : ''}
          {lead}%
        </div>
        <div style={T.socialLeadLabel}>{topRival ? `vs ${brandMeta(topRival[0]).label}` : 'no rivals'}</div>
      </div>
    </div>
  );
}

function SocialPost({ p, siteName }) {
  const T = styles;
  const rivals = (p.brands || []).filter((b) => b !== 'samsung').slice(0, 3);
  const stats = [`${fmtCount(p.likes)} likes`, `${fmtCount(p.comments)} comments`];
  if (p.views) stats.push(`${fmtCount(p.views)} views`);
  return (
    <a href={p.url || '#'} target="_blank" rel="noreferrer" style={T.postRow}>
      <div style={T.postMeta}>
        <span style={T.postSite}>{siteName}</span>
        <span>{PLATFORM_LABELS[p.platform] || p.platform}</span>
        <span>{fmtTime(p.at)}</span>
        {p.s26 ? (
          <Tag tone="blue">Galaxy S26</Tag>
        ) : (
          p.samsung && (
            <span style={T.brandChip}>
              <i style={{ ...T.dot, background: SAMSUNG }} /> Samsung
            </span>
          )
        )}
        {rivals.map((b) => (
          <span key={b} style={T.brandChip}>
            <i style={{ ...T.dot, background: brandMeta(b).color }} /> {brandMeta(b).label}
          </span>
        ))}
        <span style={T.postStats}>{stats.join(' · ')}</span>
      </div>
      <div style={T.postCaption}>{p.caption || '(no caption)'}</div>
    </a>
  );
}

function SocialView({ social }) {
  const T = styles;
  const [country, setCountry] = useState('all');
  const [period, setPeriod] = useState('all');
  const [platform, setPlatform] = useState('all');
  const [content, setContent] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [chartSites, setChartSites] = useState(null);
  const [chartRival, setChartRival] = useState(null);
  const [feedSite, setFeedSite] = useState(null);
  const [feedLimit, setFeedLimit] = useState(FEED_PAGE);
  const [spotlight, setSpotlight] = useState('s26'); // product on the spotlight KPI

  const posts = social && Array.isArray(social.posts) ? social.posts : [];
  const socialSites = (social && social.sites) || [];
  const nameOf = useMemo(() => Object.fromEntries(socialSites.map((s) => [s.id, s.name])), [socialSites]);
  const countries = useMemo(() => Array.from(new Set(socialSites.map((s) => s.region))).sort(), [socialSites]);
  const visibleIds = useMemo(
    () => new Set(socialSites.filter((s) => country === 'all' || s.region === country).map((s) => s.id)),
    [socialSites, country]
  );

  const filtered = useMemo(() => {
    const custom = Boolean(from || to);
    const cutoff = !custom && period !== 'all' ? new Date(Date.now() - Number(period) * DAY).toISOString() : null;
    return posts.filter((p) => {
      if (!visibleIds.has(p.site)) return false;
      if (custom) {
        const day = String(p.at).slice(0, 10);
        if (from && day < from) return false;
        if (to && day > to) return false;
      } else if (cutoff && p.at < cutoff) {
        return false;
      }
      return platform === 'all' || p.platform === platform;
    });
  }, [posts, visibleIds, period, platform, from, to]);

  const kpis = useMemo(() => {
    let samsung = 0;
    let s26 = 0;
    const rivalMentions = {};
    for (const p of filtered) {
      if (p.samsung) samsung++;
      if (p.s26) s26++;
      for (const b of p.brands || []) if (b !== 'samsung') rivalMentions[b] = (rivalMentions[b] || 0) + 1;
    }
    const rivals = Object.entries(rivalMentions).sort((a, b) => b[1] - a[1]);
    return { total: filtered.length, samsung, s26, topRival: rivals[0] || null, rivals };
  }, [filtered]);

  const rows = useMemo(() => {
    const bySite = {};
    for (const p of filtered) {
      const a = (bySite[p.site] = bySite[p.site] || { total: 0, samsung: 0, s26: 0, samsungByPf: {}, rivalBrands: {} });
      a.total++;
      if (p.samsung) {
        a.samsung++;
        a.samsungByPf[p.platform] = (a.samsungByPf[p.platform] || 0) + 1;
      }
      if (p.s26) a.s26++;
      for (const b of p.brands || []) if (b !== 'samsung') a.rivalBrands[b] = (a.rivalBrands[b] || 0) + 1;
    }
    return socialSites
      .filter((v) => bySite[v.id])
      .map((v) => ({ id: v.id, name: v.name, ...bySite[v.id] }))
      .sort((a, b) => b.samsung / b.total - a.samsung / a.total || b.samsung - a.samsung);
  }, [filtered, socialSites]);

  // Post counts per spotlight product over the current selection.
  const spotlightCounts = useMemo(() => {
    const out = {};
    for (const sp of SPOTLIGHT_PRODUCTS) out[sp.key] = 0;
    for (const p of filtered) {
      for (const sp of SPOTLIGHT_PRODUCTS) if (spotlightHit(sp, p)) out[sp.key]++;
    }
    return out;
  }, [filtered]);

  const chartPosts = useMemo(
    () => (chartSites && chartSites.length ? filtered.filter((p) => chartSites.includes(p.site)) : filtered),
    [filtered, chartSites]
  );

  const chartRivals = useMemo(() => {
    if (chartRival) return [chartRival];
    const counts = {};
    for (const p of chartPosts) {
      if (p.samsung) continue;
      for (const b of p.brands || []) if (b !== 'samsung') counts[b] = (counts[b] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([b]) => b);
  }, [chartPosts, chartRival]);

  const feed = useMemo(
    () =>
      filtered.filter(
        (p) =>
          (!feedSite || p.site === feedSite) &&
          (content === 'all' ||
            (content === 'samsung' && p.samsung) ||
            (content === 'competitor' && !p.samsung && (p.brands || []).some((b) => b !== 'samsung')) ||
            (content === 's26' && p.s26))
      ),
    [filtered, feedSite, content]
  );

  if (!posts.length) {
    return (
      <div className="vm-enter">
        <div style={styles.kicker}>Partner Social Media</div>
        <h1 style={styles.pageTitle}>Share of voice</h1>
        <div style={styles.empty}>No social posts collected yet — this view fills up after the first daily sync.</div>
      </div>
    );
  }

  const sov = kpis.total ? Math.round((kpis.samsung / kpis.total) * 1000) / 10 : 0;
  const oneIn = kpis.samsung ? Math.round(kpis.total / kpis.samsung) : null;
  const chip = (val, cur, set, label) => (
    <button
      key={val}
      className="vm-press"
      style={{ ...T.chip, ...(cur === val ? T.chipOn : {}) }}
      onClick={() => {
        set(val);
        setFeedLimit(FEED_PAGE);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="vm-enter">
      <div style={T.kicker}>Partner Social Media</div>
      <h1 style={T.pageTitle}>Share of voice</h1>
      <p style={T.pageSub}>
        How often each company posts about Samsung on Instagram, TikTok & Facebook — and how Samsung's voice compares
        with named competitors.
      </p>

      <div style={T.filterRow}>
        <span style={T.filterLabel}>Country</span>
        {['all', ...countries].map((cIt) => chip(cIt, country, setCountry, cIt === 'all' ? 'All' : cIt))}
        <span style={{ ...T.filterLabel, marginLeft: 14 }}>Platform</span>
        {SOCIAL_PLATFORMS.map(([v, l]) => chip(v, platform, setPlatform, l))}
      </div>
      <div style={T.filterRow}>
        <span style={T.filterLabel}>Period</span>
        {SOCIAL_PERIODS.map(([v, l]) => (
          <button
            key={v}
            className="vm-press"
            style={{ ...T.chip, ...(period === v && !from && !to ? T.chipOn : {}) }}
            onClick={() => {
              setPeriod(v);
              setFrom('');
              setTo('');
              setFeedLimit(FEED_PAGE);
            }}
          >
            {l}
          </button>
        ))}
        <input
          type="date"
          value={from}
          min={social.since}
          style={{ ...T.dateInput, ...(from ? T.chipOn : {}) }}
          onChange={(e) => {
            setFrom(e.target.value);
            setFeedLimit(FEED_PAGE);
          }}
          title="Or pick any start date"
        />
        <span style={{ color: AXIS_TEXT, fontSize: 11 }}>to</span>
        <input
          type="date"
          value={to}
          min={social.since}
          style={{ ...T.dateInput, ...(to ? T.chipOn : {}) }}
          onChange={(e) => {
            setTo(e.target.value);
            setFeedLimit(FEED_PAGE);
          }}
          title="Or pick any end date"
        />
        {(from || to) && (
          <button
            className="vm-press"
            style={T.chip}
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            clear ✕
          </button>
        )}
        <span style={T.filterCount}>{kpis.total} posts in this selection</span>
      </div>

      <div style={T.statRow}>
        <div className="vm-enter" style={T.stat}>
          <div style={T.statLabel}>Posts analysed</div>
          <div style={T.statValue}>{kpis.total.toLocaleString()}</div>
          <div style={T.statSub}>published by {rows.length} companies on Instagram, TikTok & Facebook</div>
        </div>
        <div className="vm-enter" style={{ ...T.stat, animationDelay: '45ms' }}>
          <div style={T.statLabel}>Samsung share of voice</div>
          <div style={{ ...T.statValue, color: SAMSUNG }}>{sov}%</div>
          <div style={T.statSub}>
            {kpis.samsung} of {kpis.total} posts feature Samsung
            {oneIn > 1 ? ` — about 1 in every ${oneIn} posts` : ''}
          </div>
        </div>
        <div className="vm-enter" style={{ ...T.stat, animationDelay: '90ms' }}>
          <div style={T.statLabel}>Launch spotlight</div>
          <div style={T.spotRow}>
            {SPOTLIGHT_PRODUCTS.map((sp) => (
              <button
                key={sp.key}
                className="vm-press"
                style={{ ...T.spotChip, ...(spotlight === sp.key ? T.spotChipOn : {}) }}
                onClick={() => setSpotlight(sp.key)}
                title={`Count posts mentioning the ${sp.full}`}
              >
                {sp.label}
              </button>
            ))}
          </div>
          <div style={T.statValue}>{spotlightCounts[spotlight]}</div>
          <div style={T.statSub}>
            posts in this selection mentioning the{' '}
            {(SPOTLIGHT_PRODUCTS.find((sp) => sp.key === spotlight) || {}).full}
          </div>
        </div>
        <div className="vm-enter" style={{ ...T.stat, animationDelay: '135ms' }}>
          <div style={T.statLabel}>Loudest competitor</div>
          <div style={T.statValue}>{kpis.topRival ? brandMeta(kpis.topRival[0]).label : '—'}</div>
          <div style={T.statSub}>
            {kpis.topRival
              ? `mentioned in ${kpis.topRival[1]} posts — Samsung's biggest rival for feed space`
              : 'no competitor brand mentions in this selection'}
          </div>
        </div>
      </div>

      <div style={{ ...T.panel, marginBottom: 18 }}>
        <div style={T.pickerRow}>
          <span style={T.filterLabel}>Companies</span>
          <button className="vm-press" style={{ ...T.chip, ...(!chartSites ? T.chipOn : {}) }} onClick={() => setChartSites(null)}>
            All
          </button>
          {rows.map((r) => (
            <button
              key={r.id}
              className="vm-press"
              style={{ ...T.chip, ...(chartSites && chartSites.includes(r.id) ? T.chipOn : {}) }}
              onClick={() =>
                setChartSites((cur) => {
                  const next = new Set(cur || []);
                  if (next.has(r.id)) next.delete(r.id);
                  else next.add(r.id);
                  return next.size ? Array.from(next) : null;
                })
              }
            >
              {r.name}
            </button>
          ))}
        </div>
        <div style={{ ...T.pickerRow, marginBottom: 14 }}>
          <span style={T.filterLabel}>Versus</span>
          <button className="vm-press" style={{ ...T.chip, ...(!chartRival ? T.chipOn : {}) }} onClick={() => setChartRival(null)}>
            All competitors
          </button>
          {kpis.rivals.slice(0, 8).map(([b]) => (
            <button
              key={b}
              className="vm-press"
              style={{ ...T.chip, ...(chartRival === b ? T.chipOn : {}) }}
              onClick={() => setChartRival(chartRival === b ? null : b)}
            >
              {brandMeta(b).label}
            </button>
          ))}
        </div>
        <PostingChart posts={chartPosts} bucket="month" rivals={chartRivals} title="Month by month — Samsung vs competitors" />
        <div style={{ marginTop: 20 }}>
          <PostingChart posts={chartPosts} bucket="week" rivals={chartRivals} title="Week by week — the last 13 weeks" />
        </div>
        <div style={{ ...T.legendRow, flexWrap: 'wrap', marginTop: 12 }}>
          <span style={T.legendItem}>
            <i style={{ ...T.dot, background: CHART_SAMSUNG }} /> Samsung posts
          </span>
          {chartRivals.map((b, i) => (
            <span key={b} style={T.legendItem}>
              <i style={{ ...T.dot, background: rivalChartColor(i) }} /> {brandMeta(b).label} posts
            </span>
          ))}
          <span style={{ ...T.legendItem, marginLeft: 'auto' }}>% = Samsung's share of Samsung + competitor posts</span>
        </div>
      </div>

      <div style={T.socialCols}>
        <div style={T.panel}>
          <div style={T.panelTitle}>
            Who gives Samsung the most voice
            <span style={T.panelSub}>ranked by Samsung's share of their posts</span>
          </div>
          {rows.map((s, i) => (
            <CompanyRow
              key={s.id}
              rank={i + 1}
              s={s}
              selected={feedSite === s.id}
              onSelect={() => {
                const focusing = feedSite !== s.id;
                setFeedSite(focusing ? s.id : null);
                if (focusing) setContent('samsung');
                setFeedLimit(FEED_PAGE);
              }}
            />
          ))}
          <div style={T.footnote}>Click a company to see its Samsung posts in the feed.</div>
        </div>
        <div style={T.panel}>
          <div style={T.panelTitle}>
            The actual posts{feedSite ? ` — ${nameOf[feedSite] || feedSite}` : ''}
            <span style={T.panelSub}>({feed.length})</span>
            {feedSite && (
              <button className="vm-press" style={{ ...T.chip, marginLeft: 'auto' }} onClick={() => setFeedSite(null)}>
                show all ✕
              </button>
            )}
          </div>
          <div style={{ ...T.filterRow, border: 0, padding: 0, margin: '0 0 6px' }}>
            {SOCIAL_CONTENT.map(([v, l]) => chip(v, content, setContent, l))}
          </div>
          {feed.slice(0, feedLimit).map((p) => (
            <SocialPost key={`${p.platform}:${p.id}`} p={p} siteName={nameOf[p.site] || p.site} />
          ))}
          {feed.length === 0 && <div style={T.empty}>No posts match this selection.</div>}
          {feed.length > feedLimit && (
            <button className="vm-press" style={T.moreBtn} onClick={() => setFeedLimit(feedLimit + 20)}>
              Show more ({feed.length - feedLimit} remaining)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Activity view ---------- */

function ActivityView({ log, sites, recipients, recipientText, setRecipientText, saveRecipients, savedNote }) {
  const T = styles;
  const byId = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s.name])), [sites]);
  return (
    <div className="vm-enter">
      <div style={T.kicker}>Activity</div>
      <h1 style={T.pageTitle}>Runs & alerts</h1>
      <p style={T.pageSub}>Every check the monitor ran, newest first — plus who gets alerted when numbers move.</p>
      <div style={T.overviewGrid}>
        <div style={T.panel}>
          <div style={T.panelTitle}>Recent runs</div>
          <table style={T.table}>
            <thead>
              <tr>
                <th style={{ ...T.th, textAlign: 'left' }}>When</th>
                <th style={{ ...T.th, textAlign: 'left' }}>Site</th>
                <th style={T.th}>Banners</th>
                <th style={T.th}>Shelf</th>
                <th style={T.th}>Search</th>
              </tr>
            </thead>
            <tbody>
              {log.map((e) => (
                <tr key={e.id}>
                  <td style={{ ...T.td, fontFamily: MONO, fontSize: 12, color: '#5c6b66' }}>{fmtTime(e.run_at)}</td>
                  <td style={T.td}>{byId[e.site_id] || e.site}</td>
                  <td style={{ ...T.td, ...T.tdNum }}>{e.count}</td>
                  <td style={{ ...T.td, ...T.tdNum, color: '#2563eb' }}>
                    {e.deviceSharePct == null ? '—' : `${e.deviceSharePct}%`}
                  </td>
                  <td style={{ ...T.td, ...T.tdNum, color: '#7c3aed' }}>
                    {e.searchSharePct == null ? '—' : `${e.searchSharePct}%`}
                  </td>
                </tr>
              ))}
              {log.length === 0 && (
                <tr>
                  <td style={T.td} colSpan={5}>
                    No runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={T.panel}>
          <div style={T.panelTitle}>Alert recipients</div>
          <p style={T.help}>
            One email per line (or comma-separated). Alerts fire when a banner count or a Samsung share changes vs the
            previous check.
          </p>
          <textarea
            style={T.textarea}
            value={recipientText}
            onChange={(e) => setRecipientText(e.target.value)}
            rows={6}
            placeholder={'ops@company.com\nlead@company.com'}
          />
          <div style={T.recipFooter}>
            <button className="vm-press" style={T.primaryBtn} onClick={saveRecipients}>
              Save recipients
            </button>
            <span style={T.savedNote}>{savedNote || `${recipients.length} configured`}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Home (landing) view ---------- */

const MODULES = [
  {
    index: '01',
    key: 'sites',
    title: 'Partner Sites',
    icon: IconGlobe,
    description:
      'Samsung visibility on every partner site — hero banners, promo cards, product tiles, catalog shelf and search share, with per-site drill-downs and competition breakdowns.',
    tags: ['11 Partner Sites', '5 Share Metrics', 'Daily Checks'],
  },
  {
    index: '02',
    key: 'social',
    title: 'Partner Social Media',
    icon: IconMessage,
    description:
      "Samsung's share of voice in partner feeds across Instagram, TikTok & Facebook — month-by-month and week-by-week versus named competitors.",
    tags: ['Share of Voice', 'Samsung vs Rivals', '3 Platforms'],
  },
  {
    index: '03',
    key: 'activity',
    title: 'Activity',
    icon: IconActivity,
    description: 'The full run log for every automated check, plus the alert list that gets emailed when a Samsung share moves.',
    tags: ['Run Log', 'Email Alerts'],
  },
];

function HomeView({ sites, social, goTo }) {
  const T = styles;
  const lastRun = sites.reduce((t, s) => (s.lastRunAt && (!t || s.lastRunAt > t) ? s.lastRunAt : t), null);

  const posts = social && Array.isArray(social.posts) ? social.posts : [];
  const soc = (() => {
    let samsung = 0;
    const rivalBrands = new Set();
    for (const p of posts) {
      if (p.samsung) samsung++;
      for (const b of p.brands || []) if (b !== 'samsung') rivalBrands.add(b);
    }
    return { total: posts.length, samsung, brands: rivalBrands.size };
  })();
  const sov = soc.total ? Math.round((soc.samsung / soc.total) * 1000) / 10 : null;

  const stats = [
    {
      label: 'Hero banners',
      now: aggShare(sites, 'heroN', 'heroD', null),
      wow: aggShare(sites, 'heroN', 'heroD', 7),
      note: 'of hero-banner slots on partner landing pages',
    },
    {
      label: 'Catalog shelf',
      now: aggShare(sites, 'devN', 'devD', null),
      wow: aggShare(sites, 'devN', 'devD', 7),
      note: 'of all devices on partner catalog shelves',
    },
    {
      label: 'Search results',
      now: aggShare(sites, 'searchN', 'searchD', null),
      wow: aggShare(sites, 'searchN', 'searchD', 7),
      note: 'of results for common phone searches',
    },
  ];

  const ranked = sites
    .map((s) => ({ s, avg: visibilityScore(s) }))
    .filter((r) => r.avg != null)
    .sort((a, b) => b.avg - a.avg);
  const best = ranked[0] || null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  const rivalCounts = {};
  for (const p of posts) for (const b of p.brands || []) if (b !== 'samsung') rivalCounts[b] = (rivalCounts[b] || 0) + 1;
  const loudest = Object.entries(rivalCounts).sort((a, b) => b[1] - a[1])[0] || null;

  return (
    <div className="vm-enter" style={{ position: 'relative' }}>
      {/* hero */}
      <section style={T.heroWrap}>
        <div style={T.livePill}>
          <span style={T.pingWrap}>
            <span className="vm-ping" style={T.pingHalo} />
            <span style={T.pingDot} />
          </span>
          SAMSUNG GULF · AUTOMATED DAILY · LAST CHECK {fmtTime(lastRun).toUpperCase()}
        </div>
        <h1 style={T.heroTitle}>
          Samsung's retail & OPCO visibility,
          <br />
          <span style={T.heroGradient}>measured every day.</span>
        </h1>
        {/* live counters */}
        <div style={T.counterRow}>
          <div>
            <p style={T.counterValue}>
              <Counter value={sites.length || null} />
            </p>
            <p style={T.counterLabel}>Partner Sites</p>
          </div>
          <div>
            <p style={T.counterValue}>
              <Counter value={soc.brands || null} />
            </p>
            <p style={T.counterLabel}>Rival Brands Tracked</p>
          </div>
        </div>
      </section>

      {/* quick insights for stakeholders */}
      <section>
        <div style={T.kicker}>Performance at a glance</div>
        <div style={T.statRow}>
          {stats.map((st, i) => (
            <div key={st.label} className="vm-enter" style={{ ...T.stat, ...T.statXl, animationDelay: `${i * 45}ms` }}>
              <div style={T.statLabel}>Share of {st.label.toLowerCase()}</div>
              <div style={T.statValueRow}>
                <div style={{ ...T.statValue, ...T.statValueXl }}>{st.now == null ? '—' : `${st.now}%`}</div>
                <Move label="WoW" now={st.now} then={st.wow} unit="%" />
              </div>
              <div style={T.statSub}>Samsung's share {st.note}</div>
            </div>
          ))}
          <div className="vm-enter" style={{ ...T.stat, ...T.statXl, animationDelay: '135ms' }}>
            <div style={T.statLabel}>Social share of voice</div>
            <div style={T.statValueRow}>
              <div style={{ ...T.statValue, ...T.statValueXl, color: SAMSUNG }}>{sov == null ? '—' : `${sov}%`}</div>
            </div>
            <div style={T.statSub}>of all monitored posts feature Samsung</div>
          </div>
        </div>

        {(best || worst || loudest) && (
          <div style={T.insightStrip}>
            {best && (
              <button className="vm-press" style={T.insightItem} onClick={() => goTo('sites', best.s.id)}>
                <span style={T.insightLabel}>Strongest site</span>
                <span style={T.insightValue}>
                  {best.s.name} <strong style={{ color: '#15803d' }}>{best.avg}%</strong>
                </span>
              </button>
            )}
            {worst && (
              <button className="vm-press" style={T.insightItem} onClick={() => goTo('sites', worst.s.id)}>
                <span style={T.insightLabel}>Needs attention</span>
                <span style={T.insightValue}>
                  {worst.s.name} <strong style={{ color: '#b91c1c' }}>{worst.avg}%</strong>
                </span>
              </button>
            )}
            {loudest && (
              <button className="vm-press" style={T.insightItem} onClick={() => goTo('social')}>
                <span style={T.insightLabel}>Loudest competitor</span>
                <span style={T.insightValue}>
                  {brandMeta(loudest[0]).label} <strong style={{ color: AXIS_TEXT }}>{loudest[1]} mentions</strong>
                </span>
              </button>
            )}
          </div>
        )}
      </section>

      {/* modules */}
      <section style={{ marginTop: 46 }}>
        <div style={T.kicker}>Explore the data</div>
        <div style={T.moduleGrid}>
          {MODULES.map((m) => {
            const MIcon = m.icon;
            return (
              <button key={m.key} className="vm-module" style={T.moduleCard} onClick={() => goTo(m.key)}>
                <div style={T.moduleTop}>
                  <span style={T.moduleIcon}>
                    <MIcon size={20} />
                  </span>
                  <span style={T.moduleIndex}>{m.index}</span>
                </div>
                <div style={T.moduleTitle}>{m.title}</div>
                <div style={T.moduleDesc}>{m.description}</div>
                <div style={T.moduleTags}>
                  {m.tags.map((t) => (
                    <Tag key={t} tone="neutral">
                      {t}
                    </Tag>
                  ))}
                </div>
                <span style={T.moduleArrow}>
                  Open <IconArrow size={14} />
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ---------- root ---------- */

// Hash routing (#/home, #/sites, #/sites/<id>, #/social, #/activity) so every
// page has its own URL and the browser back button navigates within the app
// instead of leaving it. Hash-based = no server rewrites needed anywhere.
const VIEWS = ['home', 'sites', 'social', 'activity'];
function parseHash() {
  if (typeof window === 'undefined') return { view: 'home', site: null };
  const h = (window.location.hash || '').replace(/^#\/?/, '');
  const parts = h.split('/');
  const view = VIEWS.includes(parts[0]) ? parts[0] : 'home';
  const site = view === 'sites' && parts[1] ? decodeURIComponent(parts[1]) : null;
  return { view, site };
}

export default function BannerMonitorDashboard() {
  const [sites, setSites] = useState([]);
  const [log, setLog] = useState([]);
  const [social, setSocial] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [recipientText, setRecipientText] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [savedNote, setSavedNote] = useState('');
  const [runNote, setRunNote] = useState('');
  const [view, setView] = useState(() => parseHash().view); // home | sites | social | activity
  const [selectedSite, setSelectedSite] = useState(() => parseHash().site);

  // Navigation writes the hash; the hashchange listener is the single place
  // state updates, so browser back/forward and in-app clicks behave the same.
  const navigate = useCallback((v, siteId) => {
    const next = siteId ? `#/${v}/${encodeURIComponent(siteId)}` : `#/${v}`;
    if (window.location.hash === next) return;
    window.location.hash = next;
  }, []);

  useEffect(() => {
    const onHash = () => {
      const h = parseHash();
      setView(h.view);
      setSelectedSite(h.site);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const loadSites = useCallback(async () => {
    const data = await api('/api/sites');
    setSites(data.sites);
  }, []);

  const loadSocial = useCallback(async () => {
    try {
      setSocial(await api('/api/social'));
    } catch {
      /* view simply stays empty until social data exists */
    }
  }, []);

  const loadLog = useCallback(async () => {
    try {
      const data = await api('/api/log?limit=30');
      setLog(data.events);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadRecipients = useCallback(async () => {
    const data = await api('/api/recipients');
    setRecipients(data.recipients);
    setRecipientText(data.recipients.join('\n'));
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

  const runCheck = useCallback(async () => {
    setRunning(true);
    setError(null);
    setRunNote('');
    try {
      const result = await api('/api/run', { method: 'POST' });
      if (result && result.queued) {
        setRunNote('Check started in the cloud — new numbers appear in ~5 minutes.');
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
      const data = await api('/api/recipients', {
        method: 'PUT',
        body: JSON.stringify({ recipients: list }),
      });
      setRecipients(data.recipients);
      setRecipientText(data.recipients.join('\n'));
      setSavedNote('Saved ✓');
      setTimeout(() => setSavedNote(''), 2000);
    } catch (e) {
      setError(`Saving recipients failed: ${e.message}`);
    }
  }, [recipientText]);

  const deviceCounts = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, deviceCountsOf(s)])), [sites]);

  // Each navigation (view switch, site drill-down, back) starts at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view, selectedSite]);

  const T = styles;

  const goTo = (v, siteId) => navigate(v, v === 'sites' && siteId ? siteId : undefined);
  // Site selection routes through the hash too (null -> back to the table).
  const routeSelectSite = (id) => navigate('sites', id || undefined);

  const NAV = [
    ['home', 'Home', IconHome],
    ['sites', 'Partner Sites', IconGlobe],
    ['social', 'Partner Social Media', IconMessage],
    ['activity', 'Activity', IconActivity],
  ];

  if (loading) return <div style={{ ...T.app, ...T.boot }}>Loading Samsung Visibility Monitor…</div>;

  return (
    <div style={T.app}>
      <style>{APP_CSS}</style>

      {/* ambient aurora backdrop */}
      <div aria-hidden style={T.aurora} />

      {/* top bar: wordmark + icon nav + live pill + run */}
      <header style={T.topBar}>
        <button className="vm-press" style={T.wordmarkBtn} onClick={() => goTo('home')} title="Home">
          <span style={T.logoTile}>S</span>
          <span style={T.wordmark}>SAMSUNG</span>
          <span style={T.wordmarkLabel}>Visibility Monitor</span>
        </button>

        <nav style={T.iconNav}>
          {NAV.map(([v, label, NIcon]) => (
            <button
              key={v}
              className="vm-press"
              style={{ ...T.iconBtn, ...(view === v ? T.iconBtnOn : {}) }}
              onClick={() => goTo(v)}
              title={label}
              aria-label={label}
            >
              <NIcon size={18} />
            </button>
          ))}
        </nav>

        <div style={T.topRight}>
          <span style={T.topLive}>
            <span style={T.pingWrap}>
              <span className="vm-ping" style={T.pingHalo} />
              <span style={T.pingDot} />
            </span>
            LIVE DATA
          </span>
          <button
            className="vm-press"
            style={{ ...T.primaryBtn, ...(running ? { opacity: 0.6, cursor: 'default' } : {}) }}
            onClick={runCheck}
            disabled={running}
            title="Trigger a fresh check of every site"
          >
            <IconPlay size={13} /> {running ? 'Starting…' : 'Run check'}
          </button>
        </div>
      </header>

      {/* centered content column */}
      <main style={T.main}>
        {error && <div style={T.error}>{error}</div>}
        {runNote && <div style={T.notice}>{runNote}</div>}
        {view === 'home' && <HomeView sites={sites} social={social} goTo={goTo} />}
        {view === 'sites' && (
          <SitesView
            sites={sites}
            deviceCounts={deviceCounts}
            selectedSite={selectedSite}
            setSelectedSite={routeSelectSite}
          />
        )}
        {view === 'social' && <SocialView social={social} />}
        {view === 'activity' && (
          <ActivityView
            log={log}
            sites={sites}
            recipients={recipients}
            recipientText={recipientText}
            setRecipientText={setRecipientText}
            saveRecipients={saveRecipients}
            savedNote={savedNote}
          />
        )}
        <footer style={T.footer}>
          Samsung Visibility Monitor · automated by banner-monitor · WoW/MoM movement needs 7/30 days of history.
        </footer>
      </main>
    </div>
  );
}

/* ---------- design tokens & styles (Signal Dark) ---------- */

const SANS = "'Inter','Segoe UI Variable Text','Segoe UI',-apple-system,'Helvetica Neue',Arial,sans-serif";
const MONO = "'Geist Mono',Consolas,'Cascadia Mono','SF Mono',monospace";

const BG = '#f6f9f8'; // teal-tinted off-white
const CARD_BG = 'rgba(255,255,255,0.82)'; // translucent glass card
const LINE = 'rgba(19,36,32,0.10)';
const INK = '#132420'; // foreground
const INK_2 = '#4d5f5a'; // secondary
const INK_3 = '#7d8c87'; // faint
const ACCENT = '#65a30d'; // lime
const GLOW = 'rgba(13,148,136,0.20)';

// Interaction layer + fonts. Inline styles can't express :hover/:active,
// keyframes or @import, so this sheet is injected once from the root.
const APP_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Geist+Mono:wght@400;500;600;700&display=swap');
  html, body {
    margin: 0;
    background-color: ${BG};
    color-scheme: light;
  }
  body {
    background-image:
      radial-gradient(ellipse 70% 45% at 18% -8%, rgba(13,148,136,0.10), transparent 60%),
      radial-gradient(ellipse 55% 40% at 85% 0%, rgba(101,163,13,0.06), transparent 55%),
      radial-gradient(ellipse 60% 50% at 50% 110%, rgba(13,148,136,0.06), transparent 60%);
    background-attachment: fixed;
  }
  * { -webkit-font-smoothing: antialiased; }
  @keyframes vmFadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes vmPing {
    0% { transform: scale(1); opacity: 0.6; }
    75%, 100% { transform: scale(2.4); opacity: 0; }
  }
  .vm-enter { animation: vmFadeUp 360ms cubic-bezier(0.23, 1, 0.32, 1) both; }
  .vm-ping { animation: vmPing 1.6s cubic-bezier(0, 0, 0.2, 1) infinite; }
  .vm-press { transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), filter 140ms ease, box-shadow 200ms ease; }
  .vm-press:active { transform: scale(0.97); }
  .vm-row { cursor: pointer; transition: background 150ms ease; }
  .vm-module { transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 200ms ease, border-color 200ms ease; }
  @media (hover: hover) and (pointer: fine) {
    .vm-press:hover { filter: brightness(0.96); }
    .vm-row:hover { background: rgba(19,36,32,0.045); }
    .vm-module:hover {
      transform: translateY(-2px);
      border-color: rgba(13,148,136,0.45) !important;
      box-shadow: 0 0 0 1px rgba(13,148,136,0.2), 0 0 28px ${GLOW}, 0 12px 32px -10px rgba(19,36,32,0.18);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .vm-enter { animation: none; }
    .vm-ping { animation: none; }
    .vm-press, .vm-press:active, .vm-module:hover { transform: none; transition: none; }
  }
`;

const glass = {
  background: CARD_BG,
  border: `1px solid ${LINE}`,
  borderRadius: 14,
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  boxShadow: '0 1px 2px rgba(19,36,32,0.04), 0 8px 24px -12px rgba(19,36,32,0.10)',
};

const styles = {
  app: { fontFamily: SANS, color: INK, minHeight: '100vh', position: 'relative' },
  boot: { color: INK_3, padding: 80, textAlign: 'center', fontSize: 14 },
  aurora: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 },

  /* top bar */
  topBar: {
    position: 'sticky',
    top: 0,
    zIndex: 30,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    height: 58,
    padding: '0 22px',
    borderBottom: '1px solid rgba(19,36,32,0.08)',
    background: 'rgba(255,255,255,0.78)',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
  },
  wordmarkBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'none',
    border: 0,
    cursor: 'pointer',
    padding: 0,
    color: INK,
    fontFamily: 'inherit',
  },
  logoTile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: 9,
    background: `linear-gradient(135deg, ${SAMSUNG}, ${ACCENT})`,
    color: '#ffffff',
    fontWeight: 900,
    fontSize: 14,
    letterSpacing: '-0.05em',
    boxShadow: `0 0 18px ${GLOW}`,
    flexShrink: 0,
  },
  wordmark: { fontWeight: 800, fontSize: 14, letterSpacing: '0.12em' },
  wordmarkLabel: {
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    color: INK_3,
  },
  iconNav: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: 5,
    borderRadius: 14,
    border: `1px solid ${LINE}`,
    background: 'rgba(255,255,255,0.7)',
  },
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 38,
    height: 38,
    borderRadius: 10,
    border: 0,
    background: 'none',
    color: INK_3,
    cursor: 'pointer',
  },
  iconBtnOn: {
    background: 'rgba(13,148,136,0.2)',
    color: INK,
    boxShadow: `0 0 16px ${GLOW}`,
  },
  topRight: { display: 'flex', alignItems: 'center', gap: 10 },
  topLive: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    border: `1px solid ${LINE}`,
    background: 'rgba(19,36,32,0.03)',
    padding: '5px 12px',
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: INK_2,
  },
  pingWrap: { position: 'relative', display: 'inline-flex', width: 6, height: 6, flexShrink: 0 },
  pingHalo: { position: 'absolute', inset: 0, borderRadius: '50%', background: '#15803d' },
  pingDot: { position: 'relative', display: 'inline-flex', width: 6, height: 6, borderRadius: '50%', background: '#15803d' },
  primaryBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    background: 'linear-gradient(135deg, #0f766e, #0d9488)',
    color: '#fff',
    border: 0,
    borderRadius: 10,
    padding: '9px 16px',
    fontSize: 12.5,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: `0 0 20px ${GLOW}`,
  },

  /* centered content column */
  main: {
    position: 'relative',
    zIndex: 1,
    maxWidth: 1200,
    margin: '0 auto',
    padding: '32px 32px 80px',
    boxSizing: 'border-box',
  },
  error: {
    background: 'rgba(185,28,28,0.12)',
    color: '#b91c1c',
    border: '1px solid rgba(185,28,28,0.3)',
    borderRadius: 10,
    padding: '10px 14px',
    marginBottom: 18,
    fontSize: 13,
  },
  notice: {
    background: 'rgba(21,128,61,0.1)',
    color: '#15803d',
    border: '1px solid rgba(21,128,61,0.25)',
    borderRadius: 10,
    padding: '10px 14px',
    marginBottom: 18,
    fontSize: 13,
  },
  footer: { color: INK_3, fontSize: 11, marginTop: 48, textAlign: 'center', lineHeight: 1.7 },

  kicker: {
    fontSize: 11,
    fontWeight: 700,
    color: INK_3,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    margin: '0 0 12px',
  },
  pageTitle: { fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.1, margin: '0 0 10px' },
  pageSub: { color: INK_2, fontSize: 13.5, lineHeight: 1.65, margin: '0 0 22px', maxWidth: 640 },

  /* hero (landing) */
  heroWrap: { textAlign: 'center', padding: '44px 0 54px', display: 'flex', flexDirection: 'column', alignItems: 'center' },
  livePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 9,
    borderRadius: 999,
    border: `1px solid ${LINE}`,
    background: 'rgba(19,36,32,0.03)',
    padding: '7px 16px',
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: '0.14em',
    color: INK_2,
    marginBottom: 28,
  },
  heroTitle: { fontSize: 54, fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.05, margin: 0 },
  heroGradient: {
    backgroundImage: `linear-gradient(92deg, ${SAMSUNG}, ${ACCENT})`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  },
  heroSub: { color: INK_2, fontSize: 15, lineHeight: 1.7, maxWidth: 560, margin: '24px auto 0' },
  counterRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
    gap: 24,
    width: '100%',
    maxWidth: 440,
    marginTop: 46,
  },
  counterValue: { fontSize: 34, fontWeight: 800, letterSpacing: '-0.03em', margin: 0 },
  counterLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    color: INK_3,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
    margin: '8px 0 0',
  },

  /* insight strip */
  insightStrip: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4, marginBottom: 8 },
  insightItem: {
    ...glass,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    padding: '12px 18px',
    cursor: 'pointer',
    color: INK,
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  insightLabel: { fontSize: 10, fontWeight: 700, color: INK_3, textTransform: 'uppercase', letterSpacing: '0.1em' },
  insightValue: { fontSize: 14, fontWeight: 700 },

  /* modules */
  moduleGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16 },
  moduleCard: {
    ...glass,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 12,
    padding: 24,
    cursor: 'pointer',
    color: INK,
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  moduleTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' },
  moduleIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 40,
    height: 40,
    borderRadius: 11,
    background: 'rgba(13,148,136,0.15)',
    color: '#0f766e',
  },
  moduleIndex: { fontFamily: MONO, fontSize: 12, color: INK_3 },
  moduleTitle: { fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em' },
  moduleDesc: { fontSize: 12.5, color: INK_2, lineHeight: 1.65 },
  moduleTags: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  moduleArrow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12.5,
    fontWeight: 700,
    color: '#0f766e',
    marginTop: 4,
  },

  /* headline stats */
  statRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))',
    gap: 14,
    marginBottom: 20,
  },
  stat: { ...glass, padding: '16px 18px' },
  statXl: { padding: '24px 26px' },
  statValueXl: { fontSize: 46, letterSpacing: '-0.035em' },
  statBest: {
    background: 'rgba(13,148,136,0.07)',
    borderColor: 'rgba(13,148,136,0.35)',
    boxShadow: '0 0 0 1px rgba(13,148,136,0.12), 0 8px 24px -12px rgba(19,36,32,0.10)',
    cursor: 'pointer',
  },
  spotRow: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', margin: '8px 0 2px' },
  spotChip: {
    background: '#ffffff',
    color: INK_2,
    border: `1px solid ${LINE}`,
    borderRadius: 6,
    padding: '2px 8px',
    fontSize: 10.5,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  },
  spotChipOn: {
    background: 'rgba(13,148,136,0.14)',
    color: '#0f766e',
    borderColor: 'rgba(13,148,136,0.45)',
  },
  bestPct: {
    fontFamily: MONO,
    fontSize: 14,
    fontWeight: 700,
    color: '#0f766e',
    background: 'rgba(13,148,136,0.12)',
    borderRadius: 999,
    padding: '3px 10px',
    fontVariantNumeric: 'tabular-nums',
  },
  statLabel: { color: INK_3, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' },
  statValueRow: { display: 'flex', alignItems: 'baseline', gap: 10, margin: '7px 0' },
  statValue: { fontSize: 32, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1, margin: '7px 0', fontVariantNumeric: 'tabular-nums' },
  statSub: { color: INK_3, fontSize: 11, lineHeight: 1.55 },

  /* movement text */
  moveUp: { fontSize: 11, fontWeight: 700, color: '#15803d', fontVariantNumeric: 'tabular-nums' },
  moveDown: { fontSize: 11, fontWeight: 700, color: '#b91c1c', fontVariantNumeric: 'tabular-nums' },
  moveFlat: { fontSize: 11, fontWeight: 700, color: INK_2, fontVariantNumeric: 'tabular-nums' },
  moveMuted: { fontSize: 11, fontWeight: 600, color: '#a9b6b1' },

  /* generic panel */
  panel: { ...glass, padding: 22 },
  panelTitle: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    fontSize: 14,
    fontWeight: 700,
    margin: '0 0 14px',
    letterSpacing: '-0.01em',
  },
  panelSub: { fontSize: 11, fontWeight: 500, color: INK_3 },
  empty: { color: INK_3, fontSize: 12.5, padding: '10px 0', lineHeight: 1.6 },
  footnote: { color: '#a9b6b1', fontSize: 10.5, marginTop: 12, lineHeight: 1.6 },
  link: { color: '#0f766e', textDecoration: 'none', fontWeight: 600 },

  /* filters */
  filterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    padding: '10px 0',
    borderTop: '1px solid rgba(19,36,32,0.07)',
  },
  filterLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    color: INK_3,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginRight: 4,
  },
  filterCount: { marginLeft: 'auto', fontSize: 11, color: INK_3, fontFamily: MONO },
  chip: {
    background: '#ffffff',
    color: INK_2,
    border: `1px solid ${LINE}`,
    borderRadius: 8,
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  chipOn: {
    background: 'rgba(13,148,136,0.22)',
    color: '#0f766e',
    borderColor: 'rgba(13,148,136,0.55)',
    boxShadow: `0 0 14px ${GLOW}`,
  },
  dateInput: {
    background: '#ffffff',
    color: INK_2,
    border: `1px solid ${LINE}`,
    borderRadius: 8,
    padding: '3px 10px',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'inherit',
    colorScheme: 'light',
  },
  pickerRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', paddingBottom: 10, marginBottom: 4 },
  productRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 16 },

  /* table */
  tableWrap: { ...glass, marginTop: 14, overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'right',
    color: INK_3,
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    padding: '13px 14px 11px',
    borderBottom: `1px solid ${LINE}`,
    whiteSpace: 'nowrap',
  },
  tr: { borderBottom: '1px solid rgba(19,36,32,0.07)' },
  td: { padding: '13px 14px', verticalAlign: 'middle' },
  tdRank: { color: INK_3, fontFamily: MONO, fontSize: 12, textAlign: 'right' },
  tdSite: { fontWeight: 700, fontSize: 13.5, letterSpacing: '-0.01em', color: INK },
  tdMeta: { color: INK_3, fontSize: 11, marginTop: 2 },
  tdNum: { textAlign: 'right', fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: INK_2 },
  tdAvgRow: { display: 'flex', alignItems: 'center', gap: 10 },
  tdAvg: {
    fontFamily: MONO,
    fontSize: 14,
    fontWeight: 700,
    color: '#0f766e',
    width: 54,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  },

  /* bars */
  barTrack: { height: 7, borderRadius: 999, background: 'rgba(19,36,32,0.09)', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 999, transition: 'width .4s ease' },

  /* tags */
  tag: {
    display: 'inline-block',
    borderRadius: 999,
    padding: '2.5px 10px',
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
  },

  /* site detail */
  backLink: {
    background: 'none',
    border: 0,
    padding: 0,
    color: '#0f766e',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginBottom: 16,
  },
  detailHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 20,
    flexWrap: 'wrap',
    marginBottom: 20,
  },
  detailTitle: { fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', margin: '0 0 6px', lineHeight: 1.1 },
  detailMeta: { color: INK_2, fontSize: 12.5 },
  detailAvg: { textAlign: 'right', flexShrink: 0 },
  detailAvgNum: {
    fontSize: 44,
    fontWeight: 800,
    color: '#0f766e',
    lineHeight: 1,
    letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
    textShadow: `0 0 30px ${GLOW}`,
  },
  detailAvgLabel: {
    color: INK_3,
    fontSize: 10.5,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    marginTop: 5,
    whiteSpace: 'nowrap',
  },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 18 },

  viewToggleRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 },

  // Metric-card flip (front = metrics, back = competition leaderboards). The
  // hidden face is absolutely positioned so the visible one drives the height.
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
    minHeight: 0,
    height: '100%',
  },
  flipBack: { transform: 'rotateY(180deg)' },
  flipHidden: { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' },

  metricRow: { padding: '12px 0', borderTop: '1px solid rgba(19,36,32,0.07)', display: 'flex', flexDirection: 'column', gap: 7 },
  metricTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
  metricLabel: { fontSize: 13, fontWeight: 700 },
  metricVal: { fontSize: 13 },
  metricFrac: { color: INK_3, fontFamily: MONO, fontSize: 11.5 },
  metricMoves: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },

  /* charts */
  chartHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
  chartTitle: { fontSize: 13, fontWeight: 700 },
  chartHint: { fontSize: 10, color: '#a9b6b1' },
  tooltip: {
    position: 'absolute',
    top: 0,
    background: '#ffffff',
    border: `1px solid ${LINE}`,
    borderRadius: 8,
    boxShadow: '0 6px 24px rgba(19,36,32,.15)',
    padding: '7px 10px',
    fontSize: 11,
    color: INK_2,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    zIndex: 5,
  },
  tooltipDate: { fontWeight: 700, color: INK, marginBottom: 4 },
  tooltipRow: { display: 'flex', alignItems: 'center', gap: 5, lineHeight: 1.6 },
  legendRow: { display: 'flex', gap: 14, alignItems: 'center', marginTop: 6 },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: INK_2 },
  dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },

  colRow: { display: 'flex', alignItems: 'flex-end', gap: 10, padding: '12px 2px 2px', overflowX: 'auto' },
  col: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flex: 1, minWidth: 34 },
  colBar: {
    width: '100%',
    maxWidth: 46,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    borderRadius: 5,
    overflow: 'hidden',
  },
  colPct: { fontSize: 11, fontWeight: 800, color: '#1428a0', fontVariantNumeric: 'tabular-nums' },
  colLabel: { fontSize: 11, fontWeight: 700, color: INK_2 },
  colTotal: { fontSize: 10, color: INK_3, fontFamily: MONO },

  /* shelf positions */
  blockHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 },
  blockTitle: { fontSize: 12.5, fontWeight: 700 },
  blockMeta: { fontSize: 11, color: INK_2 },
  blockCaption: { fontSize: 10.5, color: INK_2, marginTop: 6 },
  posWrap: { display: 'flex', flexWrap: 'wrap', gap: 3, maxHeight: 96, overflowY: 'auto', padding: '2px 0' },
  pos: { fontSize: 10, fontWeight: 700, borderRadius: 5, padding: '1.5px 6px', fontFamily: MONO },
  posPrime: { background: 'rgba(21,128,61,0.15)', color: '#15803d' },
  posGood: { background: 'rgba(13,148,136,0.16)', color: '#0f766e' },
  posDeep: { background: 'rgba(19,36,32,0.07)', color: INK_2 },
  posDot: { display: 'inline-block', width: 9, height: 9, borderRadius: 3, verticalAlign: 'middle' },
  termRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 },

  /* brand boards (competition) */
  compGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 24 },
  compHead: {
    fontSize: 10.5,
    fontWeight: 700,
    color: INK_3,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    padding: '8px 0 8px',
  },
  boardRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '3.5px 6px', borderRadius: 6 },
  boardRowHi: { background: 'rgba(13,148,136,0.12)' },
  boardRank: { width: 16, textAlign: 'right', fontSize: 11, color: INK_3, fontWeight: 700, flexShrink: 0, fontFamily: MONO },
  boardBrand: { width: 72, fontSize: 12, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  boardTrack: { flex: 1, height: 8, borderRadius: 999, background: 'rgba(19,36,32,0.09)', overflow: 'hidden' },
  boardFill: { height: '100%', borderRadius: 999 },
  boardNum: { width: 78, textAlign: 'right', fontSize: 12, flexShrink: 0, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' },
  boardPct: { color: INK_3, fontSize: 10.5, fontWeight: 500 },
  divLine: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(19,36,32,0.07)' },
  divName: { width: 116, fontSize: 12, fontWeight: 700, flexShrink: 0 },
  divDetail: { fontSize: 11.5, color: INK_2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  /* assets */
  assetGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 10 },
  assetCard: {
    border: `1px solid ${LINE}`,
    borderRadius: 10,
    padding: 8,
    textDecoration: 'none',
    color: INK_2,
    background: 'rgba(19,36,32,0.03)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  assetImg: { width: '100%', height: 104, objectFit: 'contain', borderRadius: 6, background: '#fff' },
  assetNoImg: {
    width: '100%',
    height: 104,
    borderRadius: 6,
    background: 'rgba(13,148,136,0.12)',
    color: '#0f766e',
    fontSize: 11,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  assetLabel: {
    fontSize: 10.5,
    lineHeight: 1.4,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },

  /* overview / activity grid */
  overviewGrid: { display: 'grid', gridTemplateColumns: 'minmax(0,3fr) minmax(0,2fr)', gap: 18, alignItems: 'start' },
  moreBtn: {
    background: '#ffffff',
    border: `1px solid ${LINE}`,
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: 12,
    fontWeight: 600,
    color: INK_2,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginTop: 10,
  },

  /* social */
  socialCols: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))', gap: 18, alignItems: 'start' },
  socialRow: { display: 'flex', alignItems: 'center', gap: 14, padding: '10px 6px', borderBottom: '1px solid rgba(19,36,32,0.07)', borderRadius: 8 },
  socialRowOn: { background: 'rgba(13,148,136,0.12)' },
  socialSite: { width: 148, flexShrink: 0 },
  socialName: { fontWeight: 700, fontSize: 13 },
  socialMeta: { fontSize: 10.5, color: INK_3, marginTop: 2 },
  socialBarWrap: { flex: 1, minWidth: 0 },
  socialCaption: { fontSize: 11, color: INK_2, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  socialRivals: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: INK_2, marginTop: 4 },
  socialLead: { textAlign: 'right', width: 76, flexShrink: 0 },
  socialLeadNum: { fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  socialLeadLabel: { color: INK_3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2, whiteSpace: 'nowrap' },
  brandChip: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: INK_2 },

  postRow: { display: 'block', padding: '9px 0', borderBottom: '1px solid rgba(19,36,32,0.07)', textDecoration: 'none', color: 'inherit' },
  postMeta: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: INK_3 },
  postSite: { fontWeight: 700, color: INK, fontSize: 12 },
  postStats: { marginLeft: 'auto', whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 10.5 },
  postCaption: { fontSize: 12, color: INK_2, marginTop: 3, lineHeight: 1.55 },

  /* activity */
  help: { color: INK_2, fontSize: 12, margin: '0 0 8px', lineHeight: 1.55 },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    border: `1px solid ${LINE}`,
    borderRadius: 10,
    padding: 10,
    fontFamily: MONO,
    fontSize: 12.5,
    background: '#ffffff',
    color: INK,
  },
  recipFooter: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 },
  savedNote: { color: INK_2, fontSize: 12 },
};
