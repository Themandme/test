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

/** "07/24/26" → epoch ms, interpreted in local time. Returns null on anything else. */
export function parseMdY(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
  const t = new Date(year, Number(mm) - 1, Number(dd)).getTime();
  return Number.isFinite(t) ? t : null;
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
  const deadlineMs = continuous ? null : parseMdY(rec.ClosingDate);
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
  return Array.isArray(body.jobList) ? body.jobList : [];
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
function unifiedScore(j) {
  const t = nkey(j.title);
  const tech = /\b(data|analyst|analytics|information technology|it functional|systems|application|software|technical support|help desk|database|sql|power bi|crm|salesforce|business intelligence|reporting|quality assurance|project coordinator|program coordinator)\b/.test(t);
  const service = /\b(customer|cashier|front desk|reception|guest|retail|sales associate|call center|dispatcher|administrative|office assistant|program assistant|teller|support specialist)\b/.test(t);
  const credential = /\b(nurse|physician|therapist|attorney|counsel|scientist|licensed|certified|professor|faculty)\b/.test(t);
  // Seniority is a separate qualification signal. A title-only score cannot
  // prove the candidate meets the experience requirement, so progressively
  // demote likely advanced roles until the full posting is reviewed.
  const executive = /\b(chief|executive|vice president|vp|head of)\b/.test(t);
  const advanced = /\b(director|principal|senior|sr|lead)\b/.test(t);
  const manager = /\b(manager|supervisor)\b/.test(t);
  const levelIIIPlus = /\b(iii|iv|v|3|4|5)\b/.test(t);
  const levelII = /\b(ii|2)\b/.test(t);
  const seniorityPenalty = executive ? 34 : advanced ? 24 : manager ? 20
    : levelIIIPlus ? 14 : levelII ? 7 : 0;
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
  const tier = unifiedPayTier(j.salary), pay = [100, 78, 52, 28][tier];
  const overall = clampFit(clampFit(qualification) * .30 + clampFit(interview) * .25 + pay * .20 +
    clampFit(careerValue) * .20 + (100 - clampFit(overqualificationRisk)) * .05);
  const flags = [];
  if (credential) flags.push('credential/skill check');
  if (executive) flags.push('executive-level experience check');
  else if (advanced) flags.push('senior/lead experience check');
  else if (manager) flags.push('management experience check');
  else if (levelIIIPlus) flags.push('level III+ experience check');
  else if (levelII) flags.push('level II experience check');
  if (tier === 2) flags.push('pay undisclosed');
  if (tier === 3) flags.push('published pay below $20');
  if (j.scope === 'regional') flags.push('regional/public board—not exact-radius verified');
  return { overall, qualification: clampFit(qualification), interview: clampFit(interview), pay,
    careerValue: clampFit(careerValue), overqualificationRisk: clampFit(overqualificationRisk),
    resume, confidence: 'preliminary—title/pay/location metadata', flags };
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
function writeUnifiedLocalJobs() {
  const read = (name, fallback) => { try { return JSON.parse(readFileSync(path.join(ROOT, name), 'utf8')); } catch { return fallback; } };
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
  for (const x of ng) if (Number(x.miles) <= 10)
    rows.push({ ...x, source: 'County/city NEOGOV', scope: '10-mile radius' });

  const rank = s => /JobAps|NEOGOV|official|Direct/i.test(s) ? 0 : 1;
  const unique = new Map();
  for (const x of rows) {
    const key = nkey(x.company) + '|' + nkey(x.title), old = unique.get(key);
    if (!old || rank(x.source) < rank(old.source)) unique.set(key, x);
  }
  const jobs = [...unique.values()].map(x => ({ ...x, fit: unifiedScore(x) }))
    .sort((a,b) => b.fit.overall - a.fit.overall || unifiedPayTier(a.salary) - unifiedPayTier(b.salary) || (a.days ?? 999) - (b.days ?? 999));
  const sourceCounts = {};
  for (const j of jobs) sourceCounts[j.source] = (sourceCounts[j.source] || 0) + 1;
  const generatedAt = new Date().toISOString();
  writeFileSync(path.join(ROOT, 'unified-local-jobs.json'), JSON.stringify({
    generatedAt, center: 'Owings Mills, MD 21117',
    scope: '10-mile core plus explicitly labeled Baltimore-area public and university boards',
    payPriority: '$20+/hour first; annual salaries normalized at 2,080 hours/year for ranking',
    scoring: 'Preliminary metadata score; verify requirements before applying',
    sourceCounts, jobs,
  }, null, 2));

  const esc = s => String(s || '').replace(/\|/g, '\\|');
  const md = ['# Unified local job search', '',
    '_Updated ' + generatedAt.slice(0,16).replace('T',' ') + ' UTC · ' + jobs.length + ' deduplicated openings_',
    '', '10-mile Owings Mills core plus clearly flagged Baltimore-area government and university boards. Official/direct listings replace aggregator duplicates. Scores prioritize plausible qualifications, interview likelihood, published pay of $20+/hour, career value, and low overqualification risk.',
    '', '## Sources', '', '| Source | Openings |', '|---|---:|',
    ...Object.entries(sourceCounts).sort((a,b)=>b[1]-a[1]).map(([s,n]) => '| ' + esc(s) + ' | ' + n + ' |'),
    '', '## Best matches', '', '| Score | Employer | Role | Location | Pay | Source | Resume | Flags |',
    '|---:|---|---|---|---|---|---|---|'];
  for (const j of jobs.slice(0,100)) md.push('| ' + j.fit.overall + ' | ' + esc(j.company) + ' | [' + esc(j.title) + '](' + j.url + ') | ' +
    esc(j.location || j.city || '—') + ' | ' + displayPay(j.salary) + ' | ' + esc(j.source) + ' | ' + j.fit.resume + ' | ' + esc(j.fit.flags.join('; ') || '—') + ' |');
  md.push('', '## Notes', '', '- “Regional” means the board is relevant to the Baltimore-area search but the posting is not verified within 10 road miles.',
    '- State and local government deadlines are preserved in the JSON output.',
    '- Scores are screening aids, not claims that every minimum qualification is met.');
  writeFileSync(path.join(ROOT, 'unified-local-jobs.md'), md.join('\n'));
  console.log('  unified: ' + jobs.length + ' deduplicated jobs across ' + Object.keys(sourceCounts).length + ' source groups');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const now = Date.now();
  const all = [];
  const failures = [];

  for (const agency of AGENCIES) {
    try {
      const list = await fetchAgency(agency);
      for (const rec of list) all.push(normalize(rec, agency, now));
      console.log(`  ${agency.slug.padEnd(22)} ${String(list.length).padStart(4)} openings`);
    } catch (err) {
      failures.push(`${agency.slug}: ${err.message}`);
      console.log(`  ${agency.slug.padEnd(22)}    ✗ ${err.message}`);
    }
  }

  // A closed posting is a lie on a dashboard, and here the closing date is
  // stated rather than guessed — so drop rather than infer.
  const open = all.filter((j) => j.deadlineMs === null || j.deadlineMs >= now);
  const closed = all.length - open.length;

  const inRange = (j) => j.miles === null || j.miles <= RADIUS;
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
