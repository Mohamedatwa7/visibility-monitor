-- Supabase / Postgres DDL for the Samsung banner monitor.
-- (The SQLite equivalents live in store.js so the tool runs with no Supabase.)

create table if not exists banner_runs (
  id              bigint generated always as identity primary key,
  site_id         text        not null,
  run_at          timestamptz not null default now(),
  count           integer     not null default 0,
  matches         jsonb       not null default '[]'::jsonb,
  screenshot_path text,
  -- Samsung shelf-share measurements (null when the site has no share config):
  -- device_share: share of product cards on the devices catalog (first ~5 pages)
  -- search_share: share of search results for the configured term (or brand-facet share)
  device_share    jsonb,
  search_share    jsonb,
  -- total banners on the landing page (all brands) — denominator for banner share
  banner_total    integer,
  -- AI (vision) cross-check of the banner count; null when not run
  vision_check    jsonb,
  -- product tiles featuring Samsung / all brands (reported separately from banners)
  tile_count      integer,
  tile_total      integer,
  -- promo cards (mid-size promotional boxes); count/banner_total hold HERO banners
  promo_count     integer,
  promo_total     integer
);

-- Upgrading an existing deployment:
--   alter table banner_runs add column if not exists device_share jsonb;
--   alter table banner_runs add column if not exists search_share jsonb;
--   alter table banner_runs add column if not exists banner_total integer;

create index if not exists banner_runs_site_idx on banner_runs (site_id, run_at desc);

-- Simple key/value settings store (used for the alert recipient list).
create table if not exists app_settings (
  key   text primary key,
  value text
);
