'use strict';

/**
 * social.js — social share-of-voice for the monitored operators/retailers.
 *
 * Methodology mirrors the SamsungSentiment project: Apify post scrapers run
 * on a daily Apify schedule (one run covers ALL configured handles), and this
 * module ingests their datasets into the store. Platforms: Instagram, TikTok
 * and Facebook only (user decision 2026-07-16).
 *
 * Every post is classified against config.BRANDS on its caption text:
 *   - samsung  : mentions Samsung/Galaxy
 *   - s26      : mentions the Galaxy S26 series specifically
 *   - brands   : all brand ids matched (competitor detection)
 *
 * Tracking window starts 2026-01-01 (SOCIAL_SINCE); older posts are dropped.
 *
 * CLI:
 *   node banner-monitor/social.js backfill   start runs since Jan 1, wait, ingest
 *   node banner-monitor/social.js sync       ingest recent scheduled runs (daily cron)
 *   node banner-monitor/social.js schedule   create/refresh the daily Apify schedule
 */

const { SITES, BRANDS } = require('./config');
const store = require('./store');

// Read lazily — the CLI at the bottom loads dotenv after the module body ran.
const token = () => process.env.APIFY_API_TOKEN;
const APIFY_BASE = 'https://api.apify.com/v2';

// Same actors as the SamsungSentiment pipeline ("My Schedule 5").
const ACTORS = {
  instagram: 'nH2AHrwxeTRJoN5hX', // apify/instagram-post-scraper
  tiktok: 'GdWCkxBtKWOsKjdch', //    clockworks/tiktok-scraper
  facebook: 'KoJrdxJCTtpon81KY', //  apify/facebook-posts-scraper
};

const SOCIAL_SINCE = '2026-01-01';
const SCHEDULE_NAME = 'visibility-monitor-social';

// Galaxy S26 series mentions (S26 / S26+ / S26 Ultra, with or without "Galaxy").
const S26_RE = /galaxy\s*s\s?26|(?<![\w.])s\s?26(?:\s*(?:ultra|plus|\+|edge))?(?![\w.])/i;

/* ---------------- classification ---------------- */

function classifyCaption(text) {
  const t = String(text || '');
  const brands = [];
  for (const b of BRANDS) if (b.regex.test(t)) brands.push(b.id);
  const s26 = S26_RE.test(t);
  // An S26 mention is a Samsung post even when the caption never says
  // "Samsung"/"Galaxy" (e.g. "Get the S26+ with 20% off").
  if (s26 && !brands.includes('samsung')) brands.unshift('samsung');
  return { brands, samsung: brands.includes('samsung'), s26 };
}

/* ---------------- handle → site mapping ---------------- */

function socialSites() {
  return SITES.filter((s) => s.social);
}

// Lowercased handle → site id, per platform.
function handleMap(platform) {
  const map = {};
  for (const s of socialSites()) {
    const h = s.social[platform];
    if (h) map[h.toLowerCase()] = s.id;
  }
  return map;
}

// Facebook items don't carry the page handle as a clean field — match the
// handle inside the post/page URLs, falling back to a squashed pageName
// comparison (e.g. "X-cite by Alghanim Electronics" vs "XcitebyAlghanim").
function facebookSiteOf(item) {
  const map = handleMap('facebook');
  const urls = [item.inputUrl, item.facebookUrl, item.url, item.topLevelUrl, item.pageUrl]
    .filter(Boolean)
    .map((u) => String(u).toLowerCase());
  for (const [handle, siteId] of Object.entries(map)) {
    if (urls.some((u) => u.includes(`facebook.com/${handle}/`) || u.endsWith(`facebook.com/${handle}`))) {
      return siteId;
    }
  }
  const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pageName = squash(item.pageName || (item.user && item.user.name));
  if (pageName) {
    for (const [handle, siteId] of Object.entries(map)) {
      const h = squash(handle);
      if (pageName.includes(h) || h.includes(pageName)) return siteId;
    }
  }
  return null;
}

/* ---------------- per-platform normalizers ---------------- */

// Each returns { siteId, post } or null (unmapped author / unusable item).
function normalizeInstagram(item) {
  const owner = String(item.ownerUsername || '').toLowerCase();
  const siteId = handleMap('instagram')[owner];
  const id = item.id || item.shortCode;
  if (!siteId || !id || !item.timestamp) return null;
  return {
    siteId,
    post: {
      platform: 'instagram',
      id: String(id),
      url: item.url || (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : null),
      at: new Date(item.timestamp).toISOString(),
      likes: item.likesCount || 0,
      comments: item.commentsCount || 0,
      views: item.videoViewCount || 0,
      ...classifyCaption(item.caption),
    },
  };
}

