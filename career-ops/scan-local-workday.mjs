// Title-blind, location-first pull across the Baltimore/DC Workday tenants.
//
// Why this exists: scan-ats-full.mjs filters on portals.yml title_filter.positive,
// which is built from the user's own target titles — so it can only ever return
// titles he already named. Against T. Rowe Price's tenant it returned ZERO while
// the tenant actually carries 83 Maryland postings. This asks the opposite
// question: what is open near Baltimore, whatever it happens to be called?
//
// No title filter. Location and freshness only.
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Targeting lives in portals.yml (User Layer). This file is System Layer and
// gets overwritten by `update-system.mjs apply`, so the tenant list and the
// location rules must not live here. The constants below are only a fallback
// for an install that has not configured `local_workday` yet.
const PORTALS = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');
const cfg = (() => {
  try {
    if (!existsSync(PORTALS)) return {};
    return yaml.load(readFileSync(PORTALS, 'utf8'))?.local_workday || {};
  } catch { return {}; }
})();

const TENANTS_FALLBACK = [
  ['T. Rowe Price', 'troweprice', 'wd5', 'troweprice'],
  ['M&T Bank', 'mtb', 'wd5', 'mtb'],
  ['M&T Bank (campus)', 'mtb', 'wd5', 'campus'],
  // Additional official boards discovered from the last successful local
  // HiringCafe snapshot. The snapshot is only a seed: refreshes below go
  // straight to each employer's current Workday API.
  ['Advance Auto Parts', 'advanceauto', 'wd5', 'advanceexternalcareers'],
  ['American Pest', 'anticimexinc', 'wd1', 'american_pest_management_external_careers'],
  ["BJ's Wholesale Club", 'bjswholesaleclub', 'wd1', 'bjscareers'],
  ['Caliber Collision', 'calibercollision', 'wd1', 'caliber'],
  ['Campbell Soup Company', 'campbellsoup', 'wd5', 'externalcareers_globalsite'],
  ["Carter's", 'carters', 'wd1', 'carterscareers'],
  ['Comcast', 'comcast', 'wd115', 'comcast_careers'],
  ['Dollar Tree', 'dollartree', 'wd5', 'dollartreeus'],
  ['EisnerAmper (early careers)', 'eisneramper', 'wd1', 'eisneramperearlycareers'],
  ['EisnerAmper', 'eisneramper', 'wd1', 'eisneramper_external'],
  ['Element Fleet Management', 'elementfleet', 'wd3', 'external_career_site'],
  ['KinderCare', 'kindercare', 'wd5', 'externalcareersite'],
  ["Lowe's", 'lowes', 'wd5', 'lws_external_cs'],
  ['Medifast', 'medifastinc', 'wd108', 'medifast'],
  ['Michaels', 'michaels', 'wd5', 'external'],
  ['MileOne', 'mileone', 'wd1', 'external'],
  ['SBM Management', 'sbmmanagement', 'wd108', 'sbm'],
  ['Sunrise Senior Living', 'sunriseseniorliving', 'wd12', 'sunrise_ext_careers'],
  ['Terminix', 'terminix', 'wd1', 'terminix'],
  ['T-Mobile', 'tmobile', 'wd1', 'external'],
  ['TJX / Marshalls', 'tjx', 'wd1', 'tjx_external'],
  ['U-Haul', 'uhaul', 'wd1', 'uhauljobs'],
  ['Wells Fargo', 'wf', 'wd1', 'wellsfargojobs'],
  ['GBMC HealthCare', 'gbmc', 'wd1', 'gbmc'],
  ['Gilchrist / GBMC', 'gbmc', 'wd1', 'gilchristinova'],
  ['Brown Advisory', 'brownadvisory', 'wd1', 'brown'],
  // Probed 2026-08-06 across 8 instances x 14 site paths: no working CXS
  // endpoint. The tenant names are real but the sites 422, so these two are
  // either off Workday now or behind a path the public API does not expose.
  // Left in place, and deliberately noisy, because both are significant
  // Baltimore employers — a silently-absent employer looks identical to one
  // that simply is not hiring.
  ['Whiting-Turner', 'whiting', 'wd1', 'external'],
  ['Erickson Senior Living', 'erickson', 'wd5', 'external'],
  // wd1 returns 422; wd503 is the live instance (both are in the public
  // dataset, and only the second one works).
  ['Catalyte', 'catalyte', 'wd503', 'catalyte'],
  ['Goucher College', 'goucher', 'wd1', 'goucher_careers'],
  ['Loyola University MD', 'loyola', 'wd5', 'external'],
  ['University of Maryland', 'umd', 'wd1', 'umcp'],
  ['Mercy', 'mercy', 'wd1', 'mercycareers'],
  ['Novavax', 'novavax', 'wd1', 'careers'],
  ['GEICO', 'geico', 'wd1', 'external'],
  ['CACI', 'caci', 'wd1', 'external'],
  ['GDIT', 'gdit', 'wd5', 'external_career_site'],
  ['GDIT (early talent)', 'gdit', 'wd5', 'gdit_earlytalent'],
  ['ManTech', 'mantech', 'wd1', 'external'],
  ['MITRE', 'mitre', 'wd5', 'mitre'],
  ['Guidehouse', 'guidehouse', 'wd1', 'external'],
  ['ICF', 'icf', 'wd5', 'icfexternal_career_site'],
  ['Leidos', 'leidos', 'wd5', 'external'],
  ['Truist', 'truist', 'wd1', 'careers'],
  ['PNC', 'pnc', 'wd5', 'external'],
  ['Wegmans', 'wegmans', 'wd1', 'wegmans'],
  ['Wawa', 'wawa', 'wd1', 'careers'],
  ['Washington Gas (AltaGas)', 'wgl', 'wd5', 'altagas'],
  // Official City of Baltimore external applicant board.
  ['City of Baltimore', 'baltimorecity', 'wd1', 'External'],
];

