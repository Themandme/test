#!/usr/bin/env node

/**
 * scan-neogov.mjs — county/city government openings via NEOGOV (governmentjobs.com).
 *
 * Baltimore County was the last local government channel this search could not
 * reach. Its careers page is a knockout.js SPA: 193 KB of HTML with zero job
 * links, no JSON-LD, and nothing an HTML parser can hold on to. The data comes
 * from an XHR the page fires after load:
 *
 *   GET /careers/home/loadJobsOnMaps?agency={slug}   (X-Requested-With required)
 *
 * Without the `X-Requested-With: XMLHttpRequest` header the same URL returns the
 * SPA shell instead of JSON — that header is the whole trick, and it is why
 * earlier probes kept coming back as HTML.
 *
 * The payload is the best-quality feed in this entire search:
 *
 *   - **A posting date on every row** (`PostingDate`, MM/DD/YY), not "30+ days".
 *   - **A salary on every row** (`SalaryInfo`), annual or hourly, stated by the
 *     employer rather than inferred.
 *   - **A real closing date** on roughly half (`ClosingDate`); the rest are
 *     "Continuous", which is an open posting, not a missing field.
 *   - **Latitude/longitude per posting**, so proximity is measured rather than
 *     guessed from city-name matching — the failure mode that once let a
 *     Wenatchee, WA job through on the string "Columbia".
 *
 * Location-first and title-blind, like the other sweeps: every opening the
 * agency has is pulled, then filtered by distance from home.
 *
 * Usage:
 *   node scan-neogov.mjs              # → neogov-store.json
 *   node scan-neogov.mjs --pipeline   # also append new rows to the pipeline
 *   node scan-neogov.mjs --all        # keep every row, skip the distance filter
 *   node scan-neogov.mjs --unified-only # rebuild unified outputs; no network/store mutation
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.join(ROOT, 'neogov-store.json');
const BASE = 'https://www.governmentjobs.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  // Load-bearing: without it the endpoint serves the SPA shell, not JSON.
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
};

// Agencies verified live against the endpoint. Slugs are unforgiving — the
// obvious guesses (`baltimorecountymd`, `aacounty`, `howardcountymd`) all serve
// HTML; only these return JSON.
//
// Kept in-script as a fallback because `portals.yml` is gitignored, so the
// scheduled GitHub run has no config file to read.
const DEFAULT_AGENCIES = [
  { slug: 'baltimorecounty', name: 'Baltimore County Government' },
  { slug: 'ccbcmd', name: 'Community College of Baltimore County' },
  { slug: 'howardcounty', name: 'Howard County Government' },
  { slug: 'annearundel', name: 'Anne Arundel County Government' },
  { slug: 'montgomerycountymd', name: 'Montgomery County Government' },
  { slug: 'mncppc', name: 'M-NCPPC' },
  { slug: 'frederickmd', name: 'Frederick County Government' },
  { slug: 'dc', name: 'District of Columbia Government' },
];

// Owings Mills, MD 21117.
const DEFAULT_HOME = { lat: 39.4196, lon: -76.7802 };
const DEFAULT_RADIUS_MILES = 45;
// At the scheduled twice-daily cadence this tolerates about three days of an
// agency outage without allowing stale continuous postings to persist forever.
const MAX_RETAINED_FAILURE_RUNS = 6;

const PORTALS = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');
const cfg = (() => {
  try {
    if (!existsSync(PORTALS)) return {};
    return yaml.load(readFileSync(PORTALS, 'utf8'))?.neogov || {};
  } catch { return {}; }
})();

const AGENCIES = Array.isArray(cfg.agencies) && cfg.agencies.length ? cfg.agencies : DEFAULT_AGENCIES;
const HOME = cfg.home && Number.isFinite(cfg.home.lat) ? cfg.home : DEFAULT_HOME;
const RADIUS = Number.isFinite(cfg.radius_miles) ? cfg.radius_miles : DEFAULT_RADIUS_MILES;

/** Great-circle miles between two points. */
export function milesBetween(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Return the UTC offset, in milliseconds, for America/New_York at a point in time. */
function easternOffsetMs(atMs) {
  try {
    const name = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(atMs)).find((p) => p.type === 'timeZoneName')?.value || '';
    const m = name.match(/GMT([+-])(\d{2}):?(\d{2})/);
    if (m) {
      const minutes = Number(m[2]) * 60 + Number(m[3]);
      return (m[1] === '-' ? -1 : 1) * minutes * 60000;
    }
  } catch {}
  // Conservative Eastern fallback: retaining a posting an hour too long is
  // preferable to removing it before the employer's stated closing day ends.
  return -5 * 60 * 60000;
}

