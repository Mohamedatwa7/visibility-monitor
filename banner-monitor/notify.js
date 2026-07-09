'use strict';

/**
 * notify.js — diff logic + alert delivery.
 *
 * buildChanges(items, mode) : decide which sites changed.
 *   items: [{ name, prev, count, matches }]  (prev = previous count or null)
 *   mode : 'change' (any change) | 'drop' (only when count fell)
 *
 * sendAlert(changes) : deliver the alert email.
 *   - Resend     if RESEND_API_KEY is set.
 *   - Nodemailer if SMTP_HOST is set.
 *   - Otherwise  logs the exact payload it WOULD have sent (no crash, no creds).
 */

const store = require('./store');
const { ALERT_ON } = require('./config');

// Did a shelf-share measurement move? First-ever measurements (no prior) are
// not changes, same as banner counts. In 'drop' mode only a falling share fires.
function shareChange(prevS, curS, mode) {
  if (!prevS || !curS) return null;
  const moved = prevS.samsung !== curS.samsung || prevS.sharePct !== curS.sharePct;
  if (!moved) return null;
  if (mode === 'drop' && !(Number(curS.sharePct) < Number(prevS.sharePct))) return null;
  return { prev: prevS, cur: curS };
}

function buildChanges(items, mode = ALERT_ON) {
  const changes = [];
  for (const it of items) {
    const prev = it.prev;
    const count = it.count;
    // First-ever run (no prior count) is not treated as a "change".
    const bannerChanged =
      prev !== null &&
      prev !== undefined &&
      prev !== count &&
      !(mode === 'drop' && count >= prev);

    const deviceChange = shareChange(it.prevDeviceShare, it.deviceShare, mode);
    const searchChange = shareChange(it.prevSearchShare, it.searchShare, mode);

    // Promo cards and product tiles are diffed like the hero count.
    const countChanged = (prevV, curV) =>
      prevV != null && curV != null && prevV !== curV && !(mode === 'drop' && curV >= prevV);
    const promosChanged = countChanged(it.prevPromo, it.promoCount);
    const tilesChanged = countChanged(it.prevTiles, it.tileCount);

    if (!bannerChanged && !deviceChange && !searchChange && !tilesChanged && !promosChanged) continue;
    changes.push({
      name: it.name,
      prev,
      count,
      bannerTotal: it.bannerTotal == null ? null : it.bannerTotal,
      prevPromo: it.prevPromo == null ? null : it.prevPromo,
      promoCount: it.promoCount == null ? null : it.promoCount,
      promoTotal: it.promoTotal == null ? null : it.promoTotal,
      prevTiles: it.prevTiles == null ? null : it.prevTiles,
      tileCount: it.tileCount == null ? null : it.tileCount,
      tileTotal: it.tileTotal == null ? null : it.tileTotal,
      matches: it.matches || [],
      bannerChanged,
      promosChanged,
      tilesChanged,
      deviceChange,
      searchChange,
    });
  }
  return changes;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtShareTxt(s) {
  if (!s) return '—';
  const pct = s.sharePct == null ? '?' : `${s.sharePct}%`;
  return `${s.samsung}/${s.total} (${pct})`;
}

// One human line per share movement, e.g.
//   Device pages: 12/40 (30%) → 10/40 (25%) ▼
function shareLines(c) {
  const lines = [];
  if (c.promosChanged) {
    const dir = c.promoCount > c.prevPromo ? '▲' : '▼';
    const total = c.promoTotal ? ` of ${c.promoTotal}` : '';
    lines.push(`Promo cards: ${c.prevPromo} → ${c.promoCount}${total} ${dir}`);
  }
  if (c.tilesChanged) {
    const dir = c.tileCount > c.prevTiles ? '▲' : '▼';
    const total = c.tileTotal ? ` of ${c.tileTotal}` : '';
    lines.push(`Product tiles: ${c.prevTiles} → ${c.tileCount}${total} ${dir}`);
  }
  if (c.deviceChange) {
    const { prev, cur } = c.deviceChange;
    const dir = Number(cur.sharePct) > Number(prev.sharePct) ? '▲' : '▼';
    lines.push(`Device pages: ${fmtShareTxt(prev)} → ${fmtShareTxt(cur)} ${dir}`);
  }
  if (c.searchChange) {
    const { prev, cur } = c.searchChange;
    const dir = Number(cur.sharePct) > Number(prev.sharePct) ? '▲' : '▼';
    const label = cur.kind === 'facet' ? `Search facet "${cur.term}"` : `Search "${cur.term}"`;
    lines.push(`${label}: ${fmtShareTxt(prev)} → ${fmtShareTxt(cur)} ${dir}`);
    // Per-term breakdown when the site is measured over several search phrases.
    if (Array.isArray(cur.results) && cur.results.length > 1) {
      for (const r of cur.results) {
        lines.push(r.error ? `  · "${r.term}": failed (${r.error})` : `  · "${r.term}": ${fmtShareTxt(r)}`);
      }
    }
  }
  return lines;
}

function renderEmail(changes, runAt) {
  const subject = `Samsung visibility change across ${changes.length} partner site(s)`;

  const rows = changes
    .map((c) => {
      const dir = c.count > c.prev ? '▲' : '▼';
      const pctNote =
        c.bannerTotal ? ` — ${Math.round((c.count / c.bannerTotal) * 1000) / 10}% of ${c.bannerTotal} banners on the page` : '';
      const bannerCell = c.bannerChanged
        ? `Hero: ${c.prev} → <strong>${c.count}</strong> ${dir}${escapeHtml(pctNote)}`
        : `Hero: ${c.count} (unchanged)${escapeHtml(pctNote)}`;
      const shares = shareLines(c)
        .map((l) => `<li>${escapeHtml(l)}</li>`)
        .join('');
      const links = (c.matches || [])
        .filter((m) => m.section !== 'tile') // tile lists are long — counts only
        .map((m) => {
          const url = m.href || m.src || '';
          const label = escapeHtml(m.alt || url || '(banner)');
          return url
            ? `<li><a href="${escapeHtml(url)}">${label}</a></li>`
            : `<li>${label}</li>`;
        })
        .join('');
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">${escapeHtml(c.name)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">Banners: ${bannerCell}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding:0 12px 12px 24px;border-bottom:1px solid #eee;">
            ${shares ? `<ul style="margin:6px 0;padding-left:18px;color:#111;font-size:13px;font-weight:600;">${shares}</ul>` : ''}
            <ul style="margin:6px 0;padding-left:18px;color:#444;font-size:13px;">${links || '<li>(no matched links)</li>'}</ul>
          </td>
        </tr>`;
    })
    .join('');

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;max-width:640px;">
    <h2 style="margin:0 0 4px;">Samsung visibility change detected</h2>
    <p style="color:#666;margin:0 0 16px;">Run at ${escapeHtml(runAt)}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">${rows}</table>
    <p style="color:#999;font-size:12px;margin-top:16px;">
      Automated by banner-monitor. Counts are signal/regex based and may need per-site tuning.
    </p>
  </div>`;

  const text = changes
    .map((c) => {
      const banner = c.bannerChanged ? `banners ${c.prev} -> ${c.count}` : `banners ${c.count} (unchanged)`;
      const shares = shareLines(c).map((l) => `  ${l}`).join('\n');
      const links = (c.matches || [])
        .filter((m) => m.section !== 'tile')
        .map((m) => `    - ${m.href || m.src || m.alt || '(banner)'}`)
        .join('\n');
      return `${c.name}: ${banner}${shares ? `\n${shares}` : ''}\n${links}`;
    })
    .join('\n\n');

  return { subject, html, text: `Samsung visibility change detected (run at ${runAt})\n\n${text}` };
}

async function deliver({ from, to, subject, html, text }) {
  // 1) Resend
  if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({ from, to, subject, html, text });
    if (error) throw error;
    return { via: 'resend', id: data && data.id };
  }

  // 2) Nodemailer over SMTP
  if (process.env.SMTP_HOST) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    });
    const info = await transporter.sendMail({ from, to: to.join(', '), subject, html, text });
    return { via: 'smtp', id: info.messageId };
  }

  // 3) No creds — log the exact payload that would have been sent.
  console.log('\n[notify] No email creds set — logging the email payload instead:');
  console.log(
    JSON.stringify({ from, to, subject, text }, null, 2)
  );
  return { via: 'log-only' };
}

async function sendAlert(changes) {
  if (!changes || !changes.length) return { sent: false, reason: 'no-changes' };

  const to = await store.getRecipients();
  const runAt = new Date().toISOString();
  const { subject, html, text } = renderEmail(changes, runAt);
  const from = process.env.ALERT_FROM || 'banner-monitor <alerts@example.com>';

  if (!to.length) {
    console.warn('[notify] Changes detected but no recipients configured — logging payload only.');
    await deliver({ from, to: ['(no recipients)'], subject, html, text });
    return { sent: false, reason: 'no-recipients' };
  }

  const result = await deliver({ from, to, subject, html, text });
  console.log(`[notify] Alert delivered via ${result.via} to ${to.length} recipient(s).`);
  return { sent: result.via !== 'log-only', via: result.via, to };
}

module.exports = { buildChanges, sendAlert, renderEmail };
