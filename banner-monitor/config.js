'use strict';

/**
 * Central configuration for the Samsung banner monitor.
 *
 * `SITES` is the list of partner landing pages we watch. Each site may override:
 *   - `regex`            : a RegExp used to decide whether a banner is "Samsung".
 *   - `consentSelector`  : a CSS selector for that site's cookie/consent accept button.
 *
 * The default detection regex and the per-site selectors are EXPECTED to be tuned
 * over time as each partner re-skins their site. Treat them as living config.
 */

// Default detection. Matches Samsung brand + current flagship device families.
// Tune per-site below when a partner uses different copy (e.g. localized names).
const DEFAULT_REGEX = /samsung|galaxy|z\s?flip|z\s?fold/i;

const SITES = [
  {
    id: 'e&',
    name: 'e& UAE',
    // Etisalat rebranded to e&; etisalat.ae now only serves a redirect splash.
    // The live consumer site is eand.ae.
    url: 'https://www.eand.ae/en/index.html',
    region: 'UAE',
    // regex: /samsung|galaxy/i,        // override example
    // consentSelector: '#onetrust-accept-btn-handler',
    // e& device grid is AngularJS; renders 10 cards initially, total in
    // .nv-title as "Showing 96 Result(s)". Cards carry a brand label.
    devices: {
      url: 'https://www.eand.ae/b2c/eshop/viewProducts?category=mobileDevices&subCategory=cat1100070',
      card: '.eand-device-card-tile',
      brand: '.text-eand-granite-70 p',
      title: '.eand-main-headings h4',
      totalSelector: '.nv-title',
      totalPattern: /Showing\s*(\d+)\s*Result/i,
      pages: 5,
    },
    // NO search share for e&: the eshop exposes no text search endpoint
    // (verified live 2026-07-03) — the device grid above is its only
    // product-discovery surface, and that is already covered by `devices`.
  },
  {
    id: 'du',
    name: 'du',
    url: 'https://www.du.ae/personal',
    region: 'UAE',
    // Placement classes: du has NO product tiles (user rule 2026-07-08) —
    // nothing on its homepage is directly purchasable, so device cards like
    // "Galaxy S26 Ultra Starting at 185/mo" are PROMO CARDS. No tileRegex:
    // everything non-hero classifies as promo.
    // du serves banner/tile creatives via brand-anonymous Satellite blob URLs
    // and (since the 2026-07 reskin) without Samsung alt text, so image/href
    // signals alone miss Samsung tiles ("Galaxy S26 Ultra" lives only in the
    // tile caption). Match each candidate's own tile/anchor text as well, and
    // dedupe by image: du's block elements span several brands' tiles, so
    // block dedupe would collapse S26 + Fold7 + iPhone tiles into one entry.
    matchBlockText: true,
    // 'image-query': du serves every creative from the SAME path
    // (.../Satellite?blobwhere=<id>) — the query string is the image identity,
    // so plain image dedupe would collapse all tiles into one entry.
    bannerDedupe: 'image-query',
    // Device-catalog share. shop.du.ae is an SAP Commerce SPA (flat HTTP only
    // returns an app shell) — cards must be waited for. Paging shows "40 of 162".
    devices: {
      url: 'https://shop.du.ae/en/personal/c-mobile-phones#category=mobile-phones&brands=all',
      card: 'a.du-device-card',
      brand: '.du-device-brand',
      title: '.v-card__title',
      totalSelector: '.du-devices-paging',
      totalPattern: /(\d+)\s*of\s*(\d+)/,
      pages: 5,
    },
    // NO search share for du: the site has no working text search
    // (/search?q=… 302s to an error page), so there is nothing to measure.
    // Verified live 2026-07-03. If du ever ships search, model it on the
    // sharafdg block below (multi-term, {q} URL template).
  },
  // stc and Ooredoo removed from the active roster 2026-07-06 (user request:
  // "remove for now"). Their tuning notes are preserved in DISABLED_SITES
  // below — move an entry back into SITES to re-enable it.
  {
    id: 'sharafdg',
    name: 'Sharaf DG',
    url: 'https://uae.sharafdg.com/',
    region: 'UAE',
    // Unified banner method (2026-07-08, user decision): count any distinct
    // Samsung promotional placement — image creatives AND Samsung-linked
    // tiles/CTAs — same definition as e& and du. Noise is handled generically:
    // lazy-load placeholder images are excluded by the global ICON_RE, and
    // dedupe is by destination link — the hero swiper clones each slide ~3x
    // and product tiles repeat across carousels, but clones share an href.
    bannerDedupe: 'href',
    // Placement class: anything linking to a product detail page is a product
    // tile; campaign pages (/samsung-galaxy-s26-series/, /new-launches/,
    // /brand/samsung/) stay banners.
    tileRegex: /\/product\//i,
    // Category grid is Algolia-rendered: 48 cards/page under .algolia-item,
    // paged by a numbered widget (span.go-to-page[data-page], ~14 pages) that
    // REPLACES the grid per page. No visible grand-total counter. Cards carry
    // no brand label — Samsung is matched on the .product-link title/href.
    devices: {
      url: 'https://uae.sharafdg.com/c/mobiles_tablets/mobiles/',
      card: '.algolia-item',
      title: '.product-link',
      pagerSelector: 'span.go-to-page',
      pages: 5,
    },
    // Real text search (unlike the telecoms). Measured across the most common
    // phone-shopping phrases; each term is judged on its first 24 results.
    search: {
      kind: 'grid',
      url: 'https://uae.sharafdg.com/?q={q}&post_type=product',
      terms: ['phones', 'smartphone', 'mobile phone', '5g phone'],
      card: '.algolia-item',
      title: '.product-link',
      maxPositions: 24,
    },
  },
];

