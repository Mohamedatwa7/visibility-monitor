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

  // Class of the nearest display:none/visibility:hidden ancestor (or self).
  // Sites ship a hidden mobile twin of each banner (Zain KW's custom-mob-d
  // slider holds a full duplicate carousel; its z-card-image-news-mobile cards
  // duplicate every news banner) — the wrapper's class lets Node recognise
  // and skip these responsive alternates.
  const hiddenClsFor = (el) => {
    let cur = el;
    for (let i = 0; i < 10 && cur && cur !== document.documentElement; i++) {
      const cs = getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden') return cls(cur).trim() || cur.tagName;
      cur = cur.parentElement;
    }
    return '';
  };

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
      hiddenCls: hiddenClsFor(el),
    });
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Hero carousel cycling.
 *
 * A static DOM snapshot cannot see what a hero carousel's NON-ACTIVE slides
 * look like: hidden slides render at 0x0 (Vodafone, Omantel), and some sites
 * only mount the active slide's caption at all (du's reskin). That made
 * Samsung hero slides invisible to the width/signal classifier. So we drive
 * the carousel like a visitor would — click each pagination dot (or the next
 * arrow) and record what the slide shows while it is front-and-center. When a
 * carousel control is found, the observed slides BECOME the hero section
 * (slide order = dot order = what a visitor sees); otherwise the static
 * width-based classification below stays authoritative.
 * ------------------------------------------------------------------ */

// Viewport band (page scrolled to top) that counts as "the hero area".
const HERO_BAND_PX = 950;