/**
 * "07/24/26" → epoch ms. By default this is the start of the local calendar
 * day, suitable for posting-age calculations. With endOfDay=true it is
 * 23:59:59.999 in America/New_York, suitable for application deadlines.
 */
export function parseMdY(s, endOfDay = false) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  const month = Number(mm);
  const day = Number(dd);
  const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (!endOfDay) return new Date(year, month - 1, day).getTime();
  const wallClockUtc = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  return wallClockUtc - easternOffsetMs(Date.UTC(year, month - 1, day, 12));
}

/**
 * "$58,037.00 - $66,390.00 Annually" → { min, max, unit }
 * "$26.39 - $36.37 Hourly"           → { min, max, unit: 'HOUR' }
 *
 * The unit is read from the trailing word rather than inferred from magnitude:
 * a $16.90 hourly rate and a $16,900 annual salary are both plausible numbers,
 * so guessing would misreport one of them as the other.
 */
export function parseSalary(text) {
  const raw = String(text || '');
  const nums = [...raw.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)].map((x) => Number(x[1].replace(/,/g, '')));
  if (!nums.length) return null;
  const unit = /hourly|per hour|\/\s*hr\b/i.test(raw) ? 'HOUR'
    : /monthly/i.test(raw) ? 'MONTH'
      : /bi-?weekly/i.test(raw) ? 'BIWEEK'
        : /daily|per day/i.test(raw) ? 'DAY'
          : 'YEAR';
  const min = nums[0];
  const max = nums.length > 1 ? Math.max(...nums) : nums[0];
  return { min, max, unit };
}

/** Raw jobList record → the shape the rest of this system speaks. */
export function normalize(rec, agency, now = Date.now()) {
  const postedAtMs = parseMdY(rec.PostingDate);
  const continuous = String(rec.ClosingDate || '').trim().toLowerCase() === 'continuous';
  const deadlineMs = continuous ? null : parseMdY(rec.ClosingDate, true);
  const lat = Number(rec.Lattitude);
  const lon = Number(rec.Longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);

  return {
    company: agency.name,
    agency: agency.slug,
    title: rec.Classification || '',
    reqId: rec.JobNumber || null,
    // `Location` is free text the agency types in ("13800 Manor Road Baldwin,
    // MD", "Various locations throughout Baltimore County, MD"), which is why
    // the filter below uses coordinates instead.
    location: rec.Location || '',
    city: (rec.JobCity || [])[0] || null,
    state: (rec.JobAbbrvState || [])[0] || null,
    url: `${BASE}/careers/${agency.slug}/jobs/${rec.ID}/${rec.JobTitle || ''}`,
    postedAtMs,
    days: postedAtMs === null ? null : Math.max(0, Math.round((now - postedAtMs) / 86400000)),
    // "Continuous" means accepting applications indefinitely — an open posting
    // with no deadline, not a posting whose deadline is unknown.
    continuous,
    deadlineMs,
    deadline: continuous ? 'Continuous' : (rec.ClosingDate || null),
    employmentType: rec.JobType || null,
    department: rec.DepartmentName || null,
    categories: Array.isArray(rec.Categories) ? rec.Categories : [],
    salary: rec.IsSalaryVisible === false ? null : parseSalary(rec.SalaryInfo),
    sourceFailureRuns: 0,
    retainedAfterAgencyFailure: false,
    coordinatesVerified: hasCoords,
    miles: hasCoords ? Math.round(milesBetween(HOME, { lat, lon }) * 10) / 10 : null,
  };
}

