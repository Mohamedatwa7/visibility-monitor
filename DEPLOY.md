# Deploying the Samsung Visibility Monitor

Architecture (all free tiers):

```
GitHub Actions (daily 09:00 Dubai)          Vercel (always on)
  runs Playwright + AI check    ──writes──►   dashboard + API
            │                                      │ reads
            └──────────────► Supabase ◄────────────┘
                     (Postgres data + screenshot storage)
```

The local mode (`npm run dev:server` on http://localhost:4000) keeps working
unchanged — it uses SQLite + local screenshots when no Supabase env vars are set.

---

## 1. Supabase (database + screenshots)

1. Create a free project at https://supabase.com → New project.
2. SQL Editor → paste the contents of `banner-monitor/schema.sql` → Run.
3. Storage → New bucket → name `screenshots` → check **Public bucket** → Create.
4. Project Settings → API → copy:
   - **Project URL**  → this is `SUPABASE_URL`
   - **service_role key** (secret) → this is `SUPABASE_SERVICE_KEY`

## 2. GitHub (runs the daily scrape)

1. Create a repo (private is fine) at https://github.com/new — e.g. `samsung-visibility-monitor`.
2. Push this folder:
   ```
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. Repo → Settings → Secrets and variables → Actions → New repository secret, add:
   | Secret | Value |
   |---|---|
   | `SUPABASE_URL` | from step 1 |
   | `SUPABASE_SERVICE_KEY` | from step 1 |
   | `ANTHROPIC_API_KEY` | your Anthropic key (AI cross-check) |
   | `RESEND_API_KEY` | *(optional)* resend.com key for real alert emails |
   | `ALERT_FROM` | *(optional)* e.g. `alerts@yourdomain.com` |
4. Test it: repo → Actions → "Daily Samsung visibility check" → Run workflow.
   It takes ~5–8 minutes; when green, data is in Supabase.
5. For the dashboard's "Run check now" button: create a fine-grained personal
   access token at https://github.com/settings/personal-access-tokens →
   scope it to this repo with **Actions: Read and write** → save it for step 3.

## 3. Vercel (dashboard + API)

1. https://vercel.com/new → Import the GitHub repo. Framework preset: **Other**.
   Leave build command and output directory empty (defaults are fine).
2. Environment variables (Project → Settings → Environment Variables):
   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | from step 1 |
   | `SUPABASE_SERVICE_KEY` | from step 1 |
   | `GITHUB_REPO` | `<you>/<repo>` |
   | `GITHUB_TOKEN` | the PAT from step 2.5 |
   | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `1` (keeps builds fast — no browser needed on Vercel) |
3. Deploy. The dashboard is live at `https://<project>.vercel.app`.

## Notes

- **Schedule**: the scrape runs daily at 09:00 Asia/Dubai (05:00 UTC) via
  `.github/workflows/daily-check.yml`. GitHub may delay scheduled runs by a few
  minutes under load.
- **"Run check now"** on the deployed dashboard dispatches the GitHub workflow;
  new numbers appear ~5 minutes later (the button says so).
- **Alert emails** are log-only until `RESEND_API_KEY` is set. Recipients are
  managed from the dashboard.
- **Costs**: GitHub Actions free tier (~8 min/day ≈ 240 min/month, limit 2000),
  Supabase free tier, Vercel free tier. The AI cross-check spends ~$0.20/day in
  Anthropic API tokens (set `VISION_MODEL=claude-haiku-4-5` as an Actions secret
  to cut that ~10×, or remove `ANTHROPIC_API_KEY` to disable it).
- **Local dev** still works exactly as before: `node banner-monitor/server.js`
  → http://localhost:4000 (SQLite, local screenshots, synchronous run button).
