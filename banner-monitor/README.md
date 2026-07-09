# Samsung Banner Monitor

Loads partner telecom landing pages with **Playwright (headless Chromium)**,
counts the **Samsung banners** on each, stores a daily count, and **emails** a
recipient list whenever a count changes. No hosted scraping service.

## Quick start

```bash
npm install            # installs deps + Chromium (postinstall)
cp .env.example .env   # optional — runs out of the box without it
npm run check          # one full pass across all sites, prints per-site counts
```

With **no** Supabase or email creds, it uses a local SQLite file
(`banner-monitor/data/banners.db`) and logs the email payload it *would* send.

## Commands

| Command | What it does |
| --- | --- |
| `npm run check` | One-off run across all sites (the scheduled job entrypoint). |
| `npm run scrape:test [siteId]` | Prove the scraper on one site (default `e&`), printing matches. |
| `npm run dev:server` | Start the Express API + daily cron (09:00 Asia/Dubai). |
| `npm run install:browser` | Re-install Chromium if the postinstall was skipped. |

Run a subset: `node banner-monitor/run.js e& du`

## Architecture

```
banner-monitor/
  config.js     SITES + detection regex + per-site overrides (regex, consent, locale, tz)
  scraper.js    Playwright: load page, dismiss consent, auto-scroll, count banners
  store.js      saveRun / getLastRun (+ history, recipients) — Supabase or SQLite
  notify.js     diff logic + sendAlert (Resend or SMTP, else logs payload)
  run.js        orchestrates one full run across all sites
  server.js     Express API for the dashboard + POST /run + node-cron schedule
  schema.sql    Supabase/Postgres DDL (SQLite equivalent lives in store.js)
```

Storage backend is chosen automatically: **Supabase** if `SUPABASE_URL` +
`SUPABASE_SERVICE_KEY` are set, otherwise **SQLite**. Email uses **Resend** if
`RESEND_API_KEY` is set, otherwise **SMTP** (`SMTP_*`), otherwise logs the payload.

## API (server.js)

- `GET  /api/sites` — latest count + last 7 runs per site
- `GET  /api/log` — recent run events
- `POST /api/run` — trigger a run now
- `GET/PUT /api/recipients` — manage the alert list
- `GET  /api/health`, `GET /screenshots/<file>` — health + screenshot audit

The dashboard (`banner-monitor-dashboard.jsx`) consumes these. Point it at the
server with `NEXT_PUBLIC_BANNER_API` (default `http://localhost:4000`). The
server is decoupled from Next.js — deploy it standalone (Railway/Render).

## Detection notes (expect per-site tuning)

- A banner is matched when the candidate's **own** signals (image URL, `alt`,
  `aria-label`, `title`, or the nearest `<a>` href) match the per-site regex
  (default `/samsung|galaxy|z\s?flip|z\s?fold/i`). Surrounding container text is
  collected for labels but **not** used for matching — it bleeds badly (it made
  rival-brand logos near a "Samsung" heading match).
- Matches are deduped by the nearest carousel **slide / banner block** so one
  banner's image + button + caption count **once**.
- Site chrome (header/nav/footer/mega-menu), icons/arrows, and pagination
  counters are excluded.
- **Not caught:** banners inside cross-origin `<iframe>`s and individual promos
  inside a CSS sprite sheet. Regex/selectors are expected to be tuned per site.

### Live-site caveats discovered while building

The originally seeded URLs had drifted — fixed in `config.js`:

- **e&**: `etisalat.ae` is now a rebrand splash → uses `eand.ae`. **(4 banners)**
- **du**: works as-is. **(6 banners)**
- **stc**: old URL 404s and the site is behind an Imperva-style WAF (handled by
  the stealth context). Now points at the Devices page; its grid loads lazily
  with SKU-based image URLs, so it currently reads **0** — a per-site tuning target.
- **Ooredoo**: old URL 404s; behind an F5 BIG-IP WAF (handled by stealth). Now
  points at `/web/en/`. **(2 banners — Galaxy S26 / S26 Ultra)**

WAF blocks are detected and recorded as **errors**, never as a `0` count, so a
block never triggers a false "count dropped" alert.

## Environment variables

See `.env.example`: `SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY,
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_FROM, ALERT_RECIPIENTS,
ALERT_ON, PORT, TZ`.