// Runs in-page: describe the currently ACTIVE hero slide — the largest
// visible creative near the top plus the caption text overlaying it.
// Accepts a number (band bottom px) or {bandBottom, noCaption}. noCaption
// skips caption evidence for sites whose hero is overlaid by unrelated
// content cards (Amazon) that would bleed rival-brand text into every slide.
function captureActiveHeroInPage(opts) {
  const bandBottom = typeof opts === 'number' ? opts : opts.bandBottom;
  const noCaption = typeof opts === 'object' && !!opts.noCaption;
  const chromeSel =
    'header, nav, footer, [class*="mega" i], [class*="navbar" i], [class*="navigation" i], [id*="footer" i], [id*="header" i]';
  const inChrome = (el) => !!(el.closest && el.closest(chromeSel));
  // Includes ::before/::after — Omantel paints its hero creatives on a
  // pseudo-element via a --bg-url custom property.
  const bgUrl = (el) => {
    const styles = [
      el.style && el.style.backgroundImage,
      getComputedStyle(el).backgroundImage,
      getComputedStyle(el, '::before').backgroundImage,
      getComputedStyle(el, '::after').backgroundImage,
    ];
    for (const s of styles) {
      if (s && s !== 'none') {
        const m = /url\((['"]?)(.*?)\1\)/i.exec(s);
        if (m && m[2]) return m[2];
      }
    }
    return '';
  };
  const ICON_RE =
    /(\/svg-icons\/|\/icons\/|\bicon[-_]|chevron|arrow|sprite|favicon|\.svg(?:$|\?)|placeholder|[-_]gray\.(?:jpg|jpeg|png)|\bblank\.(?:gif|png)|\b1x1\.)/i;

  // Effective visibility: stacked-slide carousels (du) keep every slide's
  // image mounted at full size and fade the inactive ones to opacity 0 —
  // only what a visitor can actually SEE right now counts.
  const isShown = (el) => {
    let cur = el;
    for (let i = 0; i < 8 && cur && cur !== document.documentElement; i++) {
      const cs = getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.4) return false;
      cur = cur.parentElement;
    }
    return true;
  };

  // Prefer the creative covering the viewport's horizontal CENTER — in
  // horizontal sliders the neighbor slides peek in from the edges, and a
  // mid-transition capture could otherwise pick the outgoing slide.
  const centerX = window.innerWidth / 2;
  // A hero creative is billboard-scale: at least half the viewport wide (the
  // narrowest real one is e&'s 792px at 1440). Without this floor, a page
  // with NO billboard at all (Amazon's top is strips of ~450px cards) gets
  // one strip card captured as a phantom single-slide hero carousel.
  const minHeroW = Math.max(300, window.innerWidth * 0.5);
  let best = null;
  const consider = (el, url) => {
    if (!url || ICON_RE.test(url)) return;
    if (inChrome(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < minHeroW || r.height < 100) return;
    if (r.bottom <= 0 || r.top >= bandBottom) return;
    if (!isShown(el)) return;
    const area = r.width * (Math.min(r.bottom, bandBottom) - Math.max(r.top, 0));
    const centered = r.left <= centerX && r.right >= centerX ? 1 : 0;
    if (best && (centered < best.centered || (centered === best.centered && area <= best.area))) return;
    const a = el.closest('a');
    best = {
      area,
      centered,
      url,
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      alt: (el.getAttribute && (el.getAttribute('alt') || el.getAttribute('aria-label'))) || '',
      href: a ? a.href || '' : '',
      w: Math.round(r.width),
    };
  };
  document.querySelectorAll('img').forEach((i) => consider(i, i.currentSrc || i.src || ''));
  document.querySelectorAll('video').forEach((v) => consider(v, v.currentSrc || v.src || v.getAttribute('poster') || 'video:inline'));
  document.querySelectorAll('*').forEach((e) => {
    const b = bgUrl(e);
    if (b) consider(e, b);
  });
  if (!best) return null;

  // Caption: visible text overlapping (or just under) the creative — that is
  // the copy a visitor reads on this slide. Icon-font ligature names are text
  // nodes too; strip them like blockTextFor does.
  const clean = (s) =>
    (s || '')
      .replace(/\b(?:arrow|chevron|keyboard|navigate|expand)_\w+\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  // Only text whose CENTER sits on the creative (small tolerance below for
  // under-image captions). Edge-overlap is not enough — the sticky nav bar
  // overlaps the creative's top edge and nav menus contain brand names, which
  // would false-flag every slide.
  const box = best.rect;
  const texts = [];
  const seen = new Set();
  let href = best.href;

  // Slide-level overlay link: some carousels (Vodafone) keep the creative and
  // a full-slide <a> as SIBLINGS, toggling the anchor's display in sync with
  // the active slide. A visible anchor covering most of the creative's box is
  // that slide's destination.
  if (!href) {
    const boxArea = Math.max(1, (box.right - box.left) * (box.bottom - box.top));
    let overlayArea = 0;
    document.querySelectorAll('a[href]').forEach((a) => {
      if (inChrome(a) || !isShown(a)) return;
      const r = a.getBoundingClientRect();
      if (r.width > (box.right - box.left) * 1.4) return;
      const ix = Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left));
      const iy = Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
      const inter = ix * iy;
      if (inter >= boxArea * 0.5 && inter > overlayArea) {
        overlayArea = inter;
        href = a.href;
      }
    });
  }
  if (!noCaption) {
    document.querySelectorAll('h1,h2,h3,h4,h5,p,span,a,button,li,div').forEach((el) => {
      if (inChrome(el)) return;
      // Only an element's OWN text nodes — wrapper divs would smuggle a whole
      // nav bar's innerText into the caption.
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' ');
      const t = clean(own);
      if (!t || t.length < 3 || seen.has(t)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 10) return;
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      if (cy < box.top - 10 || cy > box.bottom + 60) return;
      if (cx < box.left - 10 || cx > box.right + 10) return;
      if (!isShown(el)) return;
      seen.add(t);
      texts.push(t);
      if (!href) {
        const a = el.closest('a');
        if (a && a.href) href = a.href;
      }
    });
  }
  return {
    url: best.url,
    alt: best.alt,
    href,
    w: best.w,
    caption: texts.join(' · ').slice(0, 400),
  };
}

// Runs in-page: find the hero carousel's control. Prefers pagination dots
// (their count IS the slide count and their order IS the visual order); falls
// back to a next-arrow. Returns {mode:'dot',count} | {mode:'next'} | null.
function detectHeroControlInPage(bandBottom) {
  const chromeSel =
    'header, nav, footer, [class*="mega" i], [class*="navbar" i], [class*="navigation" i], [id*="footer" i], [id*="header" i]';
  // No minimum size: carousel arrows/dots are often 0x0 until hover (Vodafone
  // ships its next-arrow as a hidden <img>) yet still respond to .click().
  const usable = (el) => {
    if (el.closest && el.closest(chromeSel)) return false;
    const r = el.getBoundingClientRect();
    return r.top >= -50 && r.top < bandBottom;
  };
  const DOT_SELS = [
    '.swiper-pagination-bullet',
    '.slick-dots li',
    '.slick-dots button',
    '.owl-dot',
    '[class*="pagination" i] button',
    '[class*="pagination" i] li',
    '[class*="indicator" i] button',
    '[class*="dots" i] button',
    '[class*="dots" i] li',
    '[role="tablist"] [role="tab"]',
    '[class*="dot" i]',
    // Generic fallback for utility-class markup (du): a row of >=3 tiny
    // textless sibling buttons is a dot strip even without carousel classes.
    '@generic',
  ];
  const dotGroup = (sel) => {
    let els;
    try {
      els =
        sel === '@generic'
          ? Array.from(document.querySelectorAll('button, [role="button"], span, li')).filter(
              (el) => {
                const r = el.getBoundingClientRect();
                return (
                  r.width >= 4 &&
                  r.width <= 30 &&
                  r.height >= 4 &&
                  r.height <= 30 &&
                  !(el.innerText || '').trim() &&
                  usable(el)
                );
              }
            )
          : Array.from(document.querySelectorAll(sel)).filter(usable);
    } catch {
      return null;
    }
    // Dots are same-parent siblings; small clickable markers.
    const byParent = new Map();
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 80 || r.height > 80) continue;
      const list = byParent.get(el.parentElement) || [];
      list.push(el);
      byParent.set(el.parentElement, list);
    }
    const min = sel === '@generic' ? 3 : 2;
    for (const list of byParent.values()) {
      if (list.length >= min && list.length <= 20) return list;
    }
    return null;
  };
  for (const sel of DOT_SELS) {
    const list = dotGroup(sel);
    if (list) return { mode: 'dot', count: list.length, sel };
  }
  const NEXT_SELS = [
    '.swiper-button-next',
    '.slick-next',
    '.owl-next',
    '[aria-label*="next" i]',
    'button[class*="next" i]',
    '[class*="carousel" i] [class*="next" i]',
    'img[src*="next" i]',
  ];
  for (const sel of NEXT_SELS) {
    let els;
    try {
      els = Array.from(document.querySelectorAll(sel)).filter(usable);
    } catch {
      continue;
    }
    if (els.length) return { mode: 'next', sel };
  }
  return null;
}

