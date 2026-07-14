'use strict';

/**
 * share.js — Samsung shelf-share scraper (ported from the Python
 * samsung-visibility-audit pipeline built 2026-07-03).
 *
 * Two measurements per site, both optional and configured in config.js:
 *
 *   measureDeviceShare(site)  — site.devices
 *     Loads the mobile-devices catalog grid, expands it up to `pages` pages
 *     (load-more button or infinite scroll), and reports what share of the
 *     collected product cards is Samsung.
 *
 *   measureSearchShare(site)  — site.search
 *     kind 'grid'  : loads a search-results grid for `term` and reports the
 *                    Samsung share of the first `maxPositions` results.
 *     kind 'facet' : for sites with no text search (du): loads the catalog
 *                    unfiltered and with the samsung brand facet applied, and
 *                    reports samsungTotal / grandTotal from the paging counter.
 *
 * Samsung matching mirrors the audit pipeline: if the site declares a brand
 * label on the card, trust it (exact 'samsung' substring). Otherwise fall back
 * to text signals on title/link — the literal brand is often absent on telecom
 * storefronts; "Galaxy <model>" and du's "-SAM-" SKU fragment are the real
 * signals.
 */

const {
  launchStealthContext,
  gotoWithRetry,
  dismissConsent,
  detectBlock,
} = require('./scraper');
const { BROWSER, brandOf } = require('./config');

const SAMSUNG_PATTERNS = [/samsung/i, /\bgalaxy\b/i, /-SAM-/];

function isSamsungText(...texts) {
  return texts.some((t) => t && SAMSUNG_PATTERNS.some((re) => re.test(t)));
}

function sharePct(samsung, total) {
  if (!total) return null;
  return Math.round((samsung / total) * 1000) / 10;
}

// Serialized into the page: read one card's brand/title/link per selector config.
function collectCardsInPage({ card, brand, title }) {
  const pick = (el, sel) => {
    if (!sel) return '';
    // '@self': the card's own text — for sites whose cards carry no anchors
    // or dedicated title element (Vodafone's JS-navigation cards).
    if (sel === '@self') return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const n = el.querySelector(sel);
    return n ? (n.textContent || '').replace(/\s+/g, ' ').trim() : '';
  };
  return Array.from(document.querySelectorAll(card)).map((el) => {
    const a = el.tagName === 'A' ? el : el.querySelector('a[href]');
    return {
      brand: pick(el, brand),
      title: pick(el, title),
      href: a ? a.getAttribute('href') || '' : '',
    };
  });
}

class ShareParseError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ShareParseError';
  }
}

// Read the grid's grand total ("40 of 162", "Showing 96 Result(s)") from the
// configured counter element. Selector configured but unreadable = selector
// drift — refuse to guess, exactly like the Python parser.
async function readGrandTotal(page, cfg) {
  if (!cfg.totalSelector) return null;
  const text = await page
    .evaluate((sel) => {
      const n = document.querySelector(sel);
      return n ? (n.textContent || '').replace(/\s+/g, ' ').trim() : null;
    }, cfg.totalSelector)
    .catch(() => null);
  const pattern = cfg.totalPattern || /(\d+)\s*(?:of|\/)\s*(\d+)/;
  const m = text && pattern.exec(text);
  if (!m) {
    throw new ShareParseError(
      `total-count selector ${cfg.totalSelector} configured but count not readable ` +
        `(saw ${JSON.stringify(text)}). Selector drift; refusing to guess.`
    );
  }
  return parseInt(m[m.length - 1], 10); // last capture group = grand total
}

async function cardCount(page, cardSel) {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, cardSel);
}

// Expand the grid by one "page": click a load-more control if one exists,
// otherwise scroll to the bottom (infinite scroll). Returns true if the card
// count actually grew.
async function expandOnce(page, cfg) {
  const before = await cardCount(page, cfg.card);

  const clicked = await page
    .evaluate((sel) => {
      const re = /load more|show more|view more|see more|more results/i;
      const candidates = sel
        ? Array.from(document.querySelectorAll(sel))
        : Array.from(document.querySelectorAll("button, a, [role='button']"));
      for (const n of candidates) {
        const txt = (n.innerText || n.getAttribute('aria-label') || '').trim();
        if ((sel || re.test(txt)) && n.offsetParent !== null) {
          n.scrollIntoView({ block: 'center' });
          n.click();
          return true;
        }
      }
      return false;
    }, cfg.loadMoreSelector || null)
    .catch(() => false);

  if (!clicked) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  }

  // Poll for growth; grids load in over a few seconds. Some "show more"
  // anchors truly navigate (Shopify ?page=2) — the count check tolerates the
  // context swap, and a navigated page that merely REPLACED the grid won't
  // grow past `before`, so the loop ends cleanly. JS-intercepted anchors that
  // APPEND (Emax) keep expanding toward the 5-page target.
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    const now = await cardCount(page, cfg.card).catch(() => 0);
    if (now > before) return true;
  }
  return false;
}

