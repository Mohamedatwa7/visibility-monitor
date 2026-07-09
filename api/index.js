'use strict';

/**
 * api/index.js — the Vercel serverless entry point.
 *
 * Serves the shared read-side API (webapi.js) backed by Supabase, plus a
 * /api/run that triggers the GitHub Actions scrape workflow — the actual
 * browser work cannot run on Vercel, so "Run check now" dispatches the
 * workflow and results appear when it finishes (~5 minutes).
 *
 * Required Vercel env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  — data + screenshots
 *   GITHUB_REPO   — "owner/repo" of this project on GitHub
 *   GITHUB_TOKEN  — fine-grained PAT with Actions read/write on that repo
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1  — keeps the build from fetching Chromium
 */

const express = require('express');
const cors = require('cors');

const webapi = require('../banner-monitor/webapi');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/run', async (_req, res) => {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const workflow = process.env.GITHUB_WORKFLOW || 'daily-check.yml';
  const ref = process.env.GITHUB_REF_BRANCH || 'main';
  if (!repo || !token) {
    return res.status(400).json({ error: 'GITHUB_REPO / GITHUB_TOKEN not configured on Vercel.' });
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'banner-monitor',
      },
      body: JSON.stringify({ ref }),
    });
    if (r.status !== 204) {
      const body = await r.text();
      throw new Error(`GitHub dispatch failed (${r.status}): ${body.slice(0, 200)}`);
    }
    res.json({ ok: true, queued: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(webapi);

module.exports = app;
