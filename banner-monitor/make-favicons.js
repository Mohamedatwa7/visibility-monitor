'use strict';

/**
 * make-favicons.js — renders public/favicon.svg into the raster fallbacks:
 *
 *   favicon.ico          16/32/48 PNG-in-ICO (tabs, bookmarks, Google search)
 *   apple-touch-icon.png 180x180 full-bleed (iOS home screen adds its own mask)
 *
 * The SVG stays the source of truth; rerun this after editing it. Outputs are
 * written to BOTH public/ copies (Vercel serves the root one, server.js the
 * banner-monitor one). Uses headless Chromium (already a dependency) — no
 * native image library needed.
 *
 *   node banner-monitor/make-favicons.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIRS = [path.join(ROOT, 'public'), path.join(__dirname, 'public')];
const SVG_PATH = path.join(ROOT, 'public', 'favicon.svg');

// ICO container with embedded PNGs (supported everywhere since Vista).
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 0);
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 1);
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(p.buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.buf.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

async function renderPng(page, svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>*{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  );
  return page.screenshot({ type: 'png', omitBackground: true });
}

(async () => {
  const svg = fs.readFileSync(SVG_PATH, 'utf8');
  // iOS composites apple-touch-icon on white and rounds it itself — make the
  // tile full-bleed so no transparent corners show.
  const fullBleed = svg.replace(/<rect [^>]*rx="15"/, '<rect x="0" y="0" width="64" height="64" rx="0"');

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const pngs = [];
    for (const size of [16, 32, 48]) pngs.push({ size, buf: await renderPng(page, svg, size) });
    const ico = buildIco(pngs);
    const touch = await renderPng(page, fullBleed, 180);

    for (const dir of PUBLIC_DIRS) {
      fs.copyFileSync(SVG_PATH, path.join(dir, 'favicon.svg'));
      fs.writeFileSync(path.join(dir, 'favicon.ico'), ico);
      fs.writeFileSync(path.join(dir, 'apple-touch-icon.png'), touch);
      console.log(`wrote favicon.svg / favicon.ico / apple-touch-icon.png -> ${dir}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
