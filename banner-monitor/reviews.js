'use strict';

/**
 * reviews.js — Galaxy S26 Ultra review count + average rating per site.
 *
 * Generic: loads the configured product page (or finds the product from a
 * search/catalog URL via cfg.findProduct), then extracts AggregateRating from
 * JSON-LD — the structured data virtually every e-commerce site embeds.
 * Falls back to Amazon's DOM ids and a plain-text pattern.
 */

const { launchStealthContext, gotoWithRetry, dismissConsent, detectBlock, autoScroll } = require('./scraper');
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

    // The authoritative summary (avg score + total ratings) lives in the
    // reviews section at the BOTTOM of the product page — scroll fully so
    // lazy sections render, then read compact review/rating widgets and
    // prefer the lowest one on the page.
    await autoScroll(page);
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      const candidates = [];
      document
        .querySelectorAll('[class*="review" i], [class*="rating" i], [id*="review" i], [id*="rating" i]')
        .forEach((el) => {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 400) return; // summary widgets are compact
          const c = /([\d,]+)\s*(?:global ratings|total ratings|ratings|reviews)/i.exec(t);
          if (!c) return;
          const r =
            /([0-5](?:\.\d)?)\s*(?:out of\s*5|\/\s*5|based)/i.exec(t) || /(?:^|\s)([0-5]\.\d)(?:\s|$)/.exec(t);
          if (!r) return;
          const rating = parseFloat(r[1]);
          const count = parseInt(c[1].replace(/,/g, ''), 10);
          if (rating >= 0 && rating <= 5 && count > 0) {
            candidates.push({ rating, count, y: el.getBoundingClientRect().top + window.scrollY });
          }
        });
      if (candidates.length) {
        candidates.sort((a, b) => b.y - a.y); // bottom-most first
        const best = candidates[0];
        return { rating: best.rating, count: best.count, via: 'review-section' };
      }
      // Fallbacks: Amazon's header widget, then JSON-LD.
      const pop = document.querySelector('#acrPopover');
      const cnt = document.querySelector('#acrCustomerReviewText');
      if (pop && cnt) {
        const r = /([0-5](?:\.\d)?)/.exec(pop.getAttribute('title') || pop.textContent || '');
        const c = /([\d,]+)/.exec(cnt.textContent || '');
        if (r) return { rating: parseFloat(r[1]), count: c ? parseInt(c[1].replace(/,/g, ''), 10) : 0, via: 'amazon-dom' };
      }
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
