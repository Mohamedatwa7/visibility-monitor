'use strict';

/**
 * vision.js — AI cross-check for the banner counter.
 *
 * Sends the run's full-page screenshot to Claude and asks it to count Samsung
 * promotional placements like a human would. The deterministic DOM count in
 * scraper.js stays the OFFICIAL metric (stable, free, diffable); this is a
 * second opinion that catches selector drift — when the two disagree, either
 * the site changed its markup or the DOM count is missing something.
 *
 * Requires ANTHROPIC_API_KEY (in .env). Skipped silently when unset.
 * Model: claude-opus-4-8 by default; override with VISION_MODEL.
 */

const fs = require('fs');
const path = require('path');

const MODEL = process.env.VISION_MODEL || 'claude-opus-4-8';

// The API rejects images beyond 8000px per side; full-page screenshots of long
// retail homepages exceed that. Cap conservatively (also controls token cost).
const MAX_HEIGHT = 7000;
const MAX_WIDTH = 1200;

// PNG dimensions live in the IHDR chunk: width at byte 16, height at byte 20.
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452 /* "IHDR" */) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Downscale an oversized screenshot by re-rendering it in headless Chromium
// (already a dependency) — no native image library needed.
async function downscalePng(buf, scale, targetW) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: targetW, height: 800 } });
    await page.setContent(
      `<style>*{margin:0;padding:0}</style>` +
        `<img id="s" src="data:image/png;base64,${buf.toString('base64')}" style="width:${targetW}px;display:block">`
    );
    await page.waitForSelector('img#s');
    await page.waitForTimeout(300); // let decode settle
    return await page.locator('#s').screenshot({ type: 'png' });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function preparedImage(screenshotPath) {
  let buf = fs.readFileSync(screenshotPath);
  const size = pngSize(buf);
  if (size && (size.height > MAX_HEIGHT || size.width > MAX_WIDTH)) {
    const scale = Math.min(MAX_HEIGHT / size.height, MAX_WIDTH / size.width, 1);
    const targetW = Math.max(1, Math.round(size.width * scale));
    buf = await downscalePng(buf, scale, targetW);
  }
  return buf.toString('base64');
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hero_banner_count', 'promo_card_count', 'product_tile_count', 'placements', 'notes'],
  properties: {
    hero_banner_count: {
      type: 'integer',
      description: 'Distinct Samsung HERO banners: the big campaign picture, usually the top carousel',
    },
    promo_card_count: {
      type: 'integer',
      description: 'Distinct Samsung PROMO cards: mid-size promotional boxes/strips for a Samsung campaign',
    },
    product_tile_count: {
      type: 'integer',
      description: 'Distinct Samsung PRODUCT tiles: a purchasable product with price / add-to-cart',
    },
    placements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'label', 'location'],
        properties: {
          section: { type: 'string', enum: ['hero', 'promo', 'tile'] },
          label: { type: 'string', description: 'What the placement shows, e.g. "Galaxy S26 hero banner"' },
          location: { type: 'string', description: 'Where on the page, e.g. "hero carousel, top of page"' },
        },
      },
    },
    notes: { type: 'string', description: 'Anything ambiguous about the count, or empty string' },
  },
};

function buildPrompt(site) {
  return (
    `This is a full-page screenshot of the ${site.name} homepage (${site.url}), a retail/telecom site in the Gulf region.\n\n` +
    `Count every distinct SAMSUNG promotional placement visible on the page, classified into three sections:\n` +
    `1. HERO BANNER — the big campaign picture, usually the top-of-page carousel (occasionally a full-width banner elsewhere).\n` +
    `2. PROMO CARD — a mid-size promotional box, card, or strip advertising a Samsung product or campaign ` +
    `(e.g. "Get the new Galaxy Z Fold7 with upgraded Galaxy AI"). Not purchasable directly.\n` +
    `3. PRODUCT TILE — a specific purchasable Samsung product shown with its price and/or an add-to-cart/buy option.\n\n` +
    `Rules: count each distinct creative once even if a carousel repeats it; do not count navigation links, ` +
    `footer text, or brand-logo strips; do not count placements for other brands (Apple, Honor, Xiaomi...).` +
    (site.tileRegex
      ? ''
      : `\n\nNote: this site has NO product tiles on its homepage (nothing is directly purchasable there) — ` +
        `classify device/product cards as PROMO CARDS, and report product_tile_count as 0.`)
  );
}

// Compare the AI counts against the DOM counts per section. domCounts is
// {hero, promo, tiles}. |combined delta| <= 1 counts as agreement — definitions
// at the margins (a logo strip, a half-visible tile) differ honestly.
async function visionCheck(site, screenshotPath, domCounts) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!screenshotPath || !fs.existsSync(screenshotPath)) {
    throw new Error(`screenshot not found: ${screenshotPath}`);
  }

  const Anthropic = require('@anthropic-ai/sdk');
  // Bounded: a slow/hanging API call must not stall the pipeline (the run
  // watchdog is the backstop; this keeps the normal path snappy).
  const client = new Anthropic({ timeout: 120000, maxRetries: 1 });

  const imageData = await preparedImage(screenshotPath);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
          { type: 'text', text: buildPrompt(site) },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('vision model declined the request');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error(`no text block in response (stop_reason: ${response.stop_reason})`);
  const parsed = JSON.parse(textBlock.text);

  const hero = parsed.hero_banner_count | 0;
  const promo = parsed.promo_card_count | 0;
  const tiles = parsed.product_tile_count | 0;
  const samsung = hero + promo + tiles;
  const dom = domCounts || {};
  const domTotal =
    dom.hero == null && dom.promo == null && dom.tiles == null
      ? null
      : (dom.hero | 0) + (dom.promo | 0) + (dom.tiles | 0);
  const delta = domTotal == null ? null : samsung - domTotal;
  return {
    model: response.model,
    hero,
    promo,
    tiles,
    samsung,
    placements: parsed.placements || [],
    notes: parsed.notes || '',
    domCounts: domTotal == null ? null : { hero: dom.hero | 0, promo: dom.promo | 0, tiles: dom.tiles | 0 },
    delta,
    agrees: delta == null ? null : Math.abs(delta) <= 1,
    inputTokens: response.usage ? response.usage.input_tokens : null,
    outputTokens: response.usage ? response.usage.output_tokens : null,
  };
}

module.exports = { visionCheck };

// ---- CLI: node banner-monitor/vision.js [siteId] — checks the latest stored run ----
if (require.main === module) {
  require('dotenv').config();
  const { SITES } = require('./config');
  const store = require('./store');
  const wantId = process.argv[2] || 'sharafdg';
  const site = SITES.find((s) => s.id === wantId);
  if (!site) {
    console.error(`Unknown site id "${wantId}"`);
    process.exit(1);
  }
  (async () => {
    const last = await store.getLastRun(site.id);
    if (!last || !last.screenshot_path) {
      console.error(`No stored run/screenshot for ${site.id} — run the monitor first.`);
      process.exit(1);
    }
    console.log(`[vision] ${site.name}: judging ${last.screenshot_path} (DOM hero=${last.count} promo=${last.promo_count} tiles=${last.tile_count})`);
    const result = await visionCheck(site, last.screenshot_path, {
      hero: last.count,
      promo: last.promo_count,
      tiles: last.tile_count,
    });
    if (!result) {
      console.error('[vision] ANTHROPIC_API_KEY not set.');
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })().catch((err) => {
    console.error('[vision] FAILED:', err);
    process.exit(1);
  });
}