// Runs in-page: click the carousel control (dot #index, or the next arrow).
function clickHeroControlInPage({ mode, sel, index, bandBottom }) {
  const chromeSel =
    'header, nav, footer, [class*="mega" i], [class*="navbar" i], [class*="navigation" i], [id*="footer" i], [id*="header" i]';
  const usable = (el) => {
    if (el.closest && el.closest(chromeSel)) return false;
    const r = el.getBoundingClientRect();
    return r.top >= -50 && r.top < bandBottom;
  };
  let els;
  try {
    els =
      sel === '@generic'
        ? Array.from(document.querySelectorAll('button, [role="button"], span, li')).filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.width >= 4 &&
              r.width <= 30 &&
              r.height >= 4 &&
              r.height <= 30 &&
              !(el.innerText || '').trim() &&
              usable(el)
            );
          })
        : Array.from(document.querySelectorAll(sel)).filter(usable);
  } catch {
    return false;
  }
  if (mode === 'dot') {
    const byParent = new Map();
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 80 || r.height > 80) continue;
      const list = byParent.get(el.parentElement) || [];
      list.push(el);
      byParent.set(el.parentElement, list);
    }
    const min = sel === '@generic' ? 3 : 2;
    for (const list of byParent.values()) {
      if (list.length >= min && list.length <= 20) {
        if (index >= list.length) return false;
        list[index].click();
        return true;
      }
    }
    return false;
  }
  const target = els[0];
  if (!target) return false;
  // An <img src="next.png"> arrow is not itself clickable — click its nearest
  // clickable wrapper (or parent as a last resort), and dispatch the full
  // mouse-event sequence since some frameworks listen on mousedown/up.
  const t = target.closest('a,button,[role="button"]') || target.parentElement || target;
  for (const type of ['mousedown', 'mouseup', 'click']) {
    t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return true;
}