export async function fetchAgency(agency) {
  const url = `${BASE}/careers/home/loadJobsOnMaps?agency=${encodeURIComponent(agency.slug)}`;
  const res = await fetch(url, { headers: HEADERS });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('json')) {
    // A wrong slug does not 404 — it renders the generic careers page, so a
    // status check alone would report success on a silently empty agency.
    throw new Error(`HTTP ${res.status} ${ct.split(';')[0] || 'unknown'} (slug likely wrong)`);
  }
  const body = await res.json();
  if (!Array.isArray(body.jobList)) throw new Error('JSON response missing jobList array');
  return body.jobList;
}


// Merge the fresh public-sector sweep with the other local stores. This output
// contains public job listings only; no resume, application, or profile data.
const nkey = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const clampFit = n => Math.max(0, Math.min(100, Math.round(n)));
function unifiedPayTier(s) {
  if (!s || (s.min == null && s.max == null)) return 2;
  let min = Number(s.min), max = Number(s.max), unit = String(s.unit || '').toLowerCase();
  if (unit === 'year') { min /= 2080; max /= 2080; }
  return min >= 20 ? 0 : max >= 20 ? 1 : 3;
}
function unifiedRecencyScore(j) {
  if (j.days === null || j.days === undefined || !Number.isFinite(Number(j.days))) return 30;
  const days = Math.max(0, Number(j.days));
  let score = days <= 3 ? 100 : days <= 7 ? 94 : days <= 14 ? 86
    : days <= 30 ? 74 : days <= 60 ? 60 : days <= 120 ? 45
      : days <= 365 ? 28 : 12;
  // Continuous postings are often standing applicant pools. Keep them
  // discoverable, but do not let a year-old pool outrank a recent opening.
  if (j.continuous) {
    if (days > 365) score = Math.min(score, 8);
    else if (days > 180) score = Math.min(score, 14);
    else if (days > 60) score = Math.min(score, 25);
    else score = Math.max(0, score - 8);
  }
  return score;
}

