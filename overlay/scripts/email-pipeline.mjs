#!/usr/bin/env node
/**
 * Email the current pending list to TO_EMAIL via Gmail API.
 * Auth: GMAIL_* env vars (GitHub Actions) or Application Support oauth file.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.env.CAREER_OPS_ROOT || '/Users/Anurag/Desktop/career-ops';
const PIPELINE = path.join(ROOT, 'data/pipeline.md');
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(os.homedir(), 'Library/Application Support/career-ops/gmail-oauth.json');
const TO_EMAIL = process.env.CAREER_OPS_MAIL_TO || 'anuragnkoppal@gmail.com';

function parseLine(line) {
  const m = line.match(/^- \[ \] (\S+)(?: \| (.*))?$/);
  if (!m) return null;
  const url = m[1];
  const rest = m[2] || '';
  const posted = (rest.match(/posted:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const parts = rest.split(' | ').map(s => s.trim());
  return {
    url,
    company: parts[0] || '',
    title: parts[1] || url,
    location: parts[2] || '',
    posted,
  };
}

function loadJobs() {
  const text = fs.readFileSync(PIPELINE, 'utf8');
  const pendingStart = text.indexOf('## Pending');
  const processedStart = text.search(/^## Processed/m);
  if (pendingStart === -1) return [];
  const block = text.slice(pendingStart, processedStart === -1 ? undefined : processedStart);
  return block.split('\n').map(parseLine).filter(Boolean);
}

function slotLabel(d) {
  const h = d.getHours();
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 16) return 'afternoon';
  if (h >= 16 && h < 20) return 'evening';
  return 'night';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildBodies(jobs, now) {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const ymd = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const hotCut = ymd(yesterday);
  const hot = jobs.filter(j => j.posted && j.posted >= hotCut);
  const rest = jobs.filter(j => !(j.posted && j.posted >= hotCut));
  const stamp = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
  const slot = slotLabel(now);

  const renderText = (list) => list.map((j, i) => {
    const meta = [j.company, j.location, j.posted ? `posted ${j.posted}` : ''].filter(Boolean).join(' · ');
    return `${i + 1}. ${j.title}\n   ${meta}\n   ${j.url}`;
  }).join('\n\n');

  const renderHtml = (list) => list.map((j) => {
    const meta = [j.company, j.location, j.posted ? `posted ${j.posted}` : ''].filter(Boolean).join(' · ');
    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #eee;">
        <a href="${escapeHtml(j.url)}" style="color:#1a73e8;font-weight:600;text-decoration:none;">${escapeHtml(j.title)}</a>
        <div style="color:#5f6368;font-size:13px;margin-top:4px;">${escapeHtml(meta)}</div>
      </td>
    </tr>`;
  }).join('');

  let text = `Bangalore SDE-1 Java list (${slot}) — ${stamp}\nLast 7 days, 1–3 YOE, Java/Spring. Last 24 hours first.\n\n`;
  let html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;color:#202124;">
  <p style="margin:0 0 8px;font-size:18px;font-weight:700;">Bangalore SDE-1 Java</p>
  <p style="margin:0 0 16px;color:#5f6368;font-size:13px;">${escapeHtml(slot)} · ${escapeHtml(stamp)} · last 7 days · 1–3 YOE · Java/Spring</p>`;

  if (jobs.length === 0) {
    text += 'No matching roles right now.\n';
    html += '<p>No matching roles right now.</p></div>';
  } else {
    if (hot.length) {
      text += `Last 24 hours (${hot.length})\n${renderText(hot)}\n\n`;
      html += `<p style="font-size:13px;font-weight:700;margin:16px 0 4px;">Last 24 hours (${hot.length})</p><table width="100%" cellpadding="0" cellspacing="0">${renderHtml(hot)}</table>`;
    }
    if (rest.length) {
      text += `Rest of last 7 days (${rest.length})\n${renderText(rest)}\n`;
      html += `<p style="font-size:13px;font-weight:700;margin:20px 0 4px;">Rest of last 7 days (${rest.length})</p><table width="100%" cellpadding="0" cellspacing="0">${renderHtml(rest)}</table>`;
    }
    html += '</div>';
  }

  const subject = jobs.length
    ? `Bangalore SDE-1 Java — ${jobs.length} role${jobs.length === 1 ? '' : 's'} (${slot})`
    : `Bangalore SDE-1 Java — no roles (${slot})`;
  return { subject, text, html };
}

function rfc2047(subject) {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function encodeMessage({ to, subject, text, html }) {
  const boundary = `mix_${Date.now()}`;
  const raw = [
    `To: ${to}`,
    `Subject: ${rfc2047(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function getAccessToken(oauth) {
  const now = Date.now();
  if (oauth.access_token && oauth.expiry_date && Number(oauth.expiry_date) - 60_000 > now) {
    return oauth.access_token;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: oauth.client_id,
      client_secret: oauth.client_secret,
      refresh_token: oauth.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Gmail token refresh failed: ${res.status} ${JSON.stringify({ error: data.error, description: data.error_description })}`);
  }
  oauth.access_token = data.access_token;
  oauth.expiry_date = Date.now() + (Number(data.expires_in || 3600) * 1000);
  if (data.refresh_token) oauth.refresh_token = data.refresh_token;
  if (oauth.persistPath) {
    const { persistPath, ...rest } = oauth;
    fs.writeFileSync(persistPath, JSON.stringify(rest, null, 2));
  }
  return oauth.access_token;
}

async function sendMail(raw, token) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gmail send failed: ${res.status} ${JSON.stringify({ error: data.error?.message || data.error || data })}`);
  }
  return data;
}

function loadOauth() {
  if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
    return {
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      access_token: process.env.GMAIL_ACCESS_TOKEN || '',
      expiry_date: 0,
      persistPath: '',
    };
  }
  if (fs.existsSync(OAUTH_PATH)) {
    return { ...JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8')), persistPath: OAUTH_PATH };
  }
  throw new Error('Missing Gmail OAuth: set GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN or place gmail-oauth.json');
}

const oauth = loadOauth();
const jobs = fs.existsSync(PIPELINE) ? loadJobs() : [];
const now = new Date();
const bodies = buildBodies(jobs, now);
const token = await getAccessToken(oauth);
const result = await sendMail(encodeMessage({ to: TO_EMAIL, ...bodies }), token);
console.log(JSON.stringify({
  to: TO_EMAIL,
  subject: bodies.subject,
  count: jobs.length,
  id: result.id,
}, null, 2));