// Runs in-page: click a non-navigating control whose own text matches the
// given pattern — used to open brand tabs that mount their content on click
// only (stc Bahrain's device showcase defaults to the apple tab; the
// "samsung galaxy" tab's cards are not in the DOM until clicked).
function clickRevealInPage(reSource) {
  const re = new RegExp(reSource, 'i');
  const chromeSel =
    'header, nav, footer, [class*="mega" i], [class*="navbar" i], [class*="navigation" i], [id*="footer" i], [id*="header" i]';
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], a, li, span, div'));
  for (const n of nodes) {
    if (n.closest(chromeSel)) continue;
    // Never click an anchor that truly navigates — the reveal must mutate
    // this page, not leave it.
    if (n.tagName === 'A') {
      const href = n.getAttribute('href') || '';
      if (href && !/^#|^javascript:/i.test(href)) continue;
    }
    const txt = (n.innerText || '').replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 40 || !re.test(txt)) continue;
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    n.scrollIntoView({ block: 'center' });
    for (const type of ['mousedown', 'mouseup', 'click']) {
      n.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return txt;
  }
  return null;
}

// Slide identity shared by the passive watcher and the click-cycle.
const slideSig = (s) => (s.url ? `${s.url}|${s.href || ''}` : `cap:${(s.caption || '').slice(0, 80)}`);

// PASSIVE rotation watch — the primary observation. From the moment the page
// is usable, sample the active hero and record each slide as autoplay shows
// it. This yields the TRUE visitor order (position 1 = first thing shown) and
// the true slide set: click-cycling on top of fast autoplay can starve
// individual slides of a stable capture window and drop them entirely
// (Xcite's 17-slide rotation lost 4 slides, including both Samsung ones).
// Stops on wrap-around (an already-recorded slide reappears), or after 15s
// with nothing new (static hero / no autoplay), or at the 75s cap.
async function watchHeroRotation(page, site) {
  const CAP = { bandBottom: HERO_BAND_PX, noCaption: !!(site && site.heroNoCaption) };
  const states = [];
  const seenKeys = new Set();
  let prevKey = '';
  let confirmed = '';
  let sameCount = 0;
  const t0 = Date.now();
  let lastNewAt = Date.now();
  while (Date.now() - t0 < 75000) {
    let st = null;
    try {
      st = await page.evaluate(captureActiveHeroInPage, CAP);
    } catch {
      /* page still hydrating */
    }
    if (st && st.url) {
      const k = slideSig(st);
      sameCount = k === prevKey ? sameCount + 1 : 1;
      prevKey = k;
      // Two consecutive agreeing samples = a settled slide, not a mid-fade
      // frame pairing the wrong image with the wrong link.
      if (sameCount >= 2 && k !== confirmed) {
        confirmed = k;
        if (seenKeys.has(k)) {
          if (states.length > 1) break; // wrapped around — rotation complete
        } else {
          seenKeys.add(k);
          states.push(st);
          lastNewAt = Date.now();
        }
      }
    }
    if (Date.now() - lastNewAt > 15000) break;
    await page.waitForTimeout(700);
  }
  return states.length ? states : null;
}

