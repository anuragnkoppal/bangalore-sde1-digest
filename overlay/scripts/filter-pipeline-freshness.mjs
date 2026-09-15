#!/usr/bin/env node
/**
 * Keep only last-7-day pending roles, 1-3 YOE by title/JD year keywords,
 * last 24 hours first. Does not submit applications.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.CAREER_OPS_ROOT || '/Users/Anurag/Desktop/career-ops';
const PIPELINE = path.join(ROOT, 'data/pipeline.md');
const NOW = new Date();
const TODAY = toIsoDate(NOW);
const YESTERDAY = toIsoDate(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
const WEEK_AGO = toIsoDate(new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000));

function toIsoDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function parseLine(line) {
  const m = line.match(/^- \[ \] (\S+)(?: \| (.*))?$/);
  if (!m) return null;
  const url = m[1];
  const rest = m[2] || '';
  const posted = (rest.match(/posted:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const parts = rest.split(' | ').map(s => s.trim());
  const company = parts[0] || '';
  const title = parts[1] || '';
  return { line, url, company, title, posted, rest };
}

const YEAR = '(?:years?|yrs|year\\(s\\))';

function decodeHtml(s) {
  return String(s)
    .replace(/&plus;/gi, '+')
    .replace(/&#x2b;/gi, '+')
    .replace(/&#43;/g, '+')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function mentionsJava(text) {
  if (!text) return false;
  const t = decodeHtml(text).toLowerCase();
  if (t.includes('spring boot') || t.includes('springboot') || t.includes('spring framework')) return true;
  const re = /(?<![\p{L}\p{M}\p{N}_])java(?![\p{L}\p{M}\p{N}_])/gu;
  let m;
  while ((m = re.exec(t))) {
    const window = t.slice(Math.max(0, m.index - 90), m.index + 120);
    if (!/\b(plus|preferred|nice to have|bonus|optional)\b/.test(window)) return true;
  }
  return false;
}

function tooSenior(text) {
  if (!text) return false;
  const t = decodeHtml(text).toLowerCase().replace(/[–—]/g, '-').replace(/&ndash;|&mdash;/g, '-');
  if (/\bsde\s*[-]?\s*(?:2|3|ii|iii)\b/.test(t)) return true;
  if (/\bengineer\s*[-]\s*[23]\b/.test(t)) return true;
  if (/\bengineer-[23]\b/.test(t)) return true;
  if (/\b(?:lmts|smts|pmts)\b/.test(t)) return true;
  if (/\btechnical leader\b/.test(t)) return true;
  if (/\bsenior\b/.test(t) || /\bsr\.\b/.test(t)) return true;

  for (const m of t.matchAll(new RegExp(`(\\d+)\\s*(?:to|-)\\s*(\\d+)\\s*\\+?\\s*${YEAR}`, 'g'))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 4) return true;
    if (a >= 3 && b >= 4) return true;
  }
  for (const m of t.matchAll(new RegExp(`(\\d+)\\s*\\+\\s*${YEAR}`, 'g'))) {
    if (Number(m[1]) >= 4) return true;
  }
  for (const m of t.matchAll(new RegExp(`(?:at least|minimum(?: of)?|min\\.? )\\s*(\\d+)\\s*${YEAR}`, 'g'))) {
    if (Number(m[1]) >= 4) return true;
  }
  return false;
}

async function fetchSnippet(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const gh = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/) || url.match(/[?&]gh_jid=(\d+)/);
    if (gh && url.includes('greenhouse')) {
      const board = (url.match(/greenhouse\.io\/([^/]+)/) || [])[1];
      const id = gh[2] || gh[1];
      if (board && id) {
        const api = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`;
        const res = await fetch(api, { signal: ctrl.signal, headers: { 'user-agent': 'career-ops-filter' } });
        if (res.ok) {
          const json = await res.json();
          return `${json.title || ''} ${json.content || ''}`.replace(/<[^>]+>/g, ' ');
        }
      }
    }
    const wd = url.match(/https:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/([^/]+)\/job\/(.+)/i);
    if (wd) {
      const [, tenant, wdHost, site, jobPath] = wd;
      const api = `https://${tenant}.${wdHost}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${jobPath}`;
      const res = await fetch(api, { signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 career-ops-filter' } });
      if (res.ok) {
        const json = await res.json();
        const info = json.jobPostingInfo || {};
        return `${info.title || ''} ${info.jobDescription || ''}`.replace(/<[^>]+>/g, ' ');
      }
    }
    const ashby = url.match(/ashbyhq\.com\/([^/]+)\/([0-9a-f-]{20,})/i);
    if (ashby) {
      const api = `https://api.ashbyhq.com/posting-api/job-board/${ashby[1]}`;
      const res = await fetch(api, { signal: ctrl.signal, headers: { 'user-agent': 'career-ops-filter' } });
      if (res.ok) {
        const json = await res.json();
        const job = (json.jobs || []).find(j => String(j.id) === ashby[2] || String(j.jobUrl || '').includes(ashby[2]));
        if (job) return `${job.title || ''} ${job.descriptionHtml || job.descriptionPlain || ''}`.replace(/<[^>]+>/g, ' ');
      }
    }
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 career-ops-filter' } });
    if (!res.ok) return '';
    const html = await res.text();
    return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').slice(0, 20000);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

const text = fs.readFileSync(PIPELINE, 'utf8');
const pendingStart = text.indexOf('## Pending');
const processedStart = text.search(/^## Processed/m);
if (pendingStart === -1 || processedStart === -1) {
  console.error('pipeline.md missing Pending/Processed sections');
  process.exit(1);
}

const pendingBlock = text.slice(pendingStart, processedStart);
const processedBlock = text.slice(processedStart);
const jobs = pendingBlock.split('\n').map(parseLine).filter(Boolean);

const dated = [];
const dropped = [];
for (const job of jobs) {
  if (!job.posted || job.posted < WEEK_AGO) {
    dropped.push({ job, reason: job.posted ? `older than 7d (${job.posted})` : 'no posted date' });
    continue;
  }
  if (tooSenior(`${job.title} ${job.company}`)) {
    dropped.push({ job, reason: 'title looks >3 YOE' });
    continue;
  }
  dated.push(job);
}

for (const job of dated) {
  const snippet = await fetchSnippet(job.url);
  const haystack = `${job.title} ${snippet || ''}`;
  if (snippet && tooSenior(snippet)) {
    job._drop = 'JD years look >3 YOE';
    continue;
  }
  if (!mentionsJava(haystack)) {
    job._drop = snippet ? 'no Java/Spring in title or JD' : 'no Java in title and JD fetch empty';
  }
}

const kept = dated.filter(j => !j._drop);
for (const job of dated.filter(j => j._drop)) dropped.push({ job, reason: job._drop });

kept.sort((a, b) => {
  const aHot = a.posted >= YESTERDAY ? 0 : 1;
  const bHot = b.posted >= YESTERDAY ? 0 : 1;
  if (aHot !== bHot) return aHot - bHot;
  return b.posted.localeCompare(a.posted);
});

const hot = kept.filter(j => j.posted >= YESTERDAY);
const week = kept.filter(j => j.posted < YESTERDAY);

const pendingOut = [
  '## Pending',
  '',
  ...hot.map(j => j.line),
  ...(hot.length && week.length ? [''] : []),
  ...week.map(j => j.line),
  '',
  '',
].join('\n');

const header = text.slice(0, pendingStart);
fs.writeFileSync(PIPELINE, header + pendingOut + processedBlock);

console.log(JSON.stringify({
  today: TODAY,
  weekAgo: WEEK_AGO,
  last24h: hot.length,
  restOfWeek: week.length,
  kept: kept.length,
  dropped: dropped.length,
  keptTitles: kept.map(j => `${j.posted} | ${j.company} | ${j.title}`),
  droppedTitles: dropped.map(d => `${d.reason} | ${d.job.company} | ${d.job.title}`),
}, null, 2));
