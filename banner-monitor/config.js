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
    type: 'operator',
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
    // (verified live 2026-07-03) â€” the device grid above is its only
    // product-discovery surface, and that is already covered by `devices`.
  },
  {
    id: 'du',
    name: 'du',
    type: 'operator',
    url: 'https://www.du.ae/personal',
    region: 'UAE',
    // Placement classes: du has NO product tiles (user rule 2026-07-08) â€”
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
    // (.../Satellite?blobwhere=<id>) â€” the query string is the image identity,
    // so plain image dedupe would collapse all tiles into one entry.
    bannerDedupe: 'image-query',
    // Device-catalog share. shop.du.ae is an SAP Commerce SPA (flat HTTP only
    // returns an app shell) â€” cards must be waited for. Paging shows "40 of 162".
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
    // (/search?q=â€¦ 302s to an error page), so there is nothing to measure.
    // Verified live 2026-07-03. If du ever ships search, model it on the
    // sharafdg block below (multi-term, {q} URL template).
  },
  {
    id: 'ooredoo',
    name: 'Ooredoo',
    type: 'operator',
    // Re-enabled 2026-07-13 (user request). Root redirects to /web/en/;
    // sits behind an F5 BIG-IP WAF â€” needs the stealth context.
    url: 'https://www.ooredoo.qa/web/en/',
    region: 'Qatar',
    timezoneId: 'Asia/Qatar',
    locale: 'en-QA',
    // Homepage links straight to purchasable eshop products.
    tileRegex: /\/products\//i,
    // eshop.ooredoo.qa collections grid (Quasar SPA): 20 cards/page; ?page=N
    // is ignored and no numbered pager is exposed â€” advance via the Next
    // arrow (page-replacing). Product slugs carry the brand, so no title
    // selector is needed. No text search endpoint (telecom, like du/e&).
    devices: {
      url: 'https://eshop.ooredoo.qa/en/collections/mobile-phones',
      card: '.desktop-product-card-width',
      nextButton: true,
      pages: 5,
    },
    reviews: { url: 'https://eshop.ooredoo.qa/en/products/samsung-galaxy-s26-ultra-5g' },
  },
  {
    id: 'vodafone',
    name: 'Vodafone Qatar',
    type: 'operator',
    url: 'https://www.vodafone.qa/en/home',
    region: 'Qatar',
    timezoneId: 'Asia/Qatar',
    locale: 'en-QA',
    // shop.vodafone.qa is a React storefront: cards are <article>s with
    // hashed class names and NO anchors (JS navigation) â€” match on the
    // class-name prefix and read the card's own text ('@self'). The only
    // stable browse surface is the Deals & Promos shelf ("Showing 12 of 41
    // products", Load-next button); smartphones/mobile category URLs and
    // catalogsearch all render empty. No search share.
    devices: {
      url: 'https://shop.vodafone.qa/en/shop/digital-exclusive.html?page=1',
      card: 'article[class*="productHoverCardItem-cardRoot"]',
      title: '@self',
      totalSelector: '[class*="productCount"]',
      totalPattern: /of\s*(\d+)\s*products/i,
      loadMoreSelector: '[class*="loadButton"]',
      pages: 5,
    },
  },
  {
    id: 'emax',
    name: 'Emax',
    type: 'retailer',
    url: 'https://www.emaxme.com/', // redirects to uae.emaxme.com
    region: 'UAE',
    // Purchasable product URLs: /buy-<product>-p-<id>
    tileRegex: /\/buy-.+-p-/i,
    // SAP-Hybris-style storefront; 48 cards render on the mobiles category.
    devices: {
      url: 'https://uae.emaxme.com/shop-mobile',
      card: '.product_wrapper',
      title: '.product-desc',
      pages: 5,
    },
    reviews: { url: 'https://uae.emaxme.com/search?text=galaxy s26 ultra', findProduct: /s26[-\s]?ultra/i },
    // Real text search at /search?text= â€” same multi-phrase method as Sharaf DG.
    search: {
      kind: 'grid',
      url: 'https://uae.emaxme.com/search?text={q}',
      terms: ['phones', 'smartphone', 'mobile phone', '5g phone'],
      card: '.product_wrapper',
      title: '.product-desc',
      maxPositions: 24,
    },
  },
  {
    id: 'omantel',
    name: 'Omantel',
    type: 'operator',
    url: 'https://www.omantel.om/en/personal',
    region: 'Oman',
    timezoneId: 'Asia/Muscat',
    locale: 'en-OM',
    // NOTE: Omantel's cookie bar has "agree"-style LINKS to its terms pages â€”
    // the global consent-dismisser skips navigating anchors because of this.
    // Devices are sold via the XHAWI marketplace partner (Shopify): the
    // Omantel Store collection. Brand comes from /products/ slugs; the grid
    // grows via a Load More button (generic expandOnce handles it).
    devices: {
      url: 'https://www.xhawi.com/collections/omantel-store-collection',
      card: '.loadmore-item',
      pages: 5,
    },
  },
  {
    id: 'stc-bh',
    name: 'stc Bahrain',
    type: 'operator',
    url: 'https://www.stc.com.bh/',
    region: 'Bahrain',
    timezoneId: 'Asia/Bahrain',
    locale: 'en-BH',
    // OpenCart shop; 32 cards render with a load-more button. Product hrefs
    // are opaque ids (product_id=7149) â€” brand lives in the card text.
    devices: {
      url: 'https://shop.stc.com.bh/index.php?route=product/category&path=102&allproducts=1',
      card: '.rvl-product-element',
      title: '@self',
      loadMoreSelector: '.rvl-load-more-btn',
      pages: 5,
    },
  },
  {
    id: 'zain-kw',
    name: 'Zain Kuwait',
    type: 'operator',
    url: 'https://www.kw.zain.com/en/',
    region: 'Kuwait',
    timezoneId: 'Asia/Kuwait',
    locale: 'en-KW',
    // Hero carousel renders the same creative in several blocks AND as
    // separate image/CTA elements pointing at one product â€” dedupe by
    // destination so one campaign counts once.
    bannerDedupe: 'href',
    // Liferay shop; /en/shop/devices renders 15 product cards (devices +
    // accessories) with brand in the card text and product-slug hrefs.
    devices: {
      url: 'https://www.kw.zain.com/en/shop/devices',
      card: '.products-grid-item',
      title: '@self',
      pages: 5,
    },
  },
  {
    id: 'xcite',
    name: 'Xcite',
    type: 'retailer',
    url: 'https://www.xcite.com/',
    region: 'Kuwait',
    timezoneId: 'Asia/Kuwait',
    locale: 'en-KW',
    // Product pages end in /p â€” purchasable tiles.
    tileRegex: /\/p(?:\?|\s|$)/i,
    devices: {
      url: 'https://www.xcite.com/mobile-phones/c',
      card: 'li.product',
      title: '[class*="ProductTile_productName"]',
      pages: 5,
    },
    reviews: { url: 'https://www.xcite.com/samsung-s26-ultra-5g-phone-6-3-12gb-512gb-violet/p' },
    // Algolia search; relevance mixes accessories in, judged over 24 like the
    // other retailers.
    search: {
      kind: 'grid',
      url: 'https://www.xcite.com/search?query={q}',
      terms: ['phones', 'smartphone', 'mobile phone', '5g phone'],
      card: 'li.product',
      title: '[class*="ProductTile_productName"]',
      maxPositions: 24,
    },
  },
  {
    id: 'amazon',
    name: 'Amazon UAE',
    type: 'retailer',
    url: 'https://www.amazon.ae/',
    region: 'UAE',
    // Product detail pages: /dp/<asin>
    tileRegex: /\/dp\//i,
    // Amazon has no browsable phones shelf â€” the smartphones search grid IS
    // its shelf. Cards: [data-component-type=s-search-result] (48/page,
    // sponsored included); brand from card text + /dp/ slugs. Next button
    // truly navigates â€” firstCardId tolerates the context swap.
    devices: {
      url: 'https://www.amazon.ae/s?k=smartphones',
      card: '[data-component-type="s-search-result"]',
      title: '@self',
      nextButton: true,
      pages: 5,
    },
    search: {
      kind: 'grid',
      url: 'https://www.amazon.ae/s?k={q}',
      terms: ['phones', 'smartphone', 'mobile phone', '5g phone'],
      card: '[data-component-type="s-search-result"]',
      title: '@self',
      maxPositions: 24,
    },
    reviews: { url: 'https://www.amazon.ae/s?k=samsung+galaxy+s26+ultra', findProduct: /s26[-\s]?ultra/i },
  },
  // NOTE noon.com (user requested 2026-07-14): NOT feasible with the current
  // stack â€” noon resets automated HTTP/2 connections and hangs HTTP/1.1
  // (TLS-fingerprint bot detection) even from residential IPs. Needs a
  // stealth-patched browser or scraping API; parked until decided.
  // stc removed from the active roster 2026-07-06 (user request:
  // "remove for now"). Its tuning notes are preserved in DISABLED_SITES
  // below â€” move the entry back into SITES to re-enable it.
  {
    id: 'sharafdg',
    name: 'Sharaf DG',
    type: 'retailer',
    url: 'https://uae.sharafdg.com/',
    region: 'UAE',
    // Unified banner method (2026-07-08, user decision): count any distinct
    // Samsung promotional placement â€” image creatives AND Samsung-linked
    // tiles/CTAs â€” same definition as e& and du. Noise is handled generically:
    // lazy-load placeholder images are excluded by the global ICON_RE, and
    // dedupe is by destination link â€” the hero swiper clones each slide ~3x
    // and product tiles repeat across carousels, but clones share an href.
    bannerDedupe: 'href',
    // Placement class: anything linking to a product detail page is a product
    // tile; campaign pages (/samsung-galaxy-s26-series/, /new-launches/,
    // /brand/samsung/) stay banners.
    tileRegex: /\/product\//i,
    reviews: {
      url: 'https://uae.sharafdg.com/product/samsung-galaxy-s26-ultra-5g-256gb-12gb-ram-black-ai-phone-middle-east-version/',
    },
    // Category grid is Algolia-rendered: 48 cards/page under .algolia-item,
    // paged by a numbered widget (span.go-to-page[data-page], ~14 pages) that
    // REPLACES the grid per page. No visible grand-total counter. Cards carry
    // no brand label â€” Samsung is matched on the .product-link title/href.
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

// Parked site configs â€” not crawled. Kept so their WAF/selector notes survive.
const DISABLED_SITES = [
  {
    id: 'stc',
    name: 'stc',
    // /content/stc/sa/en.html 404s; this is the live English Devices page.
    // stc sits behind an Imperva-style WAF â€” needs the stealth context.
    // NOTE: stc renders its device grid lazily with SKU-based (non-branded)
    // image URLs, so brand only appears in copy. It currently yields 0 with the
    // default own-attribute matching; this is a prime per-site tuning target
    // (e.g. enable the container-text signal for stc, or wait on its product API).
    url: 'https://www.stc.com.sa/content/stc/sa/en/personal/devices.html',
    region: 'KSA',
    timezoneId: 'Asia/Riyadh',
    locale: 'en-SA',
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
 * Competition analysis (researched 2026-07: Statista/Omdia â€” Samsung
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

// Product divisions â€” checked in order; first match wins, so accessories
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
