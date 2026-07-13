'use strict';

/**
 * run.js — orchestrates one full pass across all sites.
 *
 *   1. For each site: read the previous run, scrape the current count, save it.
 *   2. Diff new vs previous counts -> changes.
 *   3. If changes exist, send an alert.
 *
 * Usage:
 *   node banner-monitor/run.js            # all sites
 *   node banner-monitor/run.js e& du      # only the named site ids
 */

require('dotenv').config();

const { SITES } = require('./config');
const { countSamsungBanners } = require('./scraper');
const { measureDeviceShare, measureSearchShare } = require('./share');
const { visionCheck } = require('./vision');
const store = require('./store');
const { buildChanges, sendAlert } = require('./notify');

function fmtShare(s) {
  if (!s) return '—';
  const pct = s.sharePct == null ? '?' : `${s.sharePct}%`;
  return `${s.samsung}/${s.total} (${pct})`;
}

// Watchdog: no single scrape step may hang the whole run. Sites that stall
// (WAFs throttling datacenter IPs can hold connections for a very long time)
// fail with a clear error after this budget and the run moves on.
const STEP_TIMEOUT_MS = Number(process.env.SCRAPE_STEP_TIMEOUT_MIN || 10) * 60 * 1000;

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${Math.round(STEP_TIMEOUT_MS / 60000)} min watchdog`)),
      STEP_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runOnce(siteFilter) {
  const sites = siteFilter && siteFilter.length ? SITES.filter((s) => siteFilter.includes(s.id)) : SITES;

  console.log(`\n=== banner-monitor run (${new Date().toISOString()}) ===`);
  console.log(`Storage backend: ${store.backend}`);
  console.log(`Sites: ${sites.map((s) => s.id).join(', ')}\n`);

  const items = [];

  for (const site of sites) {
    let prevRun = null;
    try {
      prevRun = await store.getLastRun(site.id);
    } catch (err) {
      console.warn(`[run] Could not read previous run for ${site.id}: ${err.message}`);
    }
    const prevCount = prevRun ? prevRun.count : null;
    const prevDeviceShare = prevRun ? prevRun.device_share || null : null;
    const prevSearchShare = prevRun ? prevRun.search_share || null : null;

    process.stdout.write(`[run] ${site.name} … `);
    try {
      const { hero, promo, tiles, divisions, screenshotPath } = await withTimeout(
        countSamsungBanners(site),
        `${site.name} banner scrape`
      );
      console.log(
        `hero ${hero.count}/${hero.total} · promo ${promo.count}/${promo.total} · tiles ${tiles.count}/${tiles.total}`
      );
      hero.matches.forEach((m, i) => console.log(`        hero ${i + 1}. ${m.src || m.href || '(placement)'}`));
      promo.matches.forEach((m, i) => console.log(`        promo ${i + 1}. ${m.src || m.href || '(placement)'}`));
      console.log(`        screenshot: ${screenshotPath}`);

      // Shelf-share measurements (optional per site). A share failure must not
      // lose the banner result, so each is caught independently.
      let deviceShare = null;
      let searchShare = null;
      if (site.devices) {
        process.stdout.write(`        device-page share … `);
        try {
          deviceShare = await withTimeout(measureDeviceShare(site), `${site.name} device share`);
          console.log(`${fmtShare(deviceShare)} Samsung across ${deviceShare.pages} page(s)`);
        } catch (err) {
          console.log(`FAILED — ${err.message}`);
        }
      }
      if (site.search) {
        const termLabel = (site.search.terms || [site.search.term || 'phones']).join('", "');
        process.stdout.write(`        search "${termLabel}" share … `);
        try {
          searchShare = await withTimeout(measureSearchShare(site), `${site.name} search share`);
          console.log(`${fmtShare(searchShare)} Samsung${searchShare.kind === 'facet' ? ' (brand facet)' : ''}`);
          if (Array.isArray(searchShare.results) && searchShare.results.length > 1) {
            for (const r of searchShare.results) {
              console.log(r.error ? `          "${r.term}": FAILED — ${r.error}` : `          "${r.term}": ${fmtShare(r)}`);
            }
          }
        } catch (err) {
          console.log(`FAILED — ${err.message}`);
        }
      }

      // AI cross-check (optional — needs ANTHROPIC_API_KEY). The DOM count above
      // stays the official metric; this flags selector drift when they disagree.
      let vision = null;
      if (process.env.ANTHROPIC_API_KEY) {
        process.stdout.write(`        AI cross-check … `);
        try {
          vision = await withTimeout(
            visionCheck(site, screenshotPath, {
              hero: hero.count,
              promo: promo.count,
              tiles: tiles.count,
            }),
            `${site.name} AI cross-check`
          );
          console.log(
            `hero ${vision.hero} · promo ${vision.promo} · tiles ${vision.tiles} — ${vision.agrees ? 'agrees' : 'differs'} (DOM total ${hero.count + promo.count + tiles.count})`
          );
        } catch (err) {
          console.log(`FAILED — ${err.message}`);
        }
      }

      // Matches carry their section so the dashboard's Assets view can group
      // them (hero / promo / tile) and emails can skip the tile noise.
      const labeledMatches = [
        ...hero.matches.map((m) => ({ ...m, section: 'hero' })),
        ...promo.matches.map((m) => ({ ...m, section: 'promo' })),
        ...tiles.matches.map((m) => ({ ...m, section: 'tile' })),
      ];

      // Competition analysis: per-section brand breakdowns, division-level
      // head-to-heads, and catalog/search brand shares in one object.
      const competition = {
        hero: hero.brands,
        promo: promo.brands,
        tiles: tiles.brands,
        divisions,
        devices: deviceShare ? deviceShare.brands || null : null,
        search: searchShare ? searchShare.brands || null : null,
      };
      const topRivals = {};
      for (const m of [hero.brands, promo.brands, tiles.brands, competition.devices, competition.search]) {
        if (!m) continue;
        for (const [b, n] of Object.entries(m)) if (b !== 'samsung' && b !== 'other') topRivals[b] = (topRivals[b] || 0) + n;
      }
      const rivalLine = Object.entries(topRivals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([b, n]) => `${b} ${n}`)
        .join(', ');
      if (rivalLine) console.log(`        competitors seen: ${rivalLine}`);

      // In cloud mode (Supabase) push the screenshot to storage and record its
      // public URL; locally this returns null and the disk path is kept.
      const screenshotUrl = await store.uploadScreenshot(screenshotPath);

      await store.saveRun({
        site_id: site.id,
        count: hero.count,
        matches: labeledMatches,
        screenshot_path: screenshotUrl || screenshotPath,
        device_share: deviceShare,
        search_share: searchShare,
        banner_total: hero.total,
        vision_check: vision,
        promo_count: promo.count,
        promo_total: promo.total,
        tile_count: tiles.count,
        tile_total: tiles.total,
        competition,
      });

      items.push({
        id: site.id,
        name: site.name,
        prev: prevCount,
        prevPromo: prevRun ? prevRun.promo_count : null,
        prevTiles: prevRun ? prevRun.tile_count : null,
        count: hero.count,
        bannerTotal: hero.total,
        promoCount: promo.count,
        promoTotal: promo.total,
        tileCount: tiles.count,
        tileTotal: tiles.total,
        matches: labeledMatches,
        deviceShare,
        searchShare,
        prevDeviceShare,
        prevSearchShare,
      });
    } catch (err) {
      console.error(`FAILED — ${err.message}`);
      items.push({ id: site.id, name: site.name, prev: prevCount, count: null, matches: [], error: err.message });
    }
  }

  // Only diff sites that scraped successfully.
  const scraped = items.filter((it) => it.count !== null);
  const changes = buildChanges(scraped);

  console.log('\n--- summary ---');
  for (const it of items) {
    const c = it.count === null ? 'ERROR' : `hero ${it.count}/${it.bannerTotal ?? '—'}`;
    const p = it.prev === null ? '—' : it.prev;
    const extras = [];
    if (it.promoTotal) extras.push(`promo ${it.promoCount}/${it.promoTotal}`);
    if (it.tileTotal) extras.push(`tiles ${it.tileCount}/${it.tileTotal}`);
    if (it.deviceShare) extras.push(`devices ${fmtShare(it.deviceShare)}`);
    if (it.searchShare) extras.push(`search ${fmtShare(it.searchShare)}`);
    console.log(`  ${it.name.padEnd(12)} prev=${p}  now=${c}${extras.length ? '  ' + extras.join('  ') : ''}`);
  }

  if (changes.length) {
    console.log(`\n[run] ${changes.length} site(s) changed — sending alert.`);
    await sendAlert(changes);
  } else {
    console.log('\n[run] No count changes — no alert sent.');
  }

  return { items, changes };
}

module.exports = { runOnce };

if (require.main === module) {
  const filter = process.argv.slice(2);
  runOnce(filter)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[run] Fatal:', err);
      process.exit(1);
    });
}