// Parked site configs — not crawled. Kept so their WAF/selector notes survive.
const DISABLED_SITES = [
  {
    id: 'stc',
    name: 'stc',
    // /content/stc/sa/en.html 404s; this is the live English Devices page.
    // stc sits behind an Imperva-style WAF — needs the stealth context.
    // NOTE: stc renders its device grid lazily with SKU-based (non-branded)
    // image URLs, so brand only appears in copy. It currently yields 0 with the
    // default own-attribute matching; this is a prime per-site tuning target
    // (e.g. enable the container-text signal for stc, or wait on its product API).
    url: 'https://www.stc.com.sa/content/stc/sa/en/personal/devices.html',
    region: 'KSA',
    timezoneId: 'Asia/Riyadh',
    locale: 'en-SA',
  },
  {
    id: 'ooredoo',
    name: 'Ooredoo',
    // /portal/en/home 404s; the root redirects to /web/en/.
    // Ooredoo sits behind an F5 BIG-IP WAF — needs the stealth context.
    url: 'https://www.ooredoo.qa/web/en/',
    region: 'Qatar',
    timezoneId: 'Asia/Qatar',
    locale: 'en-QA',
  },
];

// Browser/runtime tuning shared by the scraper.
const BROWSER = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'en-AE',
  timezoneId: 'Asia/Dubai',
  navTimeoutMs: 45000,
  scrollStepPx: 600,
  scrollDelayMs: 400,
};

// Regex used to recognise carousel/banner/promo containers in the DOM.
const CONTAINER_REGEX = /swiper|slick|carousel|slider|hero|banner|promo|campaign/i;

/* ------------------------------------------------------------------ *
 * Competition analysis (researched 2026-07: Statista/Omdia — Samsung
 * ~34% ME smartphone share, Honor #2 shipments and fastest-growing,
 * then Xiaomi/Transsion/Apple; TVs: Samsung vs TCL/Hisense/LG/Sony;
 * appliances: LG/Bosch/Hisense/Midea/Haier).
 *
 * Order matters: first matching brand wins, so more-specific product
 * names sit on the brand that owns them.
 * ------------------------------------------------------------------ */
