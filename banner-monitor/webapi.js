'use strict';

/**
 * webapi.js — the read-side API as a shareable Express router.
 *
 * Mounted by BOTH deployment targets:
 *   - server.js      (local): adds the cron, the synchronous /api/run, and
 *                     static screenshot serving on top.
 *   - api/index.js   (Vercel): adds a /api/run that dispatches the GitHub
 *                     Actions scrape workflow instead of running in-process.
 *
 * IMPORTANT: this module must never require scraper/share/vision (Playwright)
 * — the Vercel function has no browser and must stay small.
 */

const express = require('express');
const path = require('path');

const { SITES } = require('./config');
const store = require('./store');

const router = express.Router();

router.get('/api/health', (_req, res) => res.json({ ok: true, backend: store.backend }));

router.get('/api/sites', async (_req, res) => {
  try {
    // AI reconciliation (not shown as a discrepancy): the DOM count is the
    // metric, but when the DOM finds NOTHING in a section and the AI clearly
    // sees Samsung placements there, the DOM selectors are blind to that
    // section (e.g. e&'s CSS-background hero) — display the AI's count as the
    // higher-confidence number.
    const reconcile = (domCount, aiCount) =>
      domCount === 0 && aiCount != null && aiCount >= 1 ? aiCount : domCount;

    const out = [];
    for (const site of SITES) {
      // 60 runs ≈ two months of daily checks — enough for MoM deltas client-side.
      const runs = await store.getRuns(site.id, 60);
      const latest = runs[0] || null;
      const vc = latest ? latest.vision_check || null : null;
      out.push({
        id: site.id,
        name: site.name,
        url: site.url,
        region: site.region,
        count: latest ? (vc ? reconcile(latest.count, vc.hero) : latest.count) : null,
        bannerTotal: latest ? (latest.banner_total == null ? null : latest.banner_total) : null,
        promoCount: latest
          ? vc
            ? reconcile(latest.promo_count == null ? 0 : latest.promo_count, vc.promo)
            : latest.promo_count
          : null,
        promoTotal: latest ? (latest.promo_total == null ? null : latest.promo_total) : null,
        tileCount: latest
          ? vc
            ? reconcile(latest.tile_count == null ? 0 : latest.tile_count, vc.tiles)
            : latest.tile_count
          : null,
        tileTotal: latest ? (latest.tile_total == null ? null : latest.tile_total) : null,
        lastRunAt: latest ? latest.run_at : null,
        screenshotPath: latest ? latest.screenshot_path : null,
        matches: latest ? latest.matches : [],
        // Samsung assets grouped by section — powers the dashboard's Assets view.
        assets: latest
          ? {
              hero: (latest.matches || []).filter((m) => m.section === 'hero'),
              promo: (latest.matches || []).filter((m) => m.section === 'promo'),
              tiles: (latest.matches || []).filter((m) => m.section === 'tile'),
            }
          : { hero: [], promo: [], tiles: [] },
        deviceShare: latest ? latest.device_share || null : null,
        searchShare: latest ? latest.search_share || null : null,
        competition: latest ? latest.competition || null : null,
        history: runs
          .slice()
          .reverse()
          .map((r) => ({
            run_at: r.run_at,
            count: r.count,
            // Per-run brand share map (%) for the competition trend graph.
            // Prefer the device catalog (cleanest shelf metric); fall back to
            // homepage placements for sites without a catalog config.
            competitionBrands: (() => {
              const comp = r.competition;
              if (!comp) return null;
              let src = comp.devices;
              if (!src || !Object.keys(src).length) {
                src = {};
                for (const m of [comp.hero, comp.promo, comp.tiles]) {
                  if (!m) continue;
                  for (const [b, n] of Object.entries(m)) src[b] = (src[b] || 0) + n;
                }
              }
              const total = Object.values(src).reduce((a, b) => a + b, 0);
              if (!total) return null;
              const out = {};
              for (const [b, n] of Object.entries(src)) {
                if (b === 'other') continue;
                out[b] = Math.round((n / total) * 1000) / 10;
              }
              return out;
            })(),
            bannerSharePct: r.banner_total ? Math.round((r.count / r.banner_total) * 1000) / 10 : null,
            promoCount: r.promo_count == null ? null : r.promo_count,
            promoSharePct: r.promo_total ? Math.round(((r.promo_count || 0) / r.promo_total) * 1000) / 10 : null,
            tileCount: r.tile_count == null ? null : r.tile_count,
            tileSharePct: r.tile_total ? Math.round(((r.tile_count || 0) / r.tile_total) * 1000) / 10 : null,
            deviceSharePct: r.device_share ? r.device_share.sharePct : null,
            searchSharePct: r.search_share ? r.search_share.sharePct : null,
          })),
      });
    }
    res.json({ sites: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/log', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const runs = await store.getRecentRuns(limit);
    const byId = Object.fromEntries(SITES.map((s) => [s.id, s.name]));
    res.json({
      events: runs.map((r) => ({
        id: r.id,
        site_id: r.site_id,
        site: byId[r.site_id] || r.site_id,
        run_at: r.run_at,
        count: r.count,
        deviceSharePct: r.device_share ? r.device_share.sharePct : null,
        searchSharePct: r.search_share ? r.search_share.sharePct : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/recipients', async (_req, res) => {
  try {
    res.json({ recipients: await store.getRecipients() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/recipients', async (req, res) => {
  try {
    const list = Array.isArray(req.body && req.body.recipients) ? req.body.recipients : [];
    res.json({ recipients: await store.setRecipients(list) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The dashboard component itself — banner-monitor-dashboard.jsx stays the
// single source of truth for both local and Vercel serving.
const DASHBOARD_PATH = path.join(__dirname, '..', 'banner-monitor-dashboard.jsx');
router.get('/dashboard.jsx', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(DASHBOARD_PATH);
});

module.exports = router;