export function unifiedScore(j) {
  const t = nkey(j.title);
  const tech = /\b(data|analyst|analytics|information technology|it functional|systems|application|software|technical support|help desk|database|sql|power bi|crm|salesforce|business intelligence|reporting|quality assurance|project coordinator|program coordinator)\b/.test(t);
  const service = /\b(customer|cashier|front desk|reception|guest|retail|sales associate|call center|dispatcher|administrative|office assistant|program assistant|teller|support specialist)\b/.test(t);
  const credential = /\b(nurse|physician|therapist|attorney|counsel|scientist|licensed|certified|professor|faculty)\b/.test(t);
  const executive = /\b(chief|executive|vice president|vp|head of)\b/.test(t);
  const advanced = /\b(director|principal|senior|sr|lead)\b/.test(t);
  const manager = /\b(manager|supervisor)\b/.test(t);
  const levelIIIPlus = /\b(iii|iv|v)\b|\b(?:level|grade)\s*[3-9]\b/.test(t);
  const levelII = /\bii\b|\b(?:level|grade)\s*2\b/.test(t);
  const entrySignal = /\b(entry|junior|jr|trainee|assistant|associate|apprentice|intern|level i|grade 1)\b/.test(t);
  // Some classification titles imply independent professional experience even
  // without saying "senior". This is a caution, not an automatic rejection.
  const implicitAdvanced = !entrySignal && /\b(technical specialist|systems specialist|systems analyst|functional analyst|administrator|architect|consultant|engineer|planner|program analyst|management analyst|human resources analyst|program investigator)\b/.test(t);
  const seniorityPenalty = executive ? 34 : advanced ? 24 : manager ? 20
    : levelIIIPlus ? 14 : levelII ? 7 : implicitAdvanced ? 14 : 0;
  let qualification = tech ? 82 : service ? 88 : 58;
  let interview = tech ? 70 : service ? 84 : 55;
  let careerValue = tech ? 90 : service ? 48 : 58;
  let overqualificationRisk = service ? 18 : tech ? 8 : 12;
  let resume = tech ? 'Professional' : service ? 'Customer service' : 'Review';
  if (credential) { qualification -= 35; interview -= 30; careerValue -= 15; resume = 'Review'; }
  if (seniorityPenalty) {
    qualification -= seniorityPenalty;
    interview -= Math.max(6, seniorityPenalty - 3);
  }
  const tier = unifiedPayTier(j.salary);
  const pay = [100, 78, 52, 28][tier];
  const recency = unifiedRecencyScore(j);
  const overall = clampFit(clampFit(qualification) * .27 + clampFit(interview) * .20 + pay * .18
    + clampFit(careerValue) * .15 + recency * .15 + (100 - clampFit(overqualificationRisk)) * .05);
  const flags = [];
  if (credential) flags.push('credential/skill check');
  if (executive) flags.push('executive-level experience check');
  else if (advanced) flags.push('senior/lead experience check');
  else if (manager) flags.push('management experience check');
  else if (levelIIIPlus) flags.push('level III+ experience check');
  else if (levelII) flags.push('level II experience check');
  else if (implicitAdvanced) flags.push('classification may require prior professional experience');
  if (j.days === null || j.days === undefined || !Number.isFinite(Number(j.days))) flags.push('posting age unknown');
  else if (j.continuous && Number(j.days) > 60) flags.push('older continuous/standing recruitment');
  else if (Number(j.days) > 120) flags.push('older posting—verify still active');
  if (tier === 2) flags.push('pay undisclosed');
  if (tier === 3) flags.push('published pay below $20');
  if (j.scope === 'regional') flags.push('regional/public board—not exact-radius verified');
  return { overall, qualification: clampFit(qualification), interview: clampFit(interview), pay,
    careerValue: clampFit(careerValue), recency, overqualificationRisk: clampFit(overqualificationRisk),
    resume, confidence: 'preliminary—title/pay/location/recency metadata', flags };
}
function displayPay(s) {
  if (!s || (s.min == null && s.max == null)) return '—';
  const unit = String(s.unit || '').toLowerCase();
  const dollar = String.fromCharCode(36);
  const f = v => v == null ? '?' : unit === 'year'
    ? dollar + Math.round(Number(v) / 1000) + 'k'
    : dollar + Number(v).toFixed(Number(v) % 1 ? 2 : 0);
  return (s.min === s.max ? f(s.min) : f(s.min) + '–' + f(s.max))
    + (unit === 'hour' ? '/hr' : unit === 'year' ? '/yr' : '');
}
function unifiedSourceRank(source) {
  return /JobAps|NEOGOV|official|Direct/i.test(String(source || '')) ? 0 : 1;
}

function normalizedLocation(j) {
  return nkey(j.location || [j.city, j.state].filter(Boolean).join(' '));
}

function stableListingId(j) {
  if (j.reqId) return 'req:' + nkey(j.reqId);
  if (/HiringCafe/i.test(String(j.source || '')) || !j.url) return null;
  try {
    const u = new URL(j.url);
    if (/jobapscloud\.com$/i.test(u.hostname)) {
      const parts = ['R1', 'R2', 'R3'].map((k) => nkey(u.searchParams.get(k))).filter(Boolean);
      if (parts.length) return 'jobaps:' + parts.join('-');
    }
    return 'url:' + nkey(u.hostname + u.pathname.replace(/\/+$/, ''));
  } catch {
    return 'url:' + nkey(j.url);
  }
}