const BRANDS = [
  { id: 'samsung', label: 'Samsung', regex: DEFAULT_REGEX },
  { id: 'apple', label: 'Apple', regex: /\bapple\b|iphone|ipad\b|macbook|airpods|imac\b/i },
  { id: 'xiaomi', label: 'Xiaomi', regex: /xiaomi|redmi|\bpoco\b/i },
  { id: 'honor', label: 'Honor', regex: /\bhonor\b|magic\s?v?\d/i },
  { id: 'huawei', label: 'Huawei', regex: /huawei|\bpura\s?\d|\bmate\s?(?:x?\d|pad|book)/i },
  { id: 'oppo', label: 'Oppo', regex: /\boppo\b|\breno\s?\d/i },
  { id: 'vivo', label: 'vivo', regex: /\bvivo\b(?!book)/i }, // vivobook = Asus
  { id: 'realme', label: 'realme', regex: /realme/i },
  { id: 'nothing', label: 'Nothing', regex: /nothing[\s-]?phone|\bcmf\b/i },
  { id: 'google', label: 'Google', regex: /\bpixel\s?\d|google\s?pixel/i },
  { id: 'infinix', label: 'Infinix', regex: /infinix/i },
  { id: 'tecno', label: 'Tecno', regex: /\btecno\b/i },
  // "lg" is a hazardous token: CSS grid classes (col-lg-6), URL size markers
  // and language params (&lg=en) all contain it at word boundaries. Require
  // clean non-hyphen/equals context, or an explicit LG product word.
  { id: 'lg', label: 'LG', regex: /(?<![\w-])lg(?![\w=-])|lg[\s-](?:tv|oled|qled|nanocell|gram|electronics|washer|refrigerator|styler|soundbar|xboom)/i },
  { id: 'tcl', label: 'TCL', regex: /\btcl\b/i },
  { id: 'hisense', label: 'Hisense', regex: /hisense/i },
  { id: 'sony', label: 'Sony', regex: /\bsony\b|bravia|playstation|\bps5\b/i },
  { id: 'bosch', label: 'Bosch', regex: /\bbosch\b/i },
  { id: 'beko', label: 'Beko', regex: /\bbeko\b/i },
  { id: 'midea', label: 'Midea', regex: /\bmidea\b/i },
  { id: 'haier', label: 'Haier', regex: /\bhaier\b/i },
  { id: 'dyson', label: 'Dyson', regex: /\bdyson\b/i },
  { id: 'jbl', label: 'JBL', regex: /\bjbl\b/i },
];

// Product divisions — checked in order; first match wins, so accessories
// (watch/buds) are recognised before the generic phone patterns.
const DIVISIONS = [
  { id: 'tv', label: 'TV & AV', regex: /\btvs?\b|television|qled|oled|bravia|soundbar|projector/i },
  {
    id: 'appliance',
    label: 'Home Appliances',
    regex: /washer|washing machine|dryer|refrigerator|fridge|freezer|dishwasher|microwave|\boven\b|vacuum|air\s?(?:conditioner|fryer|purifier)|robot clean/i,
  },
  { id: 'wearable', label: 'Wearables', regex: /watch|\bband\s?\d|fitness track/i },
  { id: 'audio', label: 'Audio', regex: /buds|earbuds|earphone|headphone|airpods|speaker/i },
  { id: 'computing', label: 'Tablets & PCs', regex: /laptop|notebook|macbook|tablet|ipad|\btab\b|matepad|chromebook/i },
  {
    id: 'mobile',
    label: 'Smartphones',
    regex: /phone|galaxy|iphone|\bfold|\bflip|redmi|\bpoco\b|\breno\s?\d|pixel|\bpura\s?\d|\bmate\s?x?\d|magic\s?v?\d|smartphone|\b5g\b/i,
  },
];

// Classify a text blob (image URL + alt + href + caption) to a brand/division.
function brandOf(text) {
  if (!text) return 'other';
  for (const b of BRANDS) if (b.regex.test(text)) return b.id;
  return 'other';
}

function divisionOf(text) {
  if (!text) return 'other';
  for (const d of DIVISIONS) if (d.regex.test(text)) return d.id;
  return 'other';
}

// Alerting behaviour: 'change' = alert on any count change, 'drop' = only when count falls.
const ALERT_ON = (process.env.ALERT_ON || 'change').toLowerCase() === 'drop' ? 'drop' : 'change';

function getRegexFor(site) {
  return site.regex instanceof RegExp ? site.regex : DEFAULT_REGEX;
}

module.exports = {
  SITES,
  DISABLED_SITES,
  BRANDS,
  DIVISIONS,
  brandOf,
  divisionOf,
  DEFAULT_REGEX,
  CONTAINER_REGEX,
  BROWSER,
  ALERT_ON,
  getRegexFor,
};
