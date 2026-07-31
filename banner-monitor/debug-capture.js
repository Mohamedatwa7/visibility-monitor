'use strict';

// One-off diagnostic: run the scraper's own hero-control detection + active-
// slide capture against a live site and print the raw results.
// Usage: node banner-monitor/debug-capture.js <siteId> [clicks]

require('dotenv').config();
const { SITES, BROWSER } = require('./config');
const {
  launchStealthContext,
  gotoWithRetry,
  dismissConsent,
  autoScroll,
  captureActiveHeroInPage,
  detectHeroControlInPage,
  clickHeroControlInPage,
  HERO_BAND_PX,
} = require('./scraper');

const wantId = process.argv[2] || 'omantel';
const clicks = Number(process.argv[3] || 3);
const site = SITES.find((s) => s.id === wantId);
if (!site) {
  console.error(`Unknown site id "${wantId}"`);
  process.exit(1);
}

(async () => {
  const { browser, context } = await launchStealthContext(site);
  try {
    const page = await context.newPage();
    await gotoWithRetry(page, site.url, BROWSER.navTimeoutMs);
    await dismissConsent(page, site);
    await autoScroll(page);
    await page.waitForTimeout(1000);

    const control = await page.evaluate(detectHeroControlInPage, HERO_BAND_PX);
    console.log('control:', JSON.stringify(control));

    console.log('initial capture:', JSON.stringify(await page.evaluate(captureActiveHeroInPage, HERO_BAND_PX), null, 1));

    if (control) {
      for (let i = 0; i < clicks; i++) {
        const ok = await page.evaluate(clickHeroControlInPage, {
          mode: control.mode,
          sel: control.sel,
          index: i,
          bandBottom: HERO_BAND_PX,
        });
        await page.waitForTimeout(1200);
        const st = await page.evaluate(captureActiveHeroInPage, HERO_BAND_PX);
        console.log(`after ${control.mode} ${i} (clicked=${ok}):`, JSON.stringify(st, null, 1));
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