const TENANTS = Array.isArray(cfg.tenants) && cfg.tenants.length
  ? cfg.tenants.map((t) => [t.name, t.tenant, t.instance, t.site])
  : TENANTS_FALLBACK;

// Maryland / DC / near-in Virginia. Anchored to state tokens, never bare city
// names — the same collision that let "Columbia" match South Carolina.
// Both rules come from portals.yml `local_workday`; these are the fallback.
const DEFAULT_INCLUDE = String.raw`(,\s*MD\b)|Maryland|Baltimore|Owings Mills|Towson|Columbia,\s*MD|Annapolis|Hunt Valley|Linthicum|Sparks|Hanover,\s*MD|Bethesda|Rockville|Silver Spring|Gaithersburg|Fort Meade|Laurel,\s*MD|Washington,?\s*D\.?C\.?|District of Columbia|,\s*VA\b|Virginia`;
const DEFAULT_EXCLUDE = String.raw`Richmond|Norfolk|Virginia Beach|Roanoke|Blacksburg|Charlottesville|Lynchburg|Newport News|Chesapeake|Hampton`;
const LOCAL = new RegExp(cfg.include || DEFAULT_INCLUDE, 'i');
// Virginia is broad; drop the far-southwest metros that are not commutable.
const FAR_VA = new RegExp(cfg.exclude || DEFAULT_EXCLUDE, 'i');

function daysAgo(postedOn) {
  if (!postedOn) return null;
  const s = String(postedOn);
  if (/today/i.test(s)) return 0;
  if (/yesterday/i.test(s)) return 1;
  const m = s.match(/(\d+)\+?\s*days?/i);
  return m ? Number(m[1]) : null;
}