// Node-side driver: cycle the hero carousel and return one record per slide,
// in visual order. Returns null when no carousel control is found — caller
// falls back to the static classification.
async function cycleHeroSlides(page, site, anchorHero) {
  const control = await page.evaluate(detectHeroControlInPage, HERO_BAND_PX);
  if (!control) return null;
  const CAP = { bandBottom: HERO_BAND_PX, noCaption: !!(site && site.heroNoCaption) };

  // A capture only counts when it is STABLE: two reads ~350ms apart must
  // agree on the creative AND the destination link. Mid-transition reads pair
  // the outgoing slide's image with the incoming slide's overlay link
  // (Vodafone), fabricating phantom slide combinations.
  const stableCapture = async () => {
    let prev = await page.evaluate(captureActiveHeroInPage, CAP);
    for (let t = 0; t < 4; t++) {
      await page.waitForTimeout(350);
      const cur = await page.evaluate(captureActiveHeroInPage, CAP);
      if (prev && cur && prev.url === cur.url && prev.href === cur.href) return cur;
      prev = cur;
    }
    return null; // never stabilized — skip this state
  };

  // Slide identity = creative + destination. Captions are too volatile for
  // identity (overlay text shifts between captures — Amazon double-counted a
  // slide whose caption tail changed); they only identify creative-less states.
  const sig = (s) => (s.url ? `${s.url}|${s.href || ''}` : `cap:${(s.caption || '').slice(0, 80)}`);
  const states = [];
  const seen = new Set();
  const push = (st) => {
    if (!st) return false;
    const k = sig(st);
    if (seen.has(k)) return false;
    seen.add(k);
    states.push(st);
    return true;
  };

  if (control.mode === 'dot') {
    // Dot order = visual slide order, regardless of where autoplay happens
    // to be when we start.
    for (let i = 0; i < Math.min(control.count, 16); i++) {
      const ok = await page.evaluate(clickHeroControlInPage, {
        mode: 'dot',
        sel: control.sel,
        index: i,
        bandBottom: HERO_BAND_PX,
      });
      if (!ok) break;
      await page.waitForTimeout(900);
      push(await stableCapture());
    }
  } else {
    // No dots: advance with the next arrow. No early duplicate-based exit —
    // when the arrow click doesn't register (Vodafone ships it as a bare
    // <img> with the handler elsewhere) the carousel still AUTOPLAYS, and
    // sampling the full window catches every slide of the rotation.
    push(await stableCapture());
    for (let i = 0; i < 24; i++) {
      const ok = await page.evaluate(clickHeroControlInPage, {
        mode: 'next',
        sel: control.sel,
        bandBottom: HERO_BAND_PX,
      });
      if (!ok) break;
      await page.waitForTimeout(1300);
      push(await stableCapture());
    }
    // Observation starts wherever autoplay happens to be, but the cyclic
    // order is preserved — rotate so the anchor slide (active at page load,
    // i.e. the visitor's slide 1) leads and positions read true. This is a
    // FALLBACK: the caller re-rotates to DOM order when it can (the anchor
    // can itself be late — autoplay advances during the networkidle wait).
    if (anchorHero && anchorHero.url && states.length > 1) {
      const idx = states.findIndex((s) => s.url === anchorHero.url);
      if (idx > 0) {
        const rotated = states.slice(idx).concat(states.slice(0, idx));
        states.length = 0;
        states.push(...rotated);
      }
    }
  }
  if (!states.length) return null;
  states.mode = control.mode; // 'dot' order is already true; 'next' order is rotation-relative
  return states;
}

