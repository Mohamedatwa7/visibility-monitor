'use strict';

/**
 * reviews.js — Galaxy S26 Ultra review count + average rating per site.
 *
 * Generic: loads the configured product page (or finds the product from a
 * search/catalog URL via cfg.findProduct), then extracts AggregateRating from
 * JSON-LD — the structured data virtually every e-commerce site embeds.
 * Falls back to Amazon's DOM ids and a plain-text pattern.
 */

const { launchStealthContext, gotoWithRetry, dismissConsent, detectBlock } = require('./scraper');
const { BROWSER } = require('./config');

async function fetchS26Reviews(site) {
  const cfg = site.reviews;
  if (!cfg) return null;
  const { browser, context } = await launchStealthContext(site);
  try {
    const page = await context.newPage();
    await gotoWithRetry(page, cfg.url, BROWSER.navTimeoutMs);
    await dismissConsent(page, site);
    await detectBlock(page);

    if (cfg.findProduct) {
      const href = await page.evaluate((reSrc) => {
        const re = new RegExp(reSrc, 'i');
        for (const a of document.querySelectorAll('a[href]')) {
          const h = a.getAttribute('href') || '';
          const t = (a.innerText || '').slice(0, 120);
          if (re.test(h) || re.test(t)) return a.href;
        }
        return null;
      }, cfg.findProduct.source);
      if (!href) throw new Error('S26 Ultra product link not found');
      await gotoWithRetry(page, href, BROWSER.navTimeoutMs);
      await page.waitForTimeout(1500);
    }

    const data = await page.evaluate(() => {
      // 1) JSON-LD AggregateRating
      const dig = (node) => {
        if (!node || typeof node !== 'object') return null;
        if (node.aggregateRating) return node.aggregateRating;
        for (const v of Object.values(node)) {
          const r = Array.isArray(v) ? v.map(dig).find(Boolean) : dig(v);
          if (r) return r;
        }
        return null;
      };
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const agg = dig(JSON.parse(s.textContent));
          if (agg && agg.ratingValue != null) {
            return {
              rating: parseFloat(agg.ratingValue),
              count: parseInt(agg.reviewCount || agg.ratingCount || 0, 10) || 0,
              via: 'json-ld',
            };
          }
        } catch {}
      }
      // 2) Amazon DOM
      const pop = document.querySelector('#acrPopover');
      const cnt = document.querySelector('#acrCustomerReviewText');
      if (pop && cnt) {
        const r = /([0-5](?:\.\d)?)/.exec(pop.getAttribute('title') || pop.textContent || '');
        const c = /([\d,]+)/.exec(cnt.textContent || '');
        if (r) return { rating: parseFloat(r[1]), count: c ? parseInt(c[1].replace(/,/g, ''), 10) : 0, via: 'amazon-dom' };
      }
      // 3) plain text
      const body = (document.body.innerText || '').slice(0, 8000);
      const r = /([0-5](?:\.\d)?)\s*(?:out of|\/)\s*5/i.exec(body);
      const c = /([\d,]+)\s*(?:ratings|reviews)/i.exec(body);
      if (r && c) return { rating: parseFloat(r[1]), count: parseInt(c[1].replace(/,/g, ''), 10), via: 'text' };
      return null;
    });

    if (!data) throw new Error('no rating data found on product page');
    return { ...data, url: page.url().slice(0, 200) };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { fetchS26Reviews };