async function page(tenant, inst, site, offset) {
  const url = `https://${tenant}.${inst}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
    });
    if (!r.ok) return { err: r.status };
    return await r.json();
  } catch (e) {
    return { err: e.name === 'AbortError' ? 'timeout' : 'neterr' };
  } finally { clearTimeout(t); }
}

const MAX_PAGES = Number(cfg.max_pages_per_tenant) > 0 ? Number(cfg.max_pages_per_tenant) : 60;
const STORE_PATH = path.join(ROOT, 'local-workday-store.json');
// Preserve unseen records through a short outage, but never indefinitely. At the
// normal twice-daily cadence, six consecutive degraded runs is about three days.
const configuredRetention = Number(cfg.max_failed_refresh_retention_runs);
const MAX_FAILED_REFRESH_RETENTION_RUNS = Number.isFinite(configuredRetention) && configuredRetention > 0
  ? Math.floor(configuredRetention) : 6;

function readPreviousStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

const previous = readPreviousStore();
const previousBySource = new Map();
for (const job of previous) {
  if (!job?.company) continue;
  const group = previousBySource.get(job.company) || [];
  group.push(job);
  previousBySource.set(job.company, group);
}

const results = [];
const summary = [];
const sourceHealth = [];

function withoutRefreshMetadata(job) {
  const { sourceRefreshStatus, sourceFailureRuns, sourceFailure, ...clean } = job;
  return clean;
}

function mergeSource(name, currentJobs, status, reason = '') {
  if (status === 'success') {
    results.push(...currentJobs.map(withoutRefreshMetadata));
    sourceHealth.push({ name, status, current: currentJobs.length, retained: 0, dropped: 0 });
    return { current: currentJobs.length, retained: 0, dropped: 0 };
  }

  const seen = new Set(currentJobs.map((job) => job.url).filter(Boolean));
  results.push(...currentJobs.map((job) => ({
    ...withoutRefreshMetadata(job),
    sourceRefreshStatus: 'partial-current',
    sourceFailureRuns: 0,
    sourceFailure: reason,
  })));

  let retained = 0, dropped = 0;
  for (const old of previousBySource.get(name) || []) {
    if (old.url && seen.has(old.url)) continue;
    const failedRuns = (Number(old.sourceFailureRuns) || 0) + 1;
    if (failedRuns > MAX_FAILED_REFRESH_RETENTION_RUNS) {
      dropped++;
      continue;
    }
    results.push({
      ...withoutRefreshMetadata(old),
      sourceRefreshStatus: 'retained-source-error',
      sourceFailureRuns: failedRuns,
      sourceFailure: reason,
    });
    retained++;
  }

  sourceHealth.push({ name, status, current: currentJobs.length, retained, dropped, reason });
  return { current: currentJobs.length, retained, dropped };
}

for (const [name, tenant, inst, site] of TENANTS) {
  const first = await page(tenant, inst, site, 0);
  if (first.err) {
    const reason = `initial request: ${first.err}`;
    const merged = mergeSource(name, [], 'failed', reason);
    const line = `${name.padEnd(26)} FAILED ${reason}; retained ${merged.retained}, expired ${merged.dropped}`;
    summary.push(line);
    console.error(line);
    continue;
  }

  const total = first.total ?? 0;
  let local = 0, scanned = 0, pageError = null;
  const requestedPages = Math.ceil(total / 20);
  const pages = Math.min(requestedPages, MAX_PAGES);
  const truncated = requestedPages > MAX_PAGES;
  const tenantJobs = [];

  for (let p = 0; p < pages; p++) {
    const j = p === 0 ? first : await page(tenant, inst, site, p * 20);
    if (j.err) {
      pageError = `page ${p + 1}/${requestedPages}: ${j.err}`;
      break;
    }
    for (const it of j.jobPostings || []) {
      scanned++;
      const loc = it.locationsText || '';
      if (!LOCAL.test(loc)) continue;
      if (FAR_VA.test(loc) && !/,\s*MD\b|Maryland|Baltimore|D\.?C\.?/i.test(loc)) continue;
      local++;
      tenantJobs.push({
        company: name, title: it.title, location: loc,
        days: daysAgo(it.postedOn), postedOn: it.postedOn,
        url: `https://${tenant}.${inst}.myworkdayjobs.com/${site}${it.externalPath}`,
      });
    }
  }

  const status = pageError ? 'partial' : truncated ? 'truncated' : 'success';
  const reason = pageError || (truncated ? `page cap ${MAX_PAGES}/${requestedPages}` : '');
  const merged = mergeSource(name, tenantJobs, status, reason);
  const health = status === 'success' ? 'OK' : status.toUpperCase();
  const retention = status === 'success'
    ? ''
    : `; retained ${merged.retained}, expired ${merged.dropped}`;
  const line = `${name.padEnd(26)} ${String(total).padStart(5)} total  ${String(local).padStart(4)} local  ${health}${reason ? ` (${reason})` : ''}${retention}`;
  summary.push(line);
  console.error(line);
}

