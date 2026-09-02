import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOME = 'https://hiringcafe.com/';
const STORE_PATH = 'remote-jobs-store.json';
const DIGEST_PATH = 'remote-jobs-latest.md';
const ACTIVATION_DATE_ET = '2026-09-02';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MIN_ANNUAL_FLOOR = 55_000;
const MAX_PAGES = 400;
const PAGE_CONCURRENCY = 4;
const UA = 'Mozilla/5.0 (compatible; career-ops personal job search; +https://github.com/Themandme/test)';

const STATE_CODES = new Set([
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware',
  'Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky',
  'Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi',
  'Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico',
  'New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania',
  'Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont',
  'Virginia','Washington','West Virginia','Wisconsin','Wyoming',
]);

const SENIOR_RE = /\b(?:senior|sr\.?|principal|director|head\s+of|vice\s+president|vp|chief|architect|executive|president|manager|supervisor|lead|staff\s+(?:engineer|developer|scientist)|iii|iv|v)\b/i;
const MEDICAL_RE = /\b(?:nurse|rn|lpn|cna|physician|surgeon|clinical|clinician|patient|therapist|therapy|pharmac|dental|dentist|radiolog|behavior(?:al)?\s+(?:technician|analyst|assistant)|bcba|medical)\b/i;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

function easternDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isNationwideUsRemote(v) {
  if (String(v?.workplace_type || '').toLowerCase() !== 'remote') return false;
  const countries = new Set(v.workplace_countries || []);
  if (!countries.has('US')) return false;

  const restricted = [...(v.workplace_states || []), ...(v.boundless_workplace_states || [])]
    .map(value => String(value).split(',')[0].trim()).filter(Boolean);
  const coveredStates = new Set(restricted.filter(value => STATE_CODES.has(value)));
  const boundlessCountries = new Set(v.boundless_workplace_countries || []);

  // HiringCafe marks a true nationwide posting as boundless within the US.
  // A listing that explicitly enumerates virtually every state is equivalent.
  if (boundlessCountries.has('US') && restricted.length === 0) return true;
  return coveredStates.size >= 50;
}

export function normalizeRemoteHit(hit, now = Date.now()) {
  if (!hit || hit.is_expired) return { reason: 'expired' };
  const v = hit.v5_processed_job_data || {};
  const title = String(hit.job_information?.title || v.core_job_title || '').trim();
  if (!title) return { reason: 'invalid' };
  if (!isNationwideUsRemote(v)) return { reason: 'stateRestricted' };
  if (SENIOR_RE.test(title) || /senior|executive/i.test(v.seniority_level || '')
      || (v.min_industry_and_role_yoe ?? 0) > 3 || (v.min_management_and_leadership_yoe ?? 0) > 0) {
    return { reason: 'senior' };
  }
  if (MEDICAL_RE.test(title)) return { reason: 'medical' };
  if (v.is_compensation_transparent !== true) return { reason: 'payUndisclosed' };
  const annualMin = Number(v.yearly_min_compensation);
  const annualMax = Number(v.yearly_max_compensation);
  if (!Number.isFinite(annualMin) || annualMin <= MIN_ANNUAL_FLOOR) return { reason: 'payBelowFloor' };

  const postedMs = Number(v.estimated_publish_date_millis) || Date.parse(v.estimated_publish_date || '');
  if (!Number.isFinite(postedMs) || postedMs > now + 5 * 60 * 1000 || now - postedMs >= MAX_AGE_MS) {
    return { reason: 'notUnder24Hours' };
  }

  const company = String(v.company_name || hit.attributed_org?.name || hit.enriched_company_data?.name || '').trim();
  const sourceId = String(hit.objectID || hit.id || hit.requisition_id || '').trim();
  const url = String(hit.apply_url || '').trim()
    || `https://hiringcafe.com/job/${slug(title)}-${slug(company)}-${slug(hit.requisition_id || sourceId)}`;
  return {
    reason: null,
    job: {
      title, url, company, sourceId: sourceId || url,
      location: 'Remote — United States', city: 'Remote', region: 'United States',
      nationwideRemote: true,
      datePosted: new Date(postedMs).toISOString(),
      days: Math.max(0, (now - postedMs) / 86400000),
      employmentType: Array.isArray(v.commitment) ? v.commitment.join(', ') : null,
      salary: { min: annualMin, max: Number.isFinite(annualMax) ? annualMax : annualMin, unit: 'YEAR' },
      seniority: v.seniority_level || null,
      minYearsExperience: Number.isFinite(Number(v.min_industry_and_role_yoe)) ? Number(v.min_industry_and_role_yoe) : null,
      requirementsSummary: v.requirements_summary || null,
    },
  };
}