async function firstCardId(page, cardSel) {
  // .catch: pagination that truly navigates (Amazon's Next) destroys the
  // execution context mid-poll — treat as "not readable yet", not an error.
  return page
    .evaluate((sel) => {
      const card = document.querySelector(sel);
      if (!card) return null;
      const a = card.tagName === 'A' ? card : card.querySelector('a[href]');
      return (a && a.getAttribute('href')) || (card.textContent || '').slice(0, 120);
    }, cardSel)
    .catch(() => null);
}

// Numbered pager that REPLACES the grid per page (Sharaf DG's Algolia widget:
// span.go-to-page[data-page]). Click page n, then wait for the first card to
// actually change so we don't re-collect page n-1.
async function clickPagerPage(page, cfg, n) {
  const before = await firstCardId(page, cfg.card);
  const clicked = await page
    .evaluate(
      ({ sel, n }) => {
        const nodes = Array.from(document.querySelectorAll(sel));
        const target = nodes.find(
          (el) => ((el.getAttribute && el.getAttribute('data-page')) || (el.textContent || '').trim()) === String(n)
        );
        if (!target) return false;
        target.scrollIntoView({ block: 'center' });
        target.click();
        return true;
      },
      { sel: cfg.pagerSelector, n }
    )
    .catch(() => false);
  if (!clicked) return false;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    const now = await firstCardId(page, cfg.card);
    if (now && now !== before) return true;
  }
  return false;
}

// Next-button pagination (Ooredoo's eshop: numbered pages aren't exposed and
// ?page= is ignored — only the Next arrow advances the grid, replacing it).
async function clickNextButton(page, cfg) {
  const before = await firstCardId(page, cfg.card);
  const clicked = await page
    .evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("button, a, [role='button']"));
      for (const n of nodes) {
        const txt = (n.innerText || n.getAttribute('aria-label') || '').trim();
        if (/^next\b/i.test(txt) && n.offsetParent !== null && !n.disabled) {
          n.scrollIntoView({ block: 'center' });
          n.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
  if (!clicked) return false;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    const now = await firstCardId(page, cfg.card);
    if (now && now !== before) return true;
  }
  return false;
}

// Load a grid URL and wait until product cards are actually rendered (both
// du and e& grids are JS-rendered SPAs; DOM-ready is not enough).
async function openGrid(page, site, url, cfg) {
  await gotoWithRetry(page, url, BROWSER.navTimeoutMs);
  await dismissConsent(page, site);
  await detectBlock(page);
  await page.waitForSelector(cfg.card, { timeout: 30000 });
  await page.waitForTimeout(1000); // let the first batch settle
}

function tallyCards(cards, maxPositions) {
  const window = maxPositions ? cards.slice(0, maxPositions) : cards;
  const positions = [];
  const brands = {}; // competition analysis: every card classified to a brand
  window.forEach((c, i) => {
    const hit = c.brand
      ? c.brand.toLowerCase().includes('samsung') // site declares brand: trust it
      : isSamsungText(c.title, c.href);
    if (hit) positions.push(i + 1);
    const b = hit ? 'samsung' : brandOf(`${c.brand || ''} ${c.title || ''} ${c.href || ''}`);
    brands[b] = (brands[b] || 0) + 1;
  });
  return { total: window.length, samsung: positions.length, positions, brands };
}

// Merge per-term/per-page brand maps into one.
function mergeBrands(...maps) {
  const out = {};
  for (const m of maps) {
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) out[k] = (out[k] || 0) + v;
  }
  return out;
}

