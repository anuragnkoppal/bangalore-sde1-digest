#!/usr/bin/env node
/**
 * Scan currently-hiring Y Combinator companies (plus South Asia HQ and
 * Work at a Startup Bangalore hits) on Greenhouse, Lever, and Ashby.
 *
 * Unlike `scan-ats-full --seeds yc`, this uses YC's public hiring directory
 * instead of guessing Greenhouse slugs for a shuffled slice of the whole
 * portfolio, and it tries Lever/Ashby when Greenhouse is a 404.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { makeHttpCtx } from '../providers/_http.mjs';
import greenhouse from '../providers/greenhouse.mjs';
import lever from '../providers/lever.mjs';
import ashby from '../providers/ashby.mjs';
import {
  buildTitleFilter,
  buildTitleFilterOverrides,
  buildTitleFilterWithOverrides,
  buildLocationFilter,
  buildContentFilter,
  loadSeenUrls,
  normalizeUrlForDedup,
  appendToPipeline,
  loadBlacklist,
  PORTALS_PATH,
  PIPELINE_PATH,
} from '../scan.mjs';
import {
  classifyPostingDate,
  passesFilters,
  parallelEach,
  withTimeout,
} from '../scan-ats-full.mjs';
import { normalizeCompany } from '../tracker-utils.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const SINCE_DAYS = 7;
const CONCURRENCY = 6;
const COMPANY_TIMEOUT_MS = 25_000;
const ATS = [
  { provider: greenhouse, url: (slug) => `https://job-boards.greenhouse.io/${slug}` },
  { provider: lever, url: (slug) => `https://jobs.lever.co/${slug}` },
  { provider: ashby, url: (slug) => `https://jobs.ashbyhq.com/${slug}` },
];
const WAAS_QUERIES = [
  'Bengaluru software engineer',
  'Bangalore software engineer',
  'Bengaluru backend',
  'Bangalore Java',
];

function ycLabel(batch) {
  const raw = String(batch || '').trim();
  if (!raw) return 'YC';
  const m = raw.match(/^(Winter|Summer|Fall|Spring)\s+(20)?(\d{2})$/i);
  if (!m) return `YC ${raw}`;
  const season = { winter: 'W', summer: 'S', fall: 'F', spring: 'P' }[m[1].toLowerCase()];
  return season ? `YC ${season}${m[3]}` : `YC ${raw}`;
}

async function fetchJson(url, { headers = {}, method = 'GET', body = null } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'user-agent': 'career-ops-yc-hiring',
      accept: 'application/json',
      ...headers,
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function fetchAlgoliaKey() {
  const res = await fetch('https://www.ycombinator.com/companies', {
    headers: { 'user-agent': 'Mozilla/5.0 career-ops-yc-hiring' },
  });
  if (!res.ok) throw new Error(`YC directory HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/window\.AlgoliaOpts = (\{.*?\});/);
  if (!m) throw new Error('YC AlgoliaOpts not found on companies page');
  const opts = JSON.parse(m[1]);
  if (!opts.app || !opts.key) throw new Error('YC AlgoliaOpts missing app/key');
  return opts;
}

async function algoliaHits(opts, filters) {
  const hits = [];
  for (let page = 0; page < 40; page++) {
    const payload = {
      query: '',
      hitsPerPage: 100,
      page,
      filters,
      attributesToRetrieve: ['name', 'slug', 'batch', 'all_locations', 'isHiring', 'regions'],
    };
    const url = `https://${String(opts.app).toLowerCase()}-dsn.algolia.net/1/indexes/YCCompany_production/query`;
    const data = await fetchJson(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-algolia-application-id': opts.app,
        'x-algolia-api-key': opts.key,
      },
      body: JSON.stringify(payload),
    });
    const batch = Array.isArray(data.hits) ? data.hits : [];
    hits.push(...batch);
    if (batch.length === 0) break;
    if (page + 1 >= Number(data.nbPages || 0)) break;
  }
  return hits;
}

function addCompany(bySlug, hit, reason) {
  const slug = typeof hit.slug === 'string' ? hit.slug.trim() : '';
  if (!slug || !SLUG_RE.test(slug)) return;
  const name = typeof hit.name === 'string' && hit.name.trim() ? hit.name.trim() : slug;
  const prev = bySlug.get(slug);
  if (prev) {
    prev.reasons.add(reason);
    return;
  }
  bySlug.set(slug, {
    slug,
    name,
    batch: hit.batch || '',
    locations: hit.all_locations || '',
    reasons: new Set([reason]),
  });
}

async function loadYcCompanies() {
  const bySlug = new Map();
  const opts = await fetchAlgoliaKey();
  const hiring = await algoliaHits(opts, 'isHiring:true');
  for (const hit of hiring) addCompany(bySlug, hit, 'hiring');
  const southAsia = await algoliaHits(opts, 'regions:"South Asia"');
  for (const hit of southAsia) addCompany(bySlug, hit, 'south-asia');
  return { bySlug, hiringCount: hiring.length, southAsiaCount: southAsia.length };
}

async function loadWaasSlugs(bySlug) {
  let jobs = 0;
  for (const q of WAAS_QUERIES) {
    const data = await fetchJson(`https://www.workatastartup.com/jobs/search?q=${encodeURIComponent(q)}`);
    for (const job of data.jobs || []) {
      jobs += 1;
      addCompany(bySlug, {
        name: job.companyName,
        slug: job.companySlug,
        batch: job.companyBatch,
        all_locations: job.location,
      }, 'waas');
    }
  }
  return jobs;
}

async function probeCompany(company, ctx) {
  for (const ats of ATS) {
    const entry = { name: `${company.name} (${ycLabel(company.batch)})`, careers_url: ats.url(company.slug) };
    if (!ats.provider.detect?.(entry)) continue;
    try {
      const jobs = await ats.provider.fetch(entry, ctx);
      if (Array.isArray(jobs) && jobs.length > 0) return jobs;
      if (Array.isArray(jobs)) return []; // live empty board — stop hopping ATS
    } catch {
      // 404 / dead board — try the next ATS for this slug
    }
  }
  return [];
}

async function main() {
  if (!existsSync(PORTALS_PATH)) {
    console.error('portals.yml not found');
    process.exit(1);
  }
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const titleFilterConfig = config?.title_filter;
  const titleFilter = buildTitleFilterWithOverrides(
    titleFilterConfig,
    buildTitleFilterOverrides(config?.title_filter_overrides),
  );
  const locationFilter = buildLocationFilter(config?.location_filter);
  const contentFilter = buildContentFilter(config?.content_filter);
  const cutoff = Date.now() - SINCE_DAYS * 86_400_000;
  const { seen: seenUrls } = loadSeenUrls();
  const blacklist = loadBlacklist();

  console.log('YC hiring scan — fetching Y Combinator directory…');
  const { bySlug, hiringCount, southAsiaCount } = await loadYcCompanies();
  const waasJobs = await loadWaasSlugs(bySlug);
  const companies = [...bySlug.values()];
  console.log(`  hiring=${hiringCount} southAsia=${southAsiaCount} waasJobs=${waasJobs} uniqueCompanies=${companies.length}`);

  const ctx = makeHttpCtx();
  const offers = [];
  let probed = 0;
  let boards = 0;
  let errors = 0;

  await parallelEach(companies, CONCURRENCY, async (company) => {
    let jobs = [];
    try {
      jobs = await withTimeout(probeCompany(company, ctx), COMPANY_TIMEOUT_MS, company.slug);
    } catch {
      errors += 1;
      probed += 1;
      return;
    }
    probed += 1;
    if (jobs.length) boards += 1;
    if (probed % 100 === 0) {
      console.log(`  … ${probed}/${companies.length} companies (${offers.length} matches so far)`);
    }
    for (const job of jobs) {
      if (!job.url || !job.title) continue;
      const dateClass = classifyPostingDate(job, cutoff);
      if (dateClass !== 'keep') continue;
      if (!passesFilters(job, {
        titleFilter,
        locationFilter,
        contentFilter,
        titleFilterConfig,
        companySlug: company.slug,
      })) continue;
      if (blacklist.get(normalizeCompany(job.company || ''))) continue;
      const token = normalizeUrlForDedup(job.url);
      if (seenUrls.has(token)) continue;
      seenUrls.add(token);
      offers.push({
        ...job,
        source: 'yc-hiring',
        note: ycLabel(company.batch),
      });
    }
  });

  offers.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
  console.log(`YC hiring scan done — probed ${probed}, live boards ${boards}, errors ${errors}, matches ${offers.length}`);
  for (const o of offers.slice(0, 25)) {
    const posted = o.postedAt ? new Date(o.postedAt).toISOString().slice(0, 10) : 'n/a';
    console.log(`  + ${posted} | ${o.company} | ${o.title} | ${o.location || ''}`);
    console.log(`    ${o.url}`);
  }
  if (offers.length > 25) console.log(`  … ${offers.length - 25} more`);

  if (offers.length) {
    if (!existsSync(PIPELINE_PATH)) {
      mkdirSync(path.dirname(PIPELINE_PATH), { recursive: true });
      writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pending\n\n## Processed\n', 'utf-8');
    }
    await appendToPipeline(offers);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