function searchState() {
  return {
    defaultToUserLocation: false,
    locations: [{
      formatted_address: 'United States', types: ['country'],
      geometry: { location: { lat: 39.8283, lon: -98.5795 } }, id: 'us_remote',
      address_components: [{ long_name: 'United States', short_name: 'US', types: ['country'] }],
      workplace_types: ['Remote'],
      options: { flexible_regions: ['anywhere_in_continent', 'anywhere_in_world'] },
    }],
    dateFetchedPastNDays: 1,
    sortBy: 'date',
    restrictJobsToTransparentSalaries: true,
    seniorityLevel: ['No Prior Experience Required', 'Entry Level'],
    roleYoeRange: [0, 3],
    minCompensationLowEnd: MIN_ANNUAL_FLOOR,
    frequency: { label: 'Yearly', value: 'yearly' },
    calcFrequency: 'Yearly',
    currency: { label: 'USD', value: 'USD' },
  };
}

async function fetchJson(url, attempts = 4) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', 'x-nextjs-data': '1' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (caught) {
      error = caught;
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`HiringCafe remote request failed after ${attempts} attempts: ${url} (${error})`);
}

export function isHiringCafeAccessBlock(status, body = '') {
  return status === 403 && /(?:just a moment|security verification|cloudflare|malicious bots)/i.test(String(body));
}

function recordBlockedAttempt(error) {
  let prior = { run: 0, jobs: {} };
  try { prior = JSON.parse(readFileSync(STORE_PATH, 'utf8')); } catch {}
  writeFileSync(STORE_PATH, JSON.stringify({
    ...prior,
    lastAttemptAt: new Date().toISOString(),
    lastAttemptStatus: 'blocked-by-source-security',
    lastAttemptError: error.message,
  }, null, 2) + '\n');
}

async function getBuildId() {
  const response = await fetch(HOME, { headers: { 'user-agent': UA, accept: 'text/html' } });
  const html = await response.text();
  if (!response.ok) {
    const error = new Error(`HiringCafe homepage HTTP ${response.status}`);
    if (isHiringCafeAccessBlock(response.status, html)) error.code = 'HIRINGCAFE_ACCESS_BLOCK';
    throw error;
  }
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('HiringCafe homepage did not contain __NEXT_DATA__');
  const buildId = JSON.parse(match[1]).buildId;
  if (!buildId) throw new Error('HiringCafe __NEXT_DATA__ had no buildId');
  return buildId;
}

async function fetchPage(buildId, state, page) {
  const url = `${HOME}_next/data/${buildId}/index.json?searchState=${encodeURIComponent(JSON.stringify(state))}&page=${page}`;
  const props = (await fetchJson(url)).pageProps;
  if (!props || props.ssrError || !Array.isArray(props.ssrHits)) {
    throw new Error(`HiringCafe remote page ${page} invalid: ${props?.ssrError || 'missing hits'}`);
  }
  return props;
}

async function pooled(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index]);
    }
  }));
  return output;
}

function writeDigest(jobs, generatedAt, status) {
  const md = ['# Nationwide U.S. remote jobs', '',
    `_Updated ${generatedAt.slice(0,16).replace('T',' ')} UTC · ${jobs.length} openings_`, '',
    'Only nationwide U.S. remote roles with employer-disclosed salary floors above $55,000 and publication timestamps under 24 hours old. State-restricted remote listings are excluded.', '',
    `Status: ${status}`, '',
    '| Employer | Role | Salary | Posted |', '|---|---|---:|---|'];
  for (const job of jobs) {
    const esc = value => String(value || '').replace(/\|/g, '\\|');
    const pay = `$${Math.round(job.salary.min / 1000)}k–$${Math.round(job.salary.max / 1000)}k`;
    md.push(`| ${esc(job.company)} | [${esc(job.title)}](${job.url}) | ${pay} | ${job.datePosted.slice(0,16).replace('T',' ')} UTC |`);
  }
  writeFileSync(DIGEST_PATH, md.join('\n'));
}

