'use strict';

/**
 * server.js — LOCAL standalone Express server + daily cron.
 *
 * The read-side API lives in webapi.js (shared with the Vercel deployment —
 * see api/index.js). This file adds what only makes sense on a long-running
 * box with a browser installed:
 *   - POST /api/run — runs the full check synchronously in-process
 *   - node-cron daily schedule (09:00 Asia/Dubai)
 *   - static serving of local screenshots + the dashboard loader
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const store = require('./store');
const { runOnce } = require('./run');
const webapi = require('./webapi');

const app = express();
app.use(cors());
app.use(express.json());

// Serve saved screenshots for audit (read-only).
app.use('/screenshots', express.static(require('./scraper').SCREENSHOT_DIR));

// Dashboard loader (public/index.html); the JSX itself is served by webapi.
app.use(express.static(path.join(__dirname, 'public')));

let running = false; // simple guard so two runs don't overlap

app.post('/api/run', async (_req, res) => {
  if (running) return res.status(409).json({ error: 'A run is already in progress.' });
  running = true;
  try {
    const { items, changes } = await runOnce();
    res.json({
      ok: true,
      results: items.map((i) => ({ id: i.id, name: i.name, prev: i.prev, count: i.count, error: i.error })),
      changed: changes.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    running = false;
  }
});

app.use(webapi);

const PORT = Number(process.env.PORT || 4000);

// Daily check at 09:00 Asia/Dubai.
cron.schedule(
  '0 9 * * *',
  async () => {
    if (running) return;
    running = true;
    console.log('[cron] Daily 09:00 Asia/Dubai run starting…');
    try {
      await runOnce();
    } catch (err) {
      console.error('[cron] Run failed:', err.message);
    } finally {
      running = false;
    }
  },
  { timezone: 'Asia/Dubai' }
);

app.listen(PORT, () => {
  console.log(`[server] banner-monitor API on http://localhost:${PORT} (storage: ${store.backend})`);
  console.log('[server] Cron scheduled: daily 09:00 Asia/Dubai');
});