// Official university boards that are not Workday tenants. These parsers use
// stable job-detail URL patterns and degrade visibly if a board changes shape.
const decode = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function scrapeBoard({ name, url, base, hrefPattern, location }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const found = new Map();
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = m[1];
      if (!hrefPattern.test(href)) continue;
      const title = decode(m[2]);
      if (!title || /view details|bookmark|more jobs|apply/i.test(title)) continue;
      const absolute = new URL(href, base).href;
      found.set(absolute, {
        company: name, title, location, days: null, postedOn: null,
        url: absolute, source: 'official university board',
      });
    }
    if (found.size === 0) throw new Error('parser returned 0 jobs');
    const merged = mergeSource(name, [...found.values()], 'success');
    summary.push(`${name.padEnd(26)} ${String(merged.current).padStart(5)} official-board jobs  OK`);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    const merged = mergeSource(name, [], 'failed', reason);
    summary.push(`${name.padEnd(26)} BOARD FAILED ${reason}; retained ${merged.retained}, expired ${merged.dropped}`);
  } finally { clearTimeout(timer); }
}

await scrapeBoard({
  name: 'UMBC',
  url: 'https://listings.umbc.edu/cw/en-us/listing/',
  base: 'https://listings.umbc.edu',
  hrefPattern: /\/cw\/en-us\/job\/\d+/i,
  location: 'UMBC Campus, MD',
});
await scrapeBoard({
  name: 'Stevenson University',
  url: 'https://stevenson.peopleadmin.com/postings/search?480%5B%5D=1&508=&commit=Search&query=&query_v0_posted_at_date=',
  base: 'https://stevenson.peopleadmin.com',
  hrefPattern: /\/postings\/\d+/i,
  location: 'Owings Mills / Stevenson, MD',
});
await scrapeBoard({
  name: 'Johns Hopkins University',
  url: 'https://jobs.jhu.edu/search/?createNewAlert=false&q=&locationsearch=Baltimore%2C+MD',
  base: 'https://jobs.jhu.edu',
  hrefPattern: /\/job\/[^"']+/i,
  location: 'Baltimore, MD',
});
// Towson's official Taleo board requires a session-backed search request and
// returns an empty shell to a stateless fetch. Keep the direct board monitored
// in the summary; HiringCafe remains the discovery fallback until a stable
// public endpoint is available.
summary.push('Towson University          MONITORED: Taleo public search shell has no stateless result feed');

results.sort((a, b) => (a.days ?? 999) - (b.days ?? 999));
// Root, not data/: data/* is gitignored, and the scheduled workflow has to be
// able to commit this so results survive between runs the way the Owings Mills
// store does. Same class of content as owings-mills-store.json — public job
// postings, no personal data.
writeFileSync(STORE_PATH, JSON.stringify(results, null, 2));

console.log('\n' + summary.join('\n'));
const degraded = sourceHealth.filter((source) => source.status !== 'success');
if (degraded.length) {
  console.error(`\nDEGRADED REFRESH: ${degraded.length} source(s) incomplete. Previous unseen records are retained for at most ${MAX_FAILED_REFRESH_RETENTION_RUNS} consecutive failed runs.`);
  for (const source of degraded)
    console.error(`  - ${source.name}: ${source.status}${source.reason ? ` (${source.reason})` : ''}; current ${source.current}, retained ${source.retained}, expired ${source.dropped}`);
}
console.log(`\n${results.length} local postings across ${TENANTS.length} tenants\n`);
const fresh = results.filter(r => r.days !== null && r.days <= 21);
console.log(`--- posted within 21 days (${fresh.length}) ---`);
for (const r of fresh)
  console.log(`${String(r.days).padStart(3)}d  ${r.company.slice(0, 22).padEnd(22)} ${r.title.slice(0, 52).padEnd(52)} ${r.location.slice(0, 24)}`);