function normalizeTikTok(item) {
  const author = String((item.authorMeta && item.authorMeta.name) || '').toLowerCase();
  const siteId = handleMap('tiktok')[author];
  const at = item.createTimeISO || (item.createTime ? new Date(item.createTime * 1000).toISOString() : null);
  if (!siteId || !item.id || !at) return null;
  return {
    siteId,
    post: {
      platform: 'tiktok',
      id: String(item.id),
      url: item.webVideoUrl || `https://www.tiktok.com/@${author}/video/${item.id}`,
      at: new Date(at).toISOString(),
      likes: item.diggCount || 0,
      comments: item.commentCount || 0,
      views: item.playCount || 0,
      ...classifyCaption(item.text),
    },
  };
}

function normalizeFacebook(item) {
  const siteId = facebookSiteOf(item);
  const id = item.postId || item.id;
  const at = item.time || item.date;
  if (!siteId || !id || !at) return null;
  return {
    siteId,
    post: {
      platform: 'facebook',
      id: String(id),
      url: item.url || item.topLevelUrl || null,
      at: new Date(at).toISOString(),
      likes: item.likes || (item.reactions && item.reactions.total) || 0,
      comments: item.comments || 0,
      views: 0,
      ...classifyCaption(item.text || item.message),
    },
  };
}

const NORMALIZERS = {
  instagram: normalizeInstagram,
  tiktok: normalizeTikTok,
  facebook: normalizeFacebook,
};

/* ---------------- Apify plumbing ---------------- */

function requireToken() {
  if (!token()) throw new Error('APIFY_API_TOKEN is not set');
}

async function apify(pathname, opts) {
  const sep = pathname.includes('?') ? '&' : '?';
  const res = await fetch(`${APIFY_BASE}${pathname}${sep}token=${token()}`, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Apify ${pathname} -> ${res.status}: ${(body && body.error && body.error.message) || ''}`);
  }
  return body;
}

// Actor inputs. `newerThan` accepts a date (backfill) or a relative window
// like "3 days" (daily schedule). Limits are per profile/page.
function buildInput(platform, newerThan, limit) {
  const handles = socialSites()
    .map((s) => s.social[platform])
    .filter(Boolean);
  if (platform === 'instagram') {
    return {
      username: handles,
      onlyPostsNewerThan: newerThan,
      resultsLimit: limit,
      skipPinnedPosts: true,
    };
  }
  if (platform === 'tiktok') {
    return {
      profiles: handles,
      profileScrapeSections: ['videos'],
      profileSorting: 'latest',
      excludePinnedPosts: true,
      oldestPostDateUnified: newerThan,
      resultsPerPage: limit,
    };
  }
  return {
    startUrls: handles.map((h) => ({ url: `https://www.facebook.com/${h}/` })),
    onlyPostsNewerThan: newerThan,
    resultsLimit: limit,
    captionText: false,
  };
}

async function startRun(platform, newerThan, limit, maxChargeUsd) {
  const body = JSON.stringify(buildInput(platform, newerThan, limit));
  const out = await apify(`/acts/${ACTORS[platform]}/runs?maxTotalChargeUsd=${maxChargeUsd}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return out.data;
}

async function waitForRun(runId, timeoutMs = 30 * 60000) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await apify(`/actor-runs/${runId}`);
    if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(data.status)) return data;
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} still ${data.status} after timeout`);
    await new Promise((r) => setTimeout(r, 15000));
  }
}

