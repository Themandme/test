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
