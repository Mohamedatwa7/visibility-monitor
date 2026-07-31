'use strict';

/**
 * scraper.js — Playwright-based Samsung banner counter.
 *
 * export countSamsungBanners(site) => { count, matches: [{key, src, alt, href}], screenshotPath }
 *
 * Approach: we render the page with a real headless Chromium, dismiss consent,
 * auto-scroll so lazy carousels/below-the-fold banners load, then collect a broad
 * set of *candidate* banner nodes IN-PAGE (returning their raw signals). Matching
 * + dedupe happens back in Node so the per-site regex is easy to apply and tune.
 *
 * KNOWN LIMITATIONS (expected — tune over time):
 *   - Banners rendered inside cross-origin <iframe>s are NOT reachable from the
 *     top document and will be missed.
 *   - CSS sprite sheets (one image holding many banners) count as a single image,
 *     so individual promos inside a sprite cannot be told apart.
 *   - Detection is signal/regex based; copy changes per partner re-skin, so the
 *     regex and container selectors are meant to be adjusted per site over time.
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { BROWSER, CONTAINER_REGEX, getRegexFor, brandOf, divisionOf } = require('./config');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

function todayStamp() {
  // YYYY-MM-DD in the configured (Gulf) timezone, stable for screenshot filenames.
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BROWSER.timezoneId,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d); // en-CA gives YYYY-MM-DD
}

function safeFileId(id) {
  return String(id).replace(/[^a-z0-9_-]+/gi, '_');
}

// Normalise an image/href URL into a stable dedupe key:
// strip query + hash, lowercase. Falls back to the raw string if not a URL.
// keepQuery: for CDNs where the query IS the image identity (du serves every
// creative from .../Satellite?blobwhere=<id>), stripping it would collapse
// all images into one key — keep the query and drop only the hash.
function normalizeUrl(u, keepQuery) {
  if (!u) return '';
  try {
    const url = new URL(u, 'https://x.invalid');
    if (!keepQuery) url.search = '';
    url.hash = '';
    return url.toString().toLowerCase();
  } catch {
    return String(u).split(keepQuery ? /#/ : /[?#]/)[0].trim().toLowerCase();
  }
}

// Dismiss cookie/consent overlays. Tries a site-provided selector first, then a
// set of common ones, then any visible button whose text looks like consent.
async function dismissConsent(page, site) {
  const selectors = [
    site.consentSelector,
    '#onetrust-accept-btn-handler',
    '#truste-consent-button',
    '.cookie-accept',
    "[aria-label*='accept' i]",
    "button[id*='accept' i]",
    "button[class*='accept' i]",
  ].filter(Boolean);

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout: 2500 });
        await page.waitForTimeout(400);
        return true;
      }
    } catch {
      /* keep trying */
    }
  }

  // Fallback: scan buttons / links by text content.
  try {
    const clicked = await page.evaluate(() => {
      const re = /accept|agree|allow|got it|موافق|أوافق/i;
      const nodes = Array.from(
        document.querySelectorAll("button, [role='button'], a, input[type='button'], input[type='submit']")
      );
      for (const n of nodes) {
        // Never click an anchor that actually navigates — "I agree"-style
        // LINKS lead to terms pages (Omantel's took us to a legal page).
        if (n.tagName === 'A') {
          const href = n.getAttribute('href') || '';
          if (href && !/^#|^javascript:/i.test(href)) continue;
        }
        const txt = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
        if (txt && txt.length < 40 && re.test(txt)) {
          n.click();
          return txt;
        }
      }
      return null;
    });
    if (clicked) {
      await page.waitForTimeout(400);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

// Scroll to the bottom in steps so lazy carousels/images load, then back to top.
async function autoScroll(page) {
  await page.evaluate(
    async ({ step, delay }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let last = -1;
      // Bound the loop so a pathological infinite-scroll page can't hang us.
      for (let i = 0; i < 60; i++) {
        window.scrollBy(0, step);
        await sleep(delay);
        const h = document.body.scrollHeight;
        if (window.scrollY + window.innerHeight >= h) {
          if (h === last) break; // height stopped growing and we're at bottom
          last = h;
        }
      }
      window.scrollTo(0, 0);
      await sleep(300);
    },
    { step: BROWSER.scrollStepPx, delay: BROWSER.scrollDelayMs }
  );
}

// Collect candidate banner nodes + their raw signals, entirely in the page.
// Matching/dedupe is done in Node (see below) so the regex stays editable.
function collectCandidatesInPage({ containerSource, containerFlags }) {
  const CONTAINER = new RegExp(containerSource, containerFlags);

  const bgUrl = (el) => {
    const styles = [el.style && el.style.backgroundImage, getComputedStyle(el).backgroundImage];
    for (const s of styles) {
      if (s && s !== 'none') {
        const m = /url\((['"]?)(.*?)\1\)/i.exec(s);
        if (m && m[2]) return m[2];
      }
    }
    return '';
  };
  const cls = (el) => `${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`;
  const nearestContainerText = (el) => {
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      if (CONTAINER.test(cls(cur))) break;
      cur = cur.parentElement;
    }
    const target = cur || el.closest('a') || el.parentElement || el;
    const t = (target.innerText || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 300);
  };

  // A single banner is usually one carousel *slide* or one promo block. We tag
  // the nearest such block with a stable id so a banner's image + button + text
  // all collapse to ONE count (instead of each DOM node counting separately).
  // We deliberately match slide/banner-LEVEL classes, not the outer carousel
  // wrapper, so individual slides stay distinct.
  const BLOCK = /swiper-slide|slick-slide|carousel-item|\bslide\b|\bbanner\b|\bpromo\b|\bcampaign\b|hero/i;
  let blockCounter = 0;
  const blockIds = new WeakMap();
  // Returns the slide/banner block's dedupe key AND its rendered width — a
  // hero creative is often a modest <img> inside a full-width slide (e&'s
  // 792px img sits in a 1200px eand-rmp-hero-banner-tile), so the slide's
  // width, not the image's, is what says "this is the big picture".
  const blockInfoFor = (el) => {
    // Innermost match keeps the historic dedupe key + width; `all` collects
    // every block-ish ancestor (slide-bg AND its slick-slide AND the carousel
    // wrapper) so a slide's image and its CTA — which sit in different
    // sub-blocks — can be recognized as one placement later.
    let cur = el;
    let first = null;
    const all = [];
    for (let i = 0; i < 8 && cur; i++) {
      if (BLOCK.test(cls(cur))) {
        let id = blockIds.get(cur);
        if (id == null) {
          id = ++blockCounter;
          blockIds.set(cur, id);
        }
        if (!first) {
          const r = cur.getBoundingClientRect ? cur.getBoundingClientRect() : { width: 0 };
          first = { key: 'block#' + id, w: Math.round(r.width) || 0 };
        }
        all.push('block#' + id);
      }
      cur = cur.parentElement;
    }
    return first ? { key: first.key, w: first.w, all } : { key: '', w: 0, all };
  };
  // Text belonging to THIS candidate's own slide/tile (not the surrounding
  // carousel, whose innerText contains every sibling slide's caption). Used by
  // sites that opt into text matching (matchBlockText) because their creatives
  // are brand-anonymous (du's Satellite blob URLs) and only the caption says
  // "Galaxy S26 Ultra".
  const blockTextFor = (el) => {
    // Nearest ancestor with real, tile-sized text = this candidate's own
    // caption ("Samsung Fold 7 Starting at…"). du's reskin uses utility-class
    // markup with no slide/banner classes, so class-based block lookup fails;
    // and climbing too far bleeds a sibling tile's "Galaxy" onto iPhone tiles.
    // Icon-font ligature names (arrow_outward etc.) are text nodes too — strip
    // them so an icon wrapper doesn't satisfy the "has text" test.
    const clean = (s) =>
      (s || '')
        .replace(/\b(?:arrow|chevron|keyboard|navigate|expand)_\w+\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    let cur = el;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      const t = clean(cur.innerText);
      if (t.length >= 8) return t.slice(0, 200);
      cur = cur.parentElement;
    }
    return '';
  };

  // Site chrome (nav/header/footer/mega-menu) is not a promo banner.
  const chromeSel =
    'header, nav, footer, [class*="mega" i], [class*="navbar" i], [class*="navigation" i], [id*="footer" i], [id*="header" i]';
  const inChrome = (el) => !!(el.closest && el.closest(chromeSel));

  const els = new Set();
  // 1) every img
  document.querySelectorAll('img').forEach((e) => els.add(e));
  // 2) every <a> that contains an image or has a background-image
  document.querySelectorAll('a').forEach((a) => {
    if (a.querySelector('img') || bgUrl(a)) els.add(a);
  });
  // 3) every element with an inline background-image: url(...)
  document.querySelectorAll('[style]').forEach((e) => {
    const s = e.style && e.style.backgroundImage;
    if (s && /url\(/i.test(s)) els.add(e);
  });
  // 4) carousel/banner containers + their relevant descendants
  document.querySelectorAll('*').forEach((e) => {
    if (CONTAINER.test(cls(e))) {
      els.add(e);
      e.querySelectorAll('img, a, [style*="background"]').forEach((d) => els.add(d));
    }
  });

  // True document order — the Set was built in PASS order (all imgs, then all
  // anchors…), which scrambled carousel positions. Sorting here lets the
  // classifier assign slide numbers that match what a visitor sees.
  const ordered = Array.from(els).sort((a, b) =>
    a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
  const scrollYNow = window.scrollY || window.pageYOffset || 0;
  // Carousel clones (swiper/slick/owl loop mode duplicates slides) — they'd
  // steal position 1 from the real first slide.
  const CLONE_SEL = '.swiper-slide-duplicate, .slick-cloned, .owl-item.cloned, [class*="-clone" i]';

  const out = [];
  ordered.forEach((el, docIdx) => {
    const anchor = el.closest('a');
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const blockInfo = blockInfoFor(el);
    out.push({
      tag: el.tagName,
      w: Math.max((rect && Math.round(rect.width)) || 0, blockInfo.w),
      ownW: (rect && Math.round(rect.width)) || 0,
      top: rect ? Math.round(rect.top + scrollYNow) : null,
      docIdx,
      clone: !!(el.closest && el.closest(CLONE_SEL)),
      src: el.tagName === 'IMG' ? el.currentSrc || el.src || '' : '',
      srcset: el.getAttribute ? el.getAttribute('srcset') || '' : '',
      alt: el.getAttribute ? el.getAttribute('alt') || '' : '',
      ariaLabel: el.getAttribute ? el.getAttribute('aria-label') || '' : '',
      title: el.getAttribute ? el.getAttribute('title') || '' : '',
      href: anchor ? anchor.href || '' : '',
      bg: bgUrl(el),
      text: nearestContainerText(el),
      blockText: blockTextFor(el),
      block: blockInfo.key,
      blockAll: blockInfo.all,
      inChrome: inChrome(el),
    });
  });
  return out;
}

// Many Gulf telecom sites sit behind WAFs (F5 BIG-IP, Imperva) that serve a
// block/challenge page to obvious automation. Detect those so we report an
// ERROR instead of silently recording "0 banners" (which would fire a bogus
// "count dropped" alert). NOTE: this is best-effort — sophisticated JA3/TLS
// fingerprinting can still block us and would need a real browser/proxy.
const BLOCK_RE =
  /request rejected|the requested url was rejected|has been blocked|access denied|attention required|verify you are (?:a )?human|verif(?:y|ies) (?:that )?you are (?:not )?a? ?(?:bot|human)|are you a robot|unusual traffic|pardon the interruption|performing security verification|security service to protect|checking your browser|just a moment/i;

class BlockedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BlockedError';
  }
}

async function detectBlock(page) {
  try {
    const title = (await page.title()) || '';
    const bodyText = await page.evaluate(() =>
      document.body ? document.body.innerText.slice(0, 2000) : ''
    );
    if (BLOCK_RE.test(title) || BLOCK_RE.test(bodyText)) {
      const snippet = (title + ' ' + bodyText).replace(/\s+/g, ' ').trim().slice(0, 120);
      throw new BlockedError(`WAF/bot block detected ("${snippet}")`);
    }
  } catch (err) {
    if (err instanceof BlockedError) throw err;
    /* title/body read failed — ignore */
  }
}

async function gotoWithRetry(page, url, timeout) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout });
  } catch (err) {
    // Some sites keep long-lived connections open (analytics/websockets) so
    // 'networkidle' never settles even though the page is fully rendered.
    // Retry with 'domcontentloaded' + a fixed settle wait for lazy content.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
  }
}

// Launch a stealth browser context tuned for the given site. Shared by the
// banner scraper and the device/search share scraper (share.js).
async function launchStealthContext(site) {
  const browser = await chromium.launch({
    headless: true,
    // Hide the most obvious automation tells so basic WAF checks pass.
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      // noon.com resets automated HTTP/2 connections (TLS/h2 fingerprinting);
      // downgrading to HTTP/1.1 gets a normal response.
      ...(site.disableHttp2 ? ['--disable-http2'] : []),
    ],
  });
  const context = await browser.newContext({
    userAgent: BROWSER.userAgent,
    viewport: BROWSER.viewport,
    locale: site.locale || BROWSER.locale,
    timezoneId: site.timezoneId || BROWSER.timezoneId,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' },
  });
  // Stealth init: strip the headless/automation fingerprints WAFs look for.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ar'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  return { browser, context };
}