// Many Gulf telecom sites sit behind WAFs (F5 BIG-IP, Imperva) that serve a
// block/challenge page to obvious automation. Detect those so we report an
// ERROR instead of silently recording "0 banners" (which would fire a bogus
// "count dropped" alert). NOTE: this is best-effort — sophisticated JA3/TLS
// fingerprinting can still block us and would need a real browser/proxy.
const BLOCK_RE =
  /request rejected|the requested url was rejected|has been blocked|access denied|attention required|verify you are (?:a )?human|verif(?:y|ies) (?:that )?you are (?:not )?a? ?(?:bot|human)|are you a robot|unusual traffic|pardon the interruption|performing security verification|security service to protect|checking your browser|just a moment|application error|client-side exception/i;

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

    // Fast-first navigation: the passive rotation watch must start as close
    // to first paint as possible — autoplay advances within seconds, and
    // waiting for networkidle costs the opening slides and shifts every
    // position (Xcite read [1,3] for slides a visitor sees at [2,4]). Late
    // content is handled afterwards by a second consent pass + autoScroll.
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: BROWSER.navTimeoutMs });
    } catch {
      await gotoWithRetry(page, site.url, BROWSER.navTimeoutMs);
    }
    await dismissConsent(page, site);
    try {
      await detectBlock(page); // throws BlockedError -> recorded as error, not 0
    } catch (err) {
      if (!(err instanceof BlockedError)) throw err;
      // Managed challenges (Cloudflare) can auto-clear seconds after DCL —
      // recheck once before giving up on the run.
      await page.waitForTimeout(9000);
      await detectBlock(page);
    }

    // PRIMARY hero observation: watch the rotation passively from the moment
    // the page is usable — true visitor order (slide 1 first) and, for
    // autoplay carousels, the true slide set. The click-cycle below only
    // supplements what this missed.
    let passiveStates = null;
    try {
      passiveStates = await watchHeroRotation(page, site);
    } catch {
      /* passive watch is best-effort */
    }
    const anchorHero = passiveStates && passiveStates.length ? passiveStates[0] : null;

    // Consent overlays that mount late (after DCL) get a second chance here
    // before the scroll/screenshot phases.
    await dismissConsent(page, site);
    await autoScroll(page);

    const candidates = await page.evaluate(collectCandidatesInPage, {
      containerSource: CONTAINER_REGEX.source,
      containerFlags: CONTAINER_REGEX.flags,
    });

    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Drive the hero carousel (if one exists) so hidden slides are observed
    // the way a visitor sees them. Any failure falls back to the static
    // width-based hero classification below.
    let heroSlides = null;
    try {
      heroSlides = await cycleHeroSlides(page, site, anchorHero);
    } catch (err) {
      console.warn(`[scraper] hero cycle failed for ${site.id}: ${err.message}`);
    }

    // Reveal passes: content behind brand tabs mounts on click only — click
    // each configured control and merge what newly appears. After the
    // screenshot (which should show the default state) and after hero cycling
    // (which the click must not disturb).
    for (const revealRe of site.revealClicks || []) {
      try {
        const clicked = await page.evaluate(clickRevealInPage, revealRe.source);
        if (!clicked) {
          console.warn(`[scraper] reveal control ${revealRe} not found on ${site.id}`);
          continue;
        }
        await page.waitForTimeout(2000);
        const extra = await page.evaluate(collectCandidatesInPage, {
          containerSource: CONTAINER_REGEX.source,
          containerFlags: CONTAINER_REGEX.flags,
        });
        // Keep only what the click newly mounted (by creative/destination).
        // Block ids from a fresh evaluate would collide with pass-1 ids, so
        // prefix them — cross-pass block keys must never merge records.
        const seen = new Set();
        for (const c of candidates) {
          if (c.src) seen.add(normalizeUrl(c.src, true));
          if (c.href) seen.add(normalizeUrl(c.href));
        }
        let added = 0;
        for (const c of extra) {
          const sKey = c.src ? normalizeUrl(c.src, true) : '';
          const hKey = c.href ? normalizeUrl(c.href) : '';
          if ((sKey && seen.has(sKey)) || (hKey && seen.has(hKey))) continue;
          if (!sKey && !hKey) continue;
          c.block = c.block ? `r-${c.block}` : c.block;
          c.blockAll = (c.blockAll || []).map((b) => `r-${b}`);
          candidates.push(c);
          added++;
        }
        console.log(`        reveal "${clicked}": ${added} new placement candidate(s)`);
      } catch (err) {
        console.warn(`[scraper] reveal pass failed for ${site.id}: ${err.message}`);
      }
    }

    // Merge the two observations. Dot-cycling keeps its own deterministic
    // order (dot N = slide N). Otherwise the passive from-load order leads —
    // it IS what a visitor sees — and the click-cycle only appends slides the
    // rotation window missed (their exact slots are unknowable; they land at
    // the tail).
    if (passiveStates && passiveStates.length > 1 && (!heroSlides || heroSlides.mode !== 'dot')) {
      const merged = [...passiveStates];
      const keys = new Set(passiveStates.map(slideSig));
      for (const s of heroSlides || []) {
        if (keys.has(slideSig(s))) continue;
        keys.add(slideSig(s));
        merged.push(s);
      }
      merged.mode = 'passive'; // order is already true — no DOM re-rotation
      heroSlides = merged;
    }

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
      /bat\.bing\.com|google-analytics|googletagmanager|doubleclick\.net|googleadservices|facebook\.com\/tr\b|connect\.facebook|hotjar|clarity\.ms|criteo|\/beacon|\/pixel\b|snr\.snapchat|tiktok\.com\/i18n|analytics\.|\bt\.co\/|\badsct\b|adsrvr\.org|ib\.adnxs\.com|fls-eu\.amazon|\$uedata|freshbots|track\.omguk\.com/i;
    // Store badges and social-profile chrome are page furniture, not promo
    // placements — they inflate the section denominators on every site.
    const CHROME_LINK_RE =
      /app-?store-?badge|google-?play-?badge|play\.google\.com\/store|itunes\.apple\.com|apps\.apple\.com|appgallery|app-?gallery|instagram\.com\/[^/]|facebook\.com\/(?!tr\b)[^/]|twitter\.com\/[^/]|(?:^|\.)x\.com\/[^/]|youtube\.com\/(?:user|channel|@)|linkedin\.com\/company|api\.whatsapp\.com|wa\.me\/|snapchat\.com\/add|tiktok\.com\/@|^mailto:/i;
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
    // Responsive alternates: a hidden mobile twin of a desktop banner is not a
    // second placement — a desktop visitor never sees it and the desktop
    // creative is already counted (Zain KW shipped a full duplicate mobile
    // carousel that inflated its promo denominator by ~10). Only elements
    // hidden by a wrapper whose class (or own image filename) says
    // mobile/small-screen are skipped — hidden slides of ordinary carousels
    // carry no such marker and still count.
    const MOBILE_ALT_RE =
      /\bmob(?:ile)?\b|[-_]mob(?:[-_]|\b)|\bmob[-_]|d-(?:sm|md|lg)-none|hidden-(?:desktop|lg|md|xl)|small-only|sm-only/i;

    for (const c of candidates) {
      if (c.inChrome) continue; // skip nav/header/footer/mega-menu
      if (c.clone) continue; // carousel loop duplicates — the original slide is also in the DOM
      if (c.hiddenCls && (MOBILE_ALT_RE.test(c.hiddenCls) || /mobile/i.test(c.src || ''))) continue;
      if (TRACKER_RE.test(c.src || '') || TRACKER_RE.test(c.href || '')) continue;
      if (CHROME_LINK_RE.test(c.src || '') || CHROME_LINK_RE.test(c.href || '')) continue;

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

    // Observed carousel slides (from cycling) replace the static hero
    // classification when available — and the static hero-band records are
    // dropped so the same carousel is not counted twice across sections.
    const slideRecs = (heroSlides || []).map((s, i) => {
      const isRealUrl = s.url && !/^video:/i.test(s.url);
      const sig = [isRealUrl ? s.url : '', s.alt, s.href, s.caption].filter(Boolean).join(' ');
      const samsung = regex.test(sig);
      return {
        key: (isRealUrl && normalizeUrl(s.url, site.bannerDedupe === 'image-query')) || normalizeUrl(s.href) || `slide#${i + 1}`,
        src: isRealUrl ? s.url : '',
        alt: s.alt || (s.caption || '').slice(0, 100),
        href: s.href || '',
        pos: i + 1,
        samsung,
        brand: samsung ? 'samsung' : brandOf(sig),
        division: divisionOf(sig),
      };
    });
    // True slide order for next-arrow carousels: observation starts wherever
    // autoplay happens to be, and even the load-time anchor can be late
    // (autoplay advances during the networkidle wait). The DOM is the ground
    // truth — carousels mount slide 1 first in document order, and the static
    // candidate pass recorded every slide's anchor/creative with its docIdx.
    // Rotate the observed cycle so the DOM-first slide leads. (Dot mode needs
    // none of this: dot order is already the visual order.)
    if (heroSlides && heroSlides.mode === 'next' && slideRecs.length > 1) {
      const slideIdxFor = (r) => {
        const src = r.src ? normalizeUrl(r.src, true) : '';
        const href = r.href ? normalizeUrl(r.href) : '';
        return slideRecs.findIndex(
          (s) =>
            (src && s.src && normalizeUrl(s.src, true) === src) ||
            (href && s.href && normalizeUrl(s.href) === href)
        );
      };
      let lead = -1;
      for (const r of [...recs].sort((a, b) => a.docIdx - b.docIdx)) {
        const i = slideIdxFor(r);
        if (i >= 0) {
          lead = i;
          break;
        }
      }
      if (lead > 0) {
        const rotated = slideRecs.slice(lead).concat(slideRecs.slice(0, lead));
        rotated.forEach((s, i) => (s.pos = i + 1));
        slideRecs.length = 0;
        slideRecs.push(...rotated);
      }
    }
    // Cycled slides replace the static hero classification only when the
    // cycle plausibly covered the carousel: 2+ slides observed, or the static
    // pass itself saw at most 1 hero. A partial cycle (1 slide) must not
    // shadow a static classification that found a full carousel.
    const staticHeroCount = recs.filter((r) => classOf(r) === 'hero').length;
    const heroOverride = slideRecs.length >= 2 || (slideRecs.length === 1 && staticHeroCount <= 1);
    if (process.env.DEBUG_SECTIONS && heroOverride) {
      console.log(`\n[debug] hero slides via carousel cycling (${slideRecs.length}):`);
      slideRecs.forEach((r) =>
        console.log(
          `  ${r.pos}. samsung=${r.samsung} brand=${r.brand} ${(r.src || '(no img)').slice(0, 80)} href=${(r.href || '-').slice(0, 70)} | ${r.alt.slice(0, 60)}`
        )
      );
    }
    // Drop static records that duplicate a cycled hero slide — by class
    // (anything the width test already called hero) AND by identity. Identity
    // means the CREATIVE (src): a promo card with its own image is a distinct
    // placement even when it links to the same destination as a hero slide
    // (Omantel's device cards share the store-collection URL with two hero
    // slides). Href identity only applies to link-only records — those are
    // the slide's own overlay anchors (Vodafone).
    const slideSrcKeys = new Set();
    const slideHrefKeys = new Set();
    for (const s of slideRecs) {
      if (s.src) slideSrcKeys.add(normalizeUrl(s.src, true));
      if (s.href) slideHrefKeys.add(normalizeUrl(s.href));
    }
    const staticRecs = heroOverride
      ? recs.filter(
          (r) =>
            classOf(r) !== 'hero' &&
            !(r.src && slideSrcKeys.has(normalizeUrl(r.src, true))) &&
            !(!r.src && r.href && slideHrefKeys.has(normalizeUrl(r.href)))
        )
      : recs;

    const section = (cls) => {
      // Document order so pos matches what a visitor sees (slide 1 first).
      const all = staticRecs.filter((r) => classOf(r) === cls).sort((a, b) => a.docIdx - b.docIdx);
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

    const heroFromSlides = () => ({
      count: slideRecs.filter((r) => r.samsung).length,
      total: slideRecs.length,
      matches: slideRecs
        .filter((r) => r.samsung)
        .map(({ key, src, alt, href, pos }) => ({ key, src, alt, href, pos })),
      rivals: slideRecs
        .filter((r) => !r.samsung && r.brand && r.brand !== 'other')
        .slice(0, 40)
        .map(({ key, src, alt, href, pos, brand, division }) => ({ key, src, alt, href, pos, brand, division })),
      brands: brandTally(slideRecs),
      // The complete observed slide list — run.js feeds these creatives to the
      // vision model, which catches Samsung branding that only exists in the
      // artwork (multi-brand offer slides with generic URLs).
      slides: slideRecs.map(({ key, src, alt, href, pos, samsung, brand, division }) => ({
        key,
        src,
        alt,
        href,
        pos,
        samsung,
        brand,
        division,
      })),
    });

    // Division breakdown across ALL placements: division -> brand -> count.
    // 'other'-brand placements are skipped (site chrome, unbranded promos) so
    // divisions compare identified brands head-to-head.
    const divisions = {};
    for (const r of [...staticRecs, ...slideRecs]) {
      if (r.brand === 'other' || r.division === 'other') continue;
      divisions[r.division] = divisions[r.division] || {};
      divisions[r.division][r.brand] = (divisions[r.division][r.brand] || 0) + 1;
    }

    const result = {
      hero: heroOverride ? heroFromSlides() : section('hero'),
      promo: section('promo'),
      tiles: section('tile'),
      divisions,
      screenshotPath,
    };
    // A retail/telecom homepage NEVER legitimately renders zero placements
    // across every section — that is a blank render, an app crash, or a
    // bot-wall BLOCK_RE didn't recognize. Recording it as a run would zero
    // the dashboard (and null section totals silently drop the on-site
    // pillar from the visibility score, inflating the site's rank).
    if (result.hero.total + result.promo.total + result.tiles.total === 0) {
      throw new BlockedError('page rendered zero placements — blank render or unrecognized bot wall');
    }
    return result;
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
  // exported for diagnostics (debug-*.js scripts)
  captureActiveHeroInPage,
  detectHeroControlInPage,
  clickHeroControlInPage,
  HERO_BAND_PX,
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
