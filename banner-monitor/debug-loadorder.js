'use strict';

// One-off diagnostic: what does a FRESH visitor see? Loads the page and
// samples the active hero slide every second from the earliest possible
// moment (no autoscroll, no clicks) — the observed sequence is the true
// visual rotation from load.
// Usage: node banner-monitor/debug-loadorder.js <siteId> [seconds]

require('dotenv').config();
const { SITES, BROWSER } = require('./config');
const { launchStealthContext, gotoWithRetry, captureActiveHeroInPage, HERO_BAND_PX } = require('./scraper');

const wantId = process.argv[2] || 'xcite';
const seconds = Number(process.argv[3] || 45);
const site = SITES.find((s) => s.id === wantId);
if (!site) {
  console.error(`Unknown site id "${wantId}"`);
  process.exit(1);
}

(async () => {
  const { browser, context } = await launchStealthContext(site);
  try {
    const page = await context.newPage();
    // domcontentloaded, not networkidle — we want the earliest usable moment.
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: BROWSER.navTimeoutMs });
    const seen = [];
    let last = '';
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      let st = null;
      try {
        st = await page.evaluate(captureActiveHeroInPage, { bandBottom: HERO_BAND_PX, noCaption: true });
      } catch {
        /* page still hydrating */
      }
      if (st && st.url) {
        const k = `${st.url}|${st.href || ''}`;
        if (k !== last) {
          last = k;
          seen.push({ t: Math.round((Date.now() - t0) / 100) / 10, url: st.url.slice(0, 110), href: (st.href || '').slice(0, 90) });
        }
      }
      await page.waitForTimeout(700);
    }
    console.log(JSON.stringify(seen, null, 1));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