async function countSamsungBanners(site) {
  const regex = getRegexFor(site);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const screenshotPath = path.join(SCREENSHOT_DIR, `${safeFileId(site.id)}-${todayStamp()}.png`);

  const { browser, context } = await launchStealthContext(site);
  try {
    const page = await context.newPage();

    await gotoWithRetry(page, site.url, BROWSER.navTimeoutMs);
    await dismissConsent(page, site);
    await detectBlock(page); // throws BlockedError -> recorded as error, not 0
    await autoScroll(page);

    const candidates = await page.evaluate(collectCandidatesInPage, {
      containerSource: CONTAINER_REGEX.source,
      containerFlags: CONTAINER_REGEX.flags,
    });

    await page.screenshot({ path: screenshotPath, fullPage: true });

    // ---- Match + dedupe in Node ----
    // Icons / UI chrome assets and slide pagination ("1 / 9") are not banners.
    // Lazy-load placeholders (Sharaf DG's SharafDG-gray.jpg, generic blank/1x1
    // pixels) are treated the same as icons: the element may still count via
    // its promo href, but the placeholder image is not a creative and must not
    // become a dedupe key (identical placeholder URLs would collapse distinct
    // tiles into one).
    const ICON_RE =
      /(\/svg-icons\/|\/icons\/|\bicon[-_]|chevron|arrow|sprite|favicon|\.svg(?:$|\?)|placeholder|[-_]gray\.(?:jpg|jpeg|png)|\bblank\.(?:gif|png)|\b1x1\.)/i;
    // Analytics/ad tracking pixels are <img> elements but not placements —
    // their query strings also poison brand detection (bing's "&lg=en-AE"
    // read as LG). Drop them before any classification.
    const TRACKER_RE =
      /bat\.bing\.com|google-analytics|googletagmanager|doubleclick\.net|googleadservices|facebook\.com\/tr\b|connect\.facebook|hotjar|clarity\.ms|criteo|\/beacon|\/pixel\b|snr\.snapchat|tiktok\.com\/i18n|analytics\./i;
    const COUNTER_RE = /^\s*\d+\s*\/\s*\d+\s*$/;

    // Placements are classified into THREE sections (user-defined 2026-07-08):
    //   hero  — the big campaign picture, usually the top carousel (wide creative)
    //   promo — promotional boxes/cards ("Get the new Galaxy Z Fold7 …")
    //   tile  — a product on the page with price / add-to-cart
    // tileRegex (per-site, against href + alt + caption) decides tiles;
    // among the rest, rendered width ≥ heroMinWidth (default 900px) = hero.
    const HERO_MIN_W = site.heroMinWidth || 900;

    // One merged record per placement key: dedupe first, classify after, so a
    // hero's full-width slide and its small inner button agree on one class.
    const byKey = new Map(); // key -> {src, alt, href, w, tile, samsung}
    for (const c of candidates) {
      if (c.inChrome) continue; // skip nav/header/footer/mega-menu
      if (c.clone) continue; // carousel loop duplicates — the original slide is also in the DOM
      if (TRACKER_RE.test(c.src || '') || TRACKER_RE.test(c.href || '')) continue;

      // The candidate's own creative image (ignore icon/placeholder assets).
      let imageUrl = c.src || c.bg || '';
      if (imageUrl && ICON_RE.test(imageUrl)) imageUrl = '';

      const text = (c.text || '').replace(/\s+/g, ' ').trim();

      // ---- brand-agnostic placement tests (define the denominators) ----
      // A real placement has a creative (image/bg) or is a clickable promo (href).
      if (!imageUrl && !c.href) continue;
      // Guard against pagination/counter labels sneaking in via href-less nodes.
      if (!imageUrl && COUNTER_RE.test(text)) continue;

      // Dedupe key: 'href' = one placement per destination (collapses carousel
      // clones and the image-vs-placeholder split of one tile); 'image-query'
      // for CDNs whose image identity lives in the query string (du); default
      // = slide/banner block, then image, then href.
      let key;
      const imageDedupe = site.bannerDedupe === 'image' || site.bannerDedupe === 'image-query';
      if (site.bannerDedupe === 'href' && (c.href || imageUrl)) {
        key = c.href ? normalizeUrl(c.href) : normalizeUrl(imageUrl);
      } else if (imageDedupe && imageUrl) key = normalizeUrl(imageUrl, site.bannerDedupe === 'image-query');
      else if (c.block) key = c.block;
      else if (imageUrl) key = normalizeUrl(imageUrl);
      else key = normalizeUrl(c.href);

      const isTile = !!(
        site.tileRegex && site.tileRegex.test(`${c.href} ${c.alt} ${c.blockText || ''}`)
      );

      // ---- Samsung test ----
      // Match ONLY on the candidate's own signals — NOT the surrounding
      // container text. Container text bleeds: it makes arrows, pagination,
      // and even rival-brand logos near a "Samsung" heading match.
      // Exception: sites with matchBlockText also match the candidate's OWN
      // slide/tile caption (du serves brand-anonymous blob image URLs; only
      // the tile text says "Galaxy S26 Ultra").
      const ownSignals = [imageUrl, c.srcset, c.alt, c.ariaLabel, c.title, c.href];
      if (site.matchBlockText) ownSignals.push(c.blockText);
      const isSamsung = ownSignals.some((s) => s && regex.test(s));

      const label =
        c.alt ||
        c.ariaLabel ||
        c.title ||
        (site.matchBlockText && c.blockText ? c.blockText.slice(0, 100) : '') ||
        (text ? text.slice(0, 100) : '');

      const rec =
        byKey.get(key) ||
        { key, src: '', alt: '', href: '', w: 0, ownW: 0, top: null, docIdx: Infinity, tile: false, samsung: false, sig: '' };
      if (!rec.src && imageUrl) rec.src = imageUrl;
      if (!rec.href && c.href) rec.href = c.href;
      if (!rec.alt && label) rec.alt = label;
      rec.w = Math.max(rec.w, c.w || 0);
      // Document position: topmost/first sighting wins (slide order).
      if (c.top != null && (rec.top == null || c.top < rec.top)) rec.top = c.top;
      if (c.docIdx != null && c.docIdx < rec.docIdx) rec.docIdx = c.docIdx;
      // The candidate element's own creative width (no block inflation) —
      // stops a small logo inside a full-width strip from reading as a hero.
      if (imageUrl) rec.ownW = Math.max(rec.ownW, c.ownW || 0);
      rec.tile = rec.tile || isTile;
      rec.samsung = rec.samsung || isSamsung;
      for (const b of c.blockAll || (c.block ? [c.block] : [])) (rec.blocks = rec.blocks || new Set()).add(b);
      // Accumulated signal text for brand/division classification (competition
      // analysis) — same signals the Samsung test reads.
      rec.sig = `${rec.sig} ${ownSignals.filter(Boolean).join(' ')}`.slice(0, 600);
      byKey.set(key, rec);
    }

    // A slide's image and its CTA link often carry DIFFERENT dedupe keys (the
    // <img> has no href; the link-only <a> has no creative), so one carousel
    // slide counts twice (Zain KW: 9 slides read as 17). Merge every link-only
    // record into the image-bearing record that shares its slide block.
    {
      // block -> every image-bearing record touching it. A merge only happens
      // through a block with EXACTLY ONE image record: per-slide blocks
      // qualify, carousel-wide wrappers (shared by all slides) never do.
      const imageRecsByBlock = new Map();
      for (const r of byKey.values()) {
        if (!r.src || !r.blocks) continue;
        for (const b of r.blocks) {
          const list = imageRecsByBlock.get(b) || [];
          if (!list.includes(r)) list.push(r);
          imageRecsByBlock.set(b, list);
        }
      }
      for (const [key, r] of Array.from(byKey.entries())) {
        if (r.src || !r.blocks) continue; // only link-only records
        let host = null;
        for (const b of r.blocks) {
          const list = imageRecsByBlock.get(b);
          if (list && list.length === 1 && list[0] !== r) {
            host = list[0];
            break;
          }
        }
        if (!host) continue;
        if (!host.href && r.href) host.href = r.href;
        if (!host.alt && r.alt) host.alt = r.alt;
        host.w = Math.max(host.w, r.w);
        host.tile = host.tile || r.tile;
        host.samsung = host.samsung || r.samsung;
        host.sig = `${host.sig} ${r.sig}`.slice(0, 600);
        // Keep the creative's geometry — link-only anchors are often hidden
        // (rect at 0,0) and would corrupt the band/position data.
        if (host.top == null && r.top != null) host.top = r.top;
        if (r.docIdx < host.docIdx) host.docIdx = r.docIdx;
        byKey.delete(key);
      }
    }

    const recs = Array.from(byKey.values());
    // Hero = wide slide AND a substantial creative of its own (a 240px brand
    // logo inside a full-width strip is not "the big picture").
    const HERO_MIN_OWN_W = site.heroMinOwnWidth || 350;
    const widthClass = (r) =>
      r.tile ? 'tile' : r.w >= HERO_MIN_W && (r.ownW >= HERO_MIN_OWN_W || !r.src) ? 'hero' : 'promo';

    // Hero means the TOP carousel band only. Full-width promo strips further
    // down the page pass the width test too, so demote every "hero" that sits
    // more than heroBandPx below the topmost one — those are promos.
    const BAND = site.heroBandPx || 300;
    const wideTops = recs.filter((r) => widthClass(r) === 'hero' && r.top != null).map((r) => r.top);
    const bandTop = wideTops.length ? Math.min(...wideTops) : null;
    const classOf = (r) => {
      const c = widthClass(r);
      if (c === 'hero' && bandTop != null && r.top != null && r.top > bandTop + BAND) return 'promo';
      return c;
    };

    // Competition analysis: classify every placement to a brand. The Samsung
    // flag stays authoritative for our own numbers (it uses per-site tuned
    // signals); brandOf covers the rest of the market.
    for (const r of recs) {
      r.brand = r.samsung ? 'samsung' : brandOf(r.sig);
      r.division = divisionOf(r.sig);
    }

    const brandTally = (list) => {
      const out = {};
      for (const r of list) out[r.brand] = (out[r.brand] || 0) + 1;
      return out;
    };

    const section = (cls) => {
      // Document order so pos matches what a visitor sees (slide 1 first).
      const all = recs.filter((r) => classOf(r) === cls).sort((a, b) => a.docIdx - b.docIdx);
      if (process.env.DEBUG_SECTIONS) {
        console.log(`\n[debug] ${cls} placements (${all.length}):`);
        all.forEach((r, i) =>
          console.log(
            `  ${i + 1}. samsung=${r.samsung} w=${r.w} ownW=${r.ownW} top=${r.top} ${(r.src || r.href || '(none)').slice(0, 100)}`
          )
        );
      }
      // pos = 1-based slot within this section in document order — for the
      // hero section that is the carousel slide number (1 = shown first).
      const matches = all
        .map((r, i) => ({ r, pos: i + 1 }))
        .filter((x) => x.r.samsung)
        .map(({ r, pos }) => ({ key: r.key, src: r.src, alt: r.alt, href: r.href, pos }));
      // Competitor placements (branded, non-Samsung) with the same position
      // info — powers the dashboard's competition pictures gallery. Capped so
      // a tile-heavy page can't balloon the stored run row.
      const rivals = all
        .map((r, i) => ({ r, pos: i + 1 }))
        .filter((x) => !x.r.samsung && x.r.brand && x.r.brand !== 'other')
        .slice(0, 40)
        .map(({ r, pos }) => ({
          key: r.key,
          src: r.src,
          alt: r.alt,
          href: r.href,
          pos,
          brand: r.brand,
          division: r.division,
        }));
      return { count: matches.length, total: all.length, matches, rivals, brands: brandTally(all) };
    };

    // Division breakdown across ALL placements: division -> brand -> count.
    // 'other'-brand placements are skipped (site chrome, unbranded promos) so
    // divisions compare identified brands head-to-head.
    const divisions = {};
    for (const r of recs) {
      if (r.brand === 'other' || r.division === 'other') continue;
      divisions[r.division] = divisions[r.division] || {};
      divisions[r.division][r.brand] = (divisions[r.division][r.brand] || 0) + 1;
    }

    return {
      hero: section('hero'),
      promo: section('promo'),
      tiles: section('tile'),
      divisions,
      screenshotPath,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  countSamsungBanners,
  normalizeUrl,
  SCREENSHOT_DIR,
  launchStealthContext,
  gotoWithRetry,
  dismissConsent,
  detectBlock,
  autoScroll,
  BlockedError,
};

// ---- CLI: prove the scraper against a single site (default: e&) ----
// Usage: node banner-monitor/scraper.js [siteId]
if (require.main === module) {
  require('dotenv').config();
  const { SITES } = require('./config');
  const wantId = process.argv[2] || 'e&';
  const site = SITES.find((s) => s.id === wantId) || SITES[0];
  console.log(`\n[scraper] Testing "${site.name}" (${site.url})\n`);
  countSamsungBanners(site)
    .then(({ hero, promo, tiles, screenshotPath }) => {
      for (const [name, s] of [['Hero banners', hero], ['Promo cards', promo], ['Product tiles', tiles]]) {
        console.log(`\n[scraper] ${name}: ${s.count} Samsung of ${s.total} total`);
        s.matches.forEach((m, i) => {
          console.log(`  ${i + 1}. ${m.alt || m.src || m.href || '(placement)'}`);
          if (m.href) console.log(`     link: ${m.href}`);
        });
      }
      console.log(`\n[scraper] Screenshot: ${screenshotPath}\n`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[scraper] FAILED:', err);
      process.exit(1);
    });
}
