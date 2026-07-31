'use strict';

// One-off diagnostic: list clickable-looking elements in the hero band so we
// can see what a site's carousel dots/arrows look like in the DOM.
// Usage: node banner-monitor/debug-controls.js <siteId>

require('dotenv').config();
const { SITES, BROWSER } = require('./config');
const { launchStealthContext, gotoWithRetry, dismissConsent, autoScroll } = require('./scraper');

const wantId = process.argv[2] || 'du';
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

    const dump = await page.evaluate(() => {
      const chromeSel =
        'header, nav, footer, [class*="mega" i], [class*="navbar" i], [class*="navigation" i], [id*="footer" i], [id*="header" i]';
      const out = [];
      document.querySelectorAll('button, [role="button"], [role="tab"], a, span, li, div, svg').forEach((el) => {
        if (el.closest(chromeSel)) return;
        const r = el.getBoundingClientRect();
        if (r.top < -50 || r.top > 950) return;
        // small clickable-looking things only (dots/arrows are tiny)
        if (r.width > 90 || r.height > 90) return;
        if (r.width < 3 || r.height < 3) return;
        const cls = `${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`.trim();
        const aria = el.getAttribute('aria-label') || '';
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30);
        // keep only likely control candidates: no long text
        if (text.length > 12) return;
        out.push({
          tag: el.tagName,
          cls: cls.slice(0, 110),
          aria,
          text,
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          parentCls: el.parentElement
            ? `${typeof el.parentElement.className === 'string' ? el.parentElement.className : ''}`.trim().slice(0, 90)
            : '',
        });
      });
      return out.slice(0, 80);
    });

    console.log(JSON.stringify(dump, null, 1));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