/**
 * Stable key used by the unified deduper. Location is always present in the
 * key, while an authoritative reqId/direct URL keeps separate requisitions
 * distinct even when an employer reuses the same title and location.
 */
export function unifiedDedupKey(j) {
  const signature = [nkey(j.company), nkey(j.title), normalizedLocation(j)].join('|');
  const stable = stableListingId(j);
  return stable ? signature + '|' + stable : signature;
}

function dedupeUnifiedRows(rows) {
  const identified = new Map();
  const fallback = new Map();
  const authoritativeSignatures = new Set();
  const ordered = [...rows].sort((a, b) => unifiedSourceRank(a.source) - unifiedSourceRank(b.source));

  for (const x of ordered) {
    const signature = [nkey(x.company), nkey(x.title), normalizedLocation(x)].join('|');
    const stable = stableListingId(x);
    if (stable) {
      const key = [nkey(x.company), normalizedLocation(x), stable].join('|');
      const old = identified.get(key);
      if (!old || unifiedSourceRank(x.source) < unifiedSourceRank(old.source)) identified.set(key, x);
      authoritativeSignatures.add(signature);
      fallback.delete(signature);
    } else if (!authoritativeSignatures.has(signature)) {
      const old = fallback.get(signature);
      if (!old || unifiedSourceRank(x.source) < unifiedSourceRank(old.source)) fallback.set(signature, x);
    }
  }
  return [...identified.values(), ...fallback.values()];
}