async function datasetItems(datasetId, maxItems = 50000) {
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (all.length < maxItems) {
    const res = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${token()}&limit=${PAGE}&offset=${offset}`);
    if (!res.ok) break;
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function latestSucceededRuns(actorId, limit) {
  const out = await apify(`/acts/${actorId}/runs?limit=${limit}&desc=true&status=SUCCEEDED`);
  return (out.data && out.data.items) || [];
}

/* ---------------- ingest ---------------- */

// Normalize + classify raw actor items and merge them into the store.
async function ingestItems(byPlatform) {
  // platform+id → { siteId, post }; newest scrape wins.
  const merged = new Map();
  const counts = { instagram: 0, tiktok: 0, facebook: 0, unmapped: 0, old: 0 };
  for (const [platform, items] of Object.entries(byPlatform)) {
    const normalize = NORMALIZERS[platform];
    for (const item of items) {
      if (!item || item.error) continue;
      const n = normalize(item);
      if (!n) {
        counts.unmapped++;
        continue;
      }
      if (n.post.at < SOCIAL_SINCE) {
        counts.old++;
        continue;
      }
      merged.set(`${platform}:${n.post.id}`, n);
      counts[platform]++;
    }
  }

  const bySite = {};
  for (const { siteId, post } of merged.values()) {
    (bySite[siteId] = bySite[siteId] || []).push(post);
  }
  for (const [siteId, posts] of Object.entries(bySite)) {
    await store.mergeSocialPosts(siteId, posts);
  }
  return { ...counts, sites: Object.keys(bySite).length, posts: merged.size };
}

// Ingest the datasets of specific run ids (used right after a backfill).
async function ingestRuns(runsByPlatform) {
  const byPlatform = {};
  for (const [platform, runs] of Object.entries(runsByPlatform)) {
    byPlatform[platform] = [];
    for (const run of runs) {
      byPlatform[platform].push(...(await datasetItems(run.defaultDatasetId)));
    }
  }
  return ingestItems(byPlatform);
}

// Daily sync: read the last few succeeded runs per actor (the Apify schedule
// produces one per day; reading several back-fills missed days — the store
// merge dedupes overlap).
async function syncSocial(runCount = 7) {
  requireToken();
  const runsByPlatform = {};
  for (const [platform, actorId] of Object.entries(ACTORS)) {
    runsByPlatform[platform] = (await latestSucceededRuns(actorId, runCount)).reverse();
  }
  return ingestRuns(runsByPlatform);
}

/* ---------------- backfill + schedule ---------------- */

// One-off history load: everything since SOCIAL_SINCE for every handle.
async function backfillSocial() {
  requireToken();
  console.log(`[social] starting backfill runs since ${SOCIAL_SINCE} …`);
  const runs = {};
  for (const platform of Object.keys(ACTORS)) {
    // High per-profile limits so ~6 months of brand posting fits; charge-capped.
    const run = await startRun(platform, SOCIAL_SINCE, 500, 15);
    console.log(`[social] ${platform} run ${run.id} started`);
    runs[platform] = run;
  }
  const done = {};
  for (const [platform, run] of Object.entries(runs)) {
    const fin = await waitForRun(run.id);
    console.log(`[social] ${platform} run ${fin.id} -> ${fin.status}`);
    done[platform] = fin.status === 'SUCCEEDED' ? [fin] : [];
  }
  const result = await ingestRuns(done);
  console.log('[social] backfill ingested:', JSON.stringify(result));
  return result;
}

// Create (or refresh) the daily Apify schedule covering all handles. The
// schedule scrapes a rolling 3-day window so a missed day is self-healing;
// the GitHub Actions daily run calls `sync` to ingest the results.
async function ensureSchedule() {
  requireToken();
  const actions = Object.keys(ACTORS).map((platform) => ({
    type: 'RUN_ACTOR',
    actorId: ACTORS[platform],
    runInput: {
      body: JSON.stringify(buildInput(platform, '3 days', 20)),
      contentType: 'application/json; charset=utf-8',
    },
    runOptions: { maxTotalChargeUsd: 3 },
  }));
  const existing = await apify('/schedules?limit=100');
  const found = ((existing.data && existing.data.items) || []).find((s) => s.name === SCHEDULE_NAME);
  const payload = {
    name: SCHEDULE_NAME,
    title: 'Visibility monitor — social posts',
    cronExpression: '0 4 * * *', // 08:00 Asia/Dubai, an hour before the site check ingests
    timezone: 'UTC',
    isEnabled: true,
    isExclusive: true,
    actions,
  };
  const out = found
    ? await apify(`/schedules/${found.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    : await apify('/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
  console.log(`[social] schedule ${found ? 'updated' : 'created'}: ${out.data.id} (${out.data.cronExpression})`);
  return out.data;
}

module.exports = { syncSocial, backfillSocial, ensureSchedule, classifyCaption, SOCIAL_SINCE };

/* ---------------- CLI ---------------- */

if (require.main === module) {
  require('dotenv').config();
  const cmd = process.argv[2] || 'sync';
  const main = { sync: () => syncSocial(), backfill: backfillSocial, schedule: ensureSchedule }[cmd];
  if (!main) {
    console.error('usage: node banner-monitor/social.js [sync|backfill|schedule]');
    process.exit(1);
  }
  main()
    .then((r) => {
      if (cmd === 'sync') console.log('[social] sync:', JSON.stringify(r));
    })
    .catch((err) => {
      console.error('[social] FAILED:', err.message);
      process.exit(1);
    });
}
