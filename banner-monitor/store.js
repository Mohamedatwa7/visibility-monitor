'use strict';

/**
 * store.js — swappable storage behind one small interface.
 *
 * Backend selection:
 *   - Supabase  : used when SUPABASE_URL + SUPABASE_SERVICE_KEY are set.
 *   - SQLite    : default fallback (banner-monitor/data/banners.db) so the tool
 *                 runs out of the box with zero config.
 *
 * Interface (all async):
 *   saveRun(row)            -> stored row           ({ site_id, count, matches, screenshot_path, run_at? })
 *   getLastRun(siteId)      -> most recent run for a site, or null
 *   getRuns(siteId, limit)  -> recent runs for a site (newest first)
 *   getRecentRuns(limit)    -> recent runs across all sites (newest first) — for the log feed
 *   getRecipients()         -> string[] of alert email recipients
 *   setRecipients(list)     -> persists + returns string[]
 *   backend                 -> 'supabase' | 'sqlite'
 */

const path = require('path');
const fs = require('fs');

const useSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

// Default recipients seed from env (comma-separated). Used when none stored yet.
function envRecipients() {
  return (process.env.ALERT_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * SQLite backend — uses Node's built-in node:sqlite (no native build).
 * Synchronous API, wrapped in the async store interface.
 * ------------------------------------------------------------------ */
function createSqliteStore() {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'banners.db'));
  db.exec('PRAGMA journal_mode = WAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS banner_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id         TEXT    NOT NULL,
      run_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      count           INTEGER NOT NULL DEFAULT 0,
      matches         TEXT    NOT NULL DEFAULT '[]',
      screenshot_path TEXT
    );
    CREATE INDEX IF NOT EXISTS banner_runs_site_idx ON banner_runs (site_id, run_at DESC);
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Migration: device/search shelf-share columns (added 2026-07). Guarded so
  // existing databases upgrade in place on first open.
  const cols = db.prepare('PRAGMA table_info(banner_runs)').all().map((c) => c.name);
  if (!cols.includes('device_share')) db.exec('ALTER TABLE banner_runs ADD COLUMN device_share TEXT');
  if (!cols.includes('search_share')) db.exec('ALTER TABLE banner_runs ADD COLUMN search_share TEXT');
  // Total banners on the landing page (all brands) — denominator for Samsung's banner share.
  if (!cols.includes('banner_total')) db.exec('ALTER TABLE banner_runs ADD COLUMN banner_total INTEGER');
  // AI (vision) cross-check of the banner count — JSON, null when not run.
  if (!cols.includes('vision_check')) db.exec('ALTER TABLE banner_runs ADD COLUMN vision_check TEXT');
  // Product tiles (Samsung / all brands) — reported separately from banners.
  if (!cols.includes('tile_count')) db.exec('ALTER TABLE banner_runs ADD COLUMN tile_count INTEGER');
  if (!cols.includes('tile_total')) db.exec('ALTER TABLE banner_runs ADD COLUMN tile_total INTEGER');
  // Promo cards (mid-size promotional boxes) — third placement section.
  // `count`/`banner_total` hold HERO banners from 2026-07-08 onward.
  if (!cols.includes('promo_count')) db.exec('ALTER TABLE banner_runs ADD COLUMN promo_count INTEGER');
  if (!cols.includes('promo_total')) db.exec('ALTER TABLE banner_runs ADD COLUMN promo_total INTEGER');
  // Competition analysis: per-brand breakdowns (sections, divisions, catalog, search).
  if (!cols.includes('competition')) db.exec('ALTER TABLE banner_runs ADD COLUMN competition TEXT');

  const parse = (r) =>
    r && {
      ...r,
      matches: safeJson(r.matches, []),
      device_share: safeJson(r.device_share, null),
      search_share: safeJson(r.search_share, null),
      vision_check: safeJson(r.vision_check, null),
      competition: safeJson(r.competition, null),
    };

  return {
    backend: 'sqlite',
    async saveRun(row) {
      const run_at = row.run_at || new Date().toISOString();
      const info = db
        .prepare(
          `INSERT INTO banner_runs (site_id, run_at, count, matches, screenshot_path, device_share, search_share, banner_total, vision_check, tile_count, tile_total, promo_count, promo_total, competition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.site_id,
          run_at,
          row.count | 0,
          JSON.stringify(row.matches || []),
          row.screenshot_path || null,
          row.device_share ? JSON.stringify(row.device_share) : null,
          row.search_share ? JSON.stringify(row.search_share) : null,
          row.banner_total == null ? null : row.banner_total | 0,
          row.vision_check ? JSON.stringify(row.vision_check) : null,
          row.tile_count == null ? null : row.tile_count | 0,
          row.tile_total == null ? null : row.tile_total | 0,
          row.promo_count == null ? null : row.promo_count | 0,
          row.promo_total == null ? null : row.promo_total | 0,
          row.competition ? JSON.stringify(row.competition) : null
        );
      return parse(db.prepare('SELECT * FROM banner_runs WHERE id = ?').get(Number(info.lastInsertRowid)));
    },
    async getLastRun(siteId) {
      return (
        parse(
          db
            .prepare('SELECT * FROM banner_runs WHERE site_id = ? ORDER BY run_at DESC, id DESC LIMIT 1')
            .get(siteId)
        ) || null
      );
    },
    async getRuns(siteId, limit = 7) {
      return db
        .prepare('SELECT * FROM banner_runs WHERE site_id = ? ORDER BY run_at DESC, id DESC LIMIT ?')
        .all(siteId, limit)
        .map(parse);
    },
    async getRecentRuns(limit = 50) {
      return db
        .prepare('SELECT * FROM banner_runs ORDER BY run_at DESC, id DESC LIMIT ?')
        .all(limit)
        .map(parse);
    },
    async getRecipients() {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('recipients');
      if (row && row.value) return safeJson(row.value, []);
      return envRecipients();
    },
    async setRecipients(list) {
      const clean = (list || []).map((s) => String(s).trim()).filter(Boolean);
      db.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('recipients', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(JSON.stringify(clean));
      return clean;
    },
    // Local mode keeps screenshots on disk — nothing to upload.
    async uploadScreenshot() {
      return null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Supabase backend
 * ------------------------------------------------------------------ */
function createSupabaseStore() {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  return {
    backend: 'supabase',
    async saveRun(row) {
      const payload = {
        site_id: row.site_id,
        count: row.count | 0,
        matches: row.matches || [],
        screenshot_path: row.screenshot_path || null,
        device_share: row.device_share || null,
        search_share: row.search_share || null,
        banner_total: row.banner_total == null ? null : row.banner_total | 0,
        vision_check: row.vision_check || null,
        tile_count: row.tile_count == null ? null : row.tile_count | 0,
        tile_total: row.tile_total == null ? null : row.tile_total | 0,
        promo_count: row.promo_count == null ? null : row.promo_count | 0,
        promo_total: row.promo_total == null ? null : row.promo_total | 0,
        competition: row.competition || null,
      };
      if (row.run_at) payload.run_at = row.run_at;
      let { data, error } = await supabase.from('banner_runs').insert(payload).select().single();
      // Deployed DBs that predate the competition column must not lose the
      // whole run — retry without it and warn.
      if (error && /competition/i.test(error.message || '')) {
        console.warn('[store] competition column missing in Supabase — run schema.sql ALTER; saving without it.');
        delete payload.competition;
        ({ data, error } = await supabase.from('banner_runs').insert(payload).select().single());
      }
      if (error) throw error;
      return data;
    },
    async getLastRun(siteId) {
      const { data, error } = await supabase
        .from('banner_runs')
        .select('*')
        .eq('site_id', siteId)
        .order('run_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      return (data && data[0]) || null;
    },
    async getRuns(siteId, limit = 7) {
      const { data, error } = await supabase
        .from('banner_runs')
        .select('*')
        .eq('site_id', siteId)
        .order('run_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    },
    async getRecentRuns(limit = 50) {
      const { data, error } = await supabase
        .from('banner_runs')
        .select('*')
        .order('run_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    },
    async getRecipients() {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'recipients')
        .limit(1);
      if (error) throw error;
      if (data && data[0] && data[0].value) return safeJson(data[0].value, []);
      return envRecipients();
    },
    async setRecipients(list) {
      const clean = (list || []).map((s) => String(s).trim()).filter(Boolean);
      const { error } = await supabase
        .from('app_settings')
        .upsert({ key: 'recipients', value: JSON.stringify(clean) }, { onConflict: 'key' });
      if (error) throw error;
      return clean;
    },
    // Upload a local screenshot to the public 'screenshots' bucket and return
    // its public URL (stored in screenshot_path so the dashboard can link it
    // from anywhere). Returns null on failure — the run must not die over a
    // screenshot.
    async uploadScreenshot(localPath) {
      try {
        const buf = fs.readFileSync(localPath);
        const name = path.basename(localPath);
        const { error } = await supabase.storage
          .from('screenshots')
          .upload(name, buf, { contentType: 'image/png', upsert: true });
        if (error) throw error;
        const { data } = supabase.storage.from('screenshots').getPublicUrl(name);
        return data && data.publicUrl ? data.publicUrl : null;
      } catch (err) {
        console.warn(`[store] screenshot upload failed: ${err.message}`);
        return null;
      }
    },
  };
}

function safeJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v; // already parsed (jsonb)
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

const store = useSupabase ? createSupabaseStore() : createSqliteStore();

module.exports = store;