export async function main({ force = process.argv.includes('--force') } = {}) {
  const generatedAt = new Date().toISOString();
  if (!force && easternDate() < ACTIVATION_DATE_ET) {
    console.log(`Nationwide remote scan activates ${ACTIVATION_DATE_ET} Eastern; no remote search performed.`);
    return;
  }

  const now = Date.now();
  const buildId = await getBuildId();
  const state = searchState();
  const first = await fetchPage(buildId, state, 0);
  const total = Number(first.ssrTotalCount);
  const pageSize = Number(first.ssrPageSize);
  if (!Number.isFinite(total) || !Number.isFinite(pageSize) || pageSize < 1) throw new Error('HiringCafe remote pagination metadata invalid');
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount > MAX_PAGES) throw new Error(`HiringCafe remote search requested ${pageCount} pages, above cap ${MAX_PAGES}`);
  console.log(`HiringCafe nationwide remote search: ${total} result groups across ${pageCount} pages`);
  const remaining = Array.from({ length: pageCount - 1 }, (_, index) => index + 1);
  const pages = [first, ...(await pooled(remaining, PAGE_CONCURRENCY, async page => {
    const props = await fetchPage(buildId, state, page);
    if (page % 25 === 0 || page === pageCount - 1) console.log(`Fetched remote page ${page + 1}/${pageCount}`);
    return props;
  }))];
  if (pages.length !== pageCount) throw new Error(`HiringCafe remote completeness failure: ${pages.length}/${pageCount}`);

  const hits = new Map();
  for (const page of pages) for (const hit of page.ssrHits) hits.set(hit.objectID || hit.id || JSON.stringify(hit), hit);
  const stats = { resultGroups: total, pagesExpected: pageCount, pagesFetched: pages.length, rawHits: hits.size,
    expired: 0, stateRestricted: 0, senior: 0, medical: 0, payUndisclosed: 0,
    payBelowFloor: 0, notUnder24Hours: 0, invalid: 0, duplicatesCollapsed: 0, kept: 0 };
  const bySource = new Map();
  for (const hit of hits.values()) {
    const result = normalizeRemoteHit(hit, now);
    if (result.reason) { stats[result.reason] = (stats[result.reason] || 0) + 1; continue; }
    bySource.set(result.job.sourceId, result.job);
  }
  const openings = new Map();
  for (const job of bySource.values()) {
    const key = `${job.company}\0${job.title}`.toLowerCase();
    const previous = openings.get(key);
    if (!previous || job.datePosted > previous.datePosted) openings.set(key, job);
  }
  stats.duplicatesCollapsed = bySource.size - openings.size;
  const jobs = [...openings.values()].sort((a, b) => b.datePosted.localeCompare(a.datePosted) || b.salary.min - a.salary.min);
  stats.kept = jobs.length;
  let prior = { run: 0 };
  try { prior = JSON.parse(readFileSync(STORE_PATH, 'utf8')); } catch {}
  const run = Number(prior.run || 0) + 1;
  const compact = Object.fromEntries(jobs.map(({ sourceId, requirementsSummary, ...job }) => [sourceId, { ...job, lastSeenRun: run }]));
  writeFileSync(STORE_PATH, JSON.stringify({ note: 'Nationwide U.S. remote; salary floor >$55k; under 24 hours old; no state-restricted roles.', activationDateEastern: ACTIVATION_DATE_ET, updatedAt: generatedAt, run, complete: true, stats, jobs: compact }, null, 2) + '\n');
  writeDigest(jobs, generatedAt, `${pages.length}/${pageCount} pages fetched successfully`);
  console.log(JSON.stringify(stats, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    if (error.code === 'HIRINGCAFE_ACCESS_BLOCK') {
      recordBlockedAttempt(error);
      console.warn(`${error.message}; preserved the last verified remote dataset and recorded this blocked attempt.`);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}