async function measureDeviceShare(site) {
  const cfg = site.devices;
  if (!cfg) return null;
  const { browser, context } = await launchStealthContext(site);
  try {
    const page = await context.newPage();
    await openGrid(page, site, cfg.url, cfg);

    const collect = () =>
      page.evaluate(collectCardsInPage, {
        card: cfg.card,
        brand: cfg.brand || null,
        title: cfg.title || null,
      });

    let pages = 1;
    let cards;
    const wantPages = cfg.pages || 5;
    if (cfg.pagerSelector || cfg.nextButton) {
      // Page-replacing pager: accumulate each page's cards as we click through.
      cards = await collect();
      while (pages < wantPages) {
        const advanced = cfg.nextButton
          ? await clickNextButton(page, cfg)
          : await clickPagerPage(page, cfg, pages + 1);
        if (!advanced) break;
        pages++;
        cards = cards.concat(await collect());
      }
    } else {
      // Appending grid (load-more / infinite scroll): expand, then read once.
      while (pages < wantPages) {
        if (!(await expandOnce(page, cfg))) break; // grid exhausted or no pager
        pages++;
      }
      cards = await collect();
    }

    const { total, samsung, positions, brands } = tallyCards(cards, cfg.maxCards);
    const grandTotal = await readGrandTotal(page, cfg);

    return {
      kind: 'grid',
      url: cfg.url,
      pages,
      total,
      samsung,
      positions,
      brands,
      sharePct: sharePct(samsung, total),
      grandTotal,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// Measure one search term on its results grid. Own page per term so terms
// can't bleed SPA state into each other.
async function measureOneTerm(context, site, cfg, term) {
  const page = await context.newPage();
  try {
    const url = cfg.url.includes('{q}') ? cfg.url.replace('{q}', encodeURIComponent(term)) : cfg.url;
    await openGrid(page, site, url, cfg);

    // Grids that render few cards initially (e& shows 10) must be expanded
    // until the judgment window (default 24 results) is actually on the page.
    const want = cfg.maxPositions || 24;
    while ((await cardCount(page, cfg.card)) < want) {
      if (!(await expandOnce(page, cfg))) break;
    }

    const cards = await page.evaluate(collectCardsInPage, {
      card: cfg.card,
      brand: cfg.brand || null,
      title: cfg.title || null,
    });
    const { total, samsung, positions, brands } = tallyCards(cards, want);
    const grandTotal = await readGrandTotal(page, cfg);
    return { term, url, total, samsung, positions, brands, sharePct: sharePct(samsung, total), grandTotal };
  } finally {
    await page.close().catch(() => {});
  }
}

// Aggregate per-term results into the stored shape. Top-level total/samsung/
// sharePct summarize across terms so diffing and display stay uniform with
// device shares; `results` carries the per-term breakdown.
function aggregateTerms(kind, results, note) {
  const ok = results.filter((r) => !r.error);
  const total = ok.reduce((n, r) => n + r.total, 0);
  const samsung = ok.reduce((n, r) => n + r.samsung, 0);
  return {
    kind,
    term: results.map((r) => r.term).join(', '),
    results,
    total,
    samsung,
    brands: mergeBrands(...ok.map((r) => r.brands)),
    sharePct: sharePct(samsung, total),
    note,
  };
}

async function measureSearchShare(site) {
  const cfg = site.search;
  if (!cfg) return null;
  const { browser, context } = await launchStealthContext(site);
  try {
    if (cfg.kind === 'facet') {
      // Two fresh page loads: the SPA reads the brand hash on load only.
      const pageAll = await context.newPage();
      await openGrid(pageAll, site, cfg.allUrl, cfg);
      const grandTotal = await readGrandTotal(pageAll, cfg);
      await pageAll.close();

      const pageSam = await context.newPage();
      await openGrid(pageSam, site, cfg.samsungUrl, cfg);
      const samsungTotal = await readGrandTotal(pageSam, cfg);

      const term = cfg.term || 'phones';
      return {
        kind: 'facet',
        term,
        results: [
          { term, url: cfg.samsungUrl, total: grandTotal, samsung: samsungTotal, sharePct: sharePct(samsungTotal, grandTotal), grandTotal },
        ],
        total: grandTotal,
        samsung: samsungTotal,
        sharePct: sharePct(samsungTotal, grandTotal),
        grandTotal,
        note: cfg.note,
      };
    }

    const terms = Array.isArray(cfg.terms) && cfg.terms.length && cfg.url.includes('{q}')
      ? cfg.terms
      : [cfg.term || 'phones'];

    const results = [];
    for (const term of terms) {
      try {
        results.push(await measureOneTerm(context, site, cfg, term));
      } catch (err) {
        results.push({ term, error: err.message });
      }
    }
    if (!results.some((r) => !r.error)) {
      throw new ShareParseError(
        `all ${results.length} search term(s) failed (first: ${results[0].error})`
      );
    }
    return aggregateTerms('grid', results, cfg.note);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { measureDeviceShare, measureSearchShare, isSamsungText, ShareParseError };

// ---- CLI: prove the share scraper against a single site ----
// Usage: node banner-monitor/share.js [siteId]
if (require.main === module) {
  require('dotenv').config();
  const { SITES } = require('./config');
  const wantId = process.argv[2] || 'du';
  const site = SITES.find((s) => s.id === wantId);
  if (!site) {
    console.error(`Unknown site id "${wantId}"`);
    process.exit(1);
  }
  (async () => {
    if (site.devices) {
      console.log(`\n[share] Device grid for ${site.name} (${site.devices.url})`);
      const d = await measureDeviceShare(site);
      console.log(JSON.stringify(d, null, 2));
    } else {
      console.log(`[share] ${site.name}: no devices config`);
    }
    if (site.search) {
      console.log(`\n[share] Search share for ${site.name}`);
      const s = await measureSearchShare(site);
      console.log(JSON.stringify(s, null, 2));
    } else {
      console.log(`[share] ${site.name}: no search config`);
    }
    process.exit(0);
  })().catch((err) => {
    console.error('[share] FAILED:', err);
    process.exit(1);
  });
}