function writeUnifiedLocalJobs({ strict = false } = {}) {
  const read = (name, fallback) => {
    try { return JSON.parse(readFileSync(path.join(ROOT, name), 'utf8')); }
    catch (err) {
      if (strict) throw new Error('cannot rebuild unified output from ' + name + ': ' + err.message);
      return fallback;
    }
  };
  const hc = read('owings-mills-store.json', { jobs: {} });
  const workday = read('local-workday-store.json', []);
  const mdgov = read('maryland-gov-store.json', []);
  const ng = read('neogov-store.json', []);
  const near = /\b(owings mills|garrison|glyndon|reisterstown|pikesville|randallstown|milford mill|windsor mill|stevenson|lochearn|finksburg|woodstock|towson)\b/i;
  const regionalBoard = /\b(city of baltimore|umbc|stevenson university|johns hopkins university|towson university|university of maryland|loyola university|goucher college)\b/i;
  const rows = [];
  for (const x of Object.values(hc.jobs || {})) rows.push({ ...x, location: [x.city, x.region].filter(Boolean).join(', '), source: 'HiringCafe', scope: '10-mile proxy' });
  for (const x of workday) {
    const regional = regionalBoard.test(x.company), local = near.test(x.location || '');
    if (!local && !regional) continue;
    rows.push({ ...x, source: x.source || 'Direct employer board', scope: local ? '10-mile proxy' : 'regional' });
  }
  const knownInternalMarylandReqs = new Set(['26-002588-0052', '26-004498-0001', '26-001702-0009']);
  for (const x of mdgov) if (!x.restricted && !knownInternalMarylandReqs.has(x.reqId)
    && /\b(Baltimore County|Baltimore City)\b/i.test(x.location || ''))
    rows.push({ ...x, source: 'State of Maryland JobAps', scope: 'regional' });
  for (const x of ng) {
    const miles = typeof x.miles === 'number' ? x.miles : Number.NaN;
    if (!x.coordinatesVerified && !Number.isFinite(miles)) continue;
    if (Number.isFinite(miles) && miles <= 10)
      rows.push({ ...x, source: 'County/city NEOGOV', scope: '10-mile radius' });
  }

  const jobs = dedupeUnifiedRows(rows).map(x => ({ ...x, fit: unifiedScore(x) }))
    .sort((a,b) => b.fit.overall - a.fit.overall || unifiedPayTier(a.salary) - unifiedPayTier(b.salary) || (a.days ?? 999) - (b.days ?? 999));
  const sourceCounts = {};
  for (const j of jobs) sourceCounts[j.source] = (sourceCounts[j.source] || 0) + 1;
  const generatedAt = new Date().toISOString();
  writeFileSync(path.join(ROOT, 'unified-local-jobs.json'), JSON.stringify({
    generatedAt, center: 'Owings Mills, MD 21117',
    scope: '10-mile core plus explicitly labeled Baltimore-area public and university boards',
    payPriority: '$20+/hour first; annual salaries normalized at 2,080 hours/year for ranking',
    scoring: 'Preliminary metadata score prioritizing $20+/hour and recent postings; older/continuous/unknown-age and likely advanced classifications are penalized; verify requirements before applying',
    sourceCounts, jobs,
  }, null, 2));

  const esc = s => String(s || '').replace(/\|/g, '\\|');
  const md = ['# Unified local job search', '',
    '_Updated ' + generatedAt.slice(0,16).replace('T',' ') + ' UTC · ' + jobs.length + ' deduplicated openings_',
    '', '10-mile Owings Mills core plus clearly flagged Baltimore-area government and university boards. Official/direct listings replace aggregator duplicates without collapsing separate locations or requisitions. Scores prioritize plausible qualifications, interview likelihood, published pay of $20+/hour, career value, recency, and low overqualification risk; older standing recruitments and likely advanced classifications are demoted.',
    '', '## Sources', '', '| Source | Openings |', '|---|---:|',
    ...Object.entries(sourceCounts).sort((a,b)=>b[1]-a[1]).map(([s,n]) => '| ' + esc(s) + ' | ' + n + ' |'),
    '', '## Best matches', '', '| Score | Employer | Role | Location | Pay | Source | Resume | Flags |',
    '|---:|---|---|---|---|---|---|---|'];
  for (const j of jobs.slice(0,100)) md.push('| ' + j.fit.overall + ' | ' + esc(j.company) + ' | [' + esc(j.title) + '](' + j.url + ') | ' +
    esc(j.location || j.city || '—') + ' | ' + displayPay(j.salary) + ' | ' + esc(j.source) + ' | ' + j.fit.resume + ' | ' + esc(j.fit.flags.join('; ') || '—') + ' |');
  md.push('', '## Notes', '', '- “Regional” means the board is relevant to the Baltimore-area search but the posting is not verified within 10 road miles.',
    '- State and local government deadlines are preserved in the JSON output.',
    '- NEOGOV rows without verified coordinates are omitted from radius-limited results.',
    '- Older continuous postings and unknown-age roles receive recency penalties so fresh openings surface first.',
    '- Advanced classifications receive a caution penalty even when the title does not explicitly say senior.',
    '- Scores are screening aids, not claims that every minimum qualification is met.');
  writeFileSync(path.join(ROOT, 'unified-local-jobs.md'), md.join('\n'));
  console.log('  unified: ' + jobs.length + ' deduplicated jobs across ' + Object.keys(sourceCounts).length + ' source groups');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--unified-only')) {
    // Deliberately no network access and no source-store mutation. A thrown
    // read/write error remains uncaught so CI exits nonzero.
    writeUnifiedLocalJobs({ strict: true });
  } else {
  const now = Date.now();
  const all = [];
  const failures = [];
  const previousRows = (() => {
    try {
      const parsed = JSON.parse(readFileSync(DEST, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  })();
  const successfulAgencies = new Set();

  for (const agency of AGENCIES) {
    try {
      const list = await fetchAgency(agency);
      successfulAgencies.add(agency.slug);
      for (const rec of list) all.push(normalize(rec, agency, now));
      console.log(`  ${agency.slug.padEnd(22)} ${String(list.length).padStart(4)} openings`);
    } catch (err) {
      failures.push(`${agency.slug}: ${err.message}`);
      console.log(`  ${agency.slug.padEnd(22)}    ✗ ${err.message}`);
    }
  }

  // A source outage must not masquerade as every job at that agency closing.
  // Retain only the failed agencies' last known records; successful agencies
  // are always replaced by their fresh result, including a legitimate empty list.
  for (const agency of AGENCIES.filter((a) => !successfulAgencies.has(a.slug))) {
    const candidates = previousRows.filter((j) => j.agency === agency.slug);
    const retained = candidates
      .map((j) => {
        const continuous = j.continuous || String(j.deadline || '').trim().toLowerCase() === 'continuous';
        const parsedDeadline = continuous ? null : parseMdY(j.deadline, true);
        const miles = typeof j.miles === 'number' && Number.isFinite(j.miles) ? j.miles : null;
        return {
          ...j,
          continuous,
          deadlineMs: parsedDeadline ?? (continuous ? null : j.deadlineMs),
          days: Number.isFinite(Number(j.postedAtMs))
            ? Math.max(0, Math.round((now - Number(j.postedAtMs)) / 86400000))
            : null,
          sourceFailureRuns: Math.max(0, Number(j.sourceFailureRuns) || 0) + 1,
          coordinatesVerified: miles !== null,
          miles,
          retainedAfterAgencyFailure: true,
        };
      })
      .filter((j) => j.sourceFailureRuns <= MAX_RETAINED_FAILURE_RUNS);
    const expired = candidates.length - retained.length;
    all.push(...retained);
    if (retained.length || expired) {
      console.log(`  ${agency.slug.padEnd(22)} retained ${retained.length} prior records after failure; expired ${expired} after ${MAX_RETAINED_FAILURE_RUNS} degraded runs`);
    }
  }
  if (failures.length === AGENCIES.length && previousRows.length === 0) {
    throw new Error('all NEOGOV agencies failed and no prior store is available; refusing to overwrite with an empty result');
  }

  // A closed posting is a lie on a dashboard, and here the closing date is
  // stated rather than guessed — so drop rather than infer.
  const open = all.filter((j) => j.deadlineMs === null || j.deadlineMs >= now);
  const closed = all.length - open.length;

  const inRange = (j) => typeof j.miles === 'number' && Number.isFinite(j.miles) && j.miles <= RADIUS;
  const rows = (process.argv.includes('--all') ? open : open.filter(inRange))
    .sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));

  writeFileSync(DEST, JSON.stringify(rows, null, 2));
  console.log(`\nwrote ${DEST}`);
  console.log(`  fetched=${all.length} open=${open.length} (${closed} past their closing date) kept=${rows.length} within ${RADIUS}mi`);
  console.log(`  with salary=${rows.filter((r) => r.salary).length} | dated=${rows.filter((r) => r.days !== null).length} | posted within 21d=${rows.filter((r) => r.days !== null && r.days <= 21).length}`);
  if (failures.length) console.log(`  agencies failed: ${failures.join('; ')}`);

  writeUnifiedLocalJobs();

  if (process.argv.includes('--pipeline')) {
    const { appendToPipeline, appendToScanHistory, loadSeenUrls, normalizeUrlForDedup } =
      await import('./scan.mjs');
    const { seen } = loadSeenUrls();
    const offers = rows
      .filter((r) => !seen.has(normalizeUrlForDedup(r.url)))
      .map((r) => ({
        url: r.url,
        company: r.company,
        title: r.title,
        location: r.location,
        salary: r.salary,
        postedAt: r.postedAtMs ?? undefined,
        note: r.continuous ? 'neogov; continuous posting' : `neogov; closes ${r.deadline}`,
      }));
    if (offers.length === 0) console.log('  pipeline: nothing new — every row already seen');
    else {
      await appendToPipeline(offers);
      appendToScanHistory(offers, new Date(now).toISOString().slice(0, 10));
      console.log(`  pipeline: +${offers.length} new (${rows.length - offers.length} already seen)`);
    }
  }
  }
}
