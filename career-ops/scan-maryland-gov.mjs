#!/usr/bin/env node

/**
 * scan-maryland-gov.mjs — Maryland state government openings via JobAps.
 *
 * The state runs JobAps (jobapscloud.com/MD), which no ATS dataset indexes and
 * no other scanner here reaches. It publishes an RSS feed whose descriptions
 * carry a fixed, parseable block: department, date opened, filing deadline,
 * salary, employment type and work location.
 *
 * Two things make this source unusually good:
 *
 *   - **A real filing deadline.** Everywhere else, "is this still open?" is
 *     guesswork — hiring.cafe's validThrough is synthetic and Workday only
 *     says "30+ days". Here the state states when applications close, so a
 *     closed posting can be dropped rather than inferred.
 *   - **A published salary on every row**, which the Workday side rarely has.
 *
 * Location-first and title-blind, like the other sweeps. JobAps reports work
 * location as a Maryland county, so the rings are county-based: Baltimore
 * County contains Owings Mills, Reisterstown, Pikesville, Randallstown and
 * Windsor Mill.
 *
 * Usage:
 *   node scan-maryland-gov.mjs              # → maryland-gov-store.json
 *   node scan-maryland-gov.mjs --pipeline   # also append new rows to the pipeline
 *   node scan-maryland-gov.mjs --all        # keep every county, not just local
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FEED = 'https://www.jobapscloud.com/MD/rss.asp';
const DEST = path.join(ROOT, 'maryland-gov-store.json');

const PORTALS = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');
const cfg = (() => {
  try {
    if (!existsSync(PORTALS)) return {};
    return yaml.load(readFileSync(PORTALS, 'utf8'))?.maryland_gov || {};
  } catch { return {}; }
})();

// Counties within reach of Owings Mills. Baltimore County is the home county;
// the rest are a commutable drive. "Statewide" postings can be based anywhere,
// so they are kept and flagged rather than assumed local.
const DEFAULT_COUNTIES = [
  'Baltimore County', 'Baltimore City', 'Anne Arundel', 'Howard',
  'Carroll', 'Harford', 'Statewide',
];
const COUNTIES = Array.isArray(cfg.counties) && cfg.counties.length ? cfg.counties : DEFAULT_COUNTIES;

const rawField = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '') : '';
};
const unescapeHtml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const plain = (s) => unescapeHtml(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const INTERNAL_ONLY_PATTERNS = [
  // JobAps announcements are written by many agencies, so wording and even
  // spelling vary. Keep these patterns narrow enough not to match boilerplate
  // such as "current State employees do not need to submit...".
  /\binternal[\s-]+(?:only[\s-]+)?recruitment\b/i,
  /\bthis\s+re\w*ment\s+(?:is\s+)?(?:open\s+)?(?:only\s+)?(?:to|for)\s+(?:only\s+)?current\s+[^.]{0,140}\bemployees?\b/i,
  /\b(?:you\s+)?must\s+be\s+(?:an?\s+)?current\s+[^.]{0,100}\bemployees?\b/i,
  /\b(?:limited|restricted)\s+(?:only\s+)?(?:to|for)\s+(?:only\s+)?current\s+[^.]{0,120}\bemployees?\b/i,
  /\bonly\s+(?:open|available)\s+to\s+current\s+[^.]{0,120}\bemployees?\b/i,
  /\bcurrent\s+(?:state|maryland|department|agency|[a-z]{2,10})\b[^.]{0,100}\bemployees?\s+only\b/i,
];

export function internalRestriction(html) {
  const text = plain(html);
  const pattern = INTERNAL_ONLY_PATTERNS.find((re) => re.test(text));
  return pattern ? 'Internal recruitment — current employees only' : null;
}

const normalizeReqId = (value) => String(value || '').trim().toUpperCase();

export function eligibilityFromHtml(html, { reqId = null } = {}) {
  const text = plain(html);
  const pageReq = text.match(/\bRecruitment\s*#\s*([\w-]+)/i)?.[1] || null;

  // A 200 response can still be a JobAps error/login page. Never treat the
  // absence of an internal-only phrase as proof that such a response is public.
  if (!pageReq) {
    return { status: 'unverified', restriction: null, detail: 'missing recruitment marker' };
  }
  if (reqId && normalizeReqId(pageReq) !== normalizeReqId(reqId)) {
    return {
      status: 'unverified',
      restriction: null,
      detail: `recruitment mismatch (expected ${reqId}, got ${pageReq})`,
    };
  }

  const missingMarkers = ['Filing Deadline', 'Work Location']
    .filter((marker) => !text.toLowerCase().includes(marker.toLowerCase()));
  if (missingMarkers.length || !/\b(?:MINIMUM QUALIFICATIONS|Main Purpose of Job|POSITION DUTIES)\b/i.test(text)) {
    return {
      status: 'unverified',
      restriction: null,
      detail: `incomplete announcement markers${missingMarkers.length ? `: ${missingMarkers.join(', ')}` : ''}`,
    };
  }

  const restriction = internalRestriction(text);
  if (restriction) return { status: 'internal', restriction, detail: null };
  return { status: 'public', restriction: null, detail: null };
}

export function runEligibilitySelfChecks() {
  const page = (reqId, body = '') =>
    `<h1>Job Announcement</h1> Recruitment #${reqId} Filing Deadline Work Location MINIMUM QUALIFICATIONS ${body}`;
  const cases = [
    [Boolean(internalRestriction('THIS RECURITMENT IS FOR CURRENT MARYLAND DEPARTMENT OF LABOR EMPLOYEES.')), true, 'misspelled recruitment notice'],
    [Boolean(internalRestriction('You must be a current SDAT employee.')), true, 'agency employee limitation'],
    [Boolean(internalRestriction('Permanent State employees do not need to submit proof of Veterans status.')), false, 'employee boilerplate'],
    [eligibilityFromHtml(page('26-1', 'Open to all qualified applicants.'), { reqId: '26-1' }).status, 'public', 'public announcement'],
    [eligibilityFromHtml(page('26-1', 'You must be a current SDAT employee.'), { reqId: '26-1' }).status, 'internal', 'internal announcement'],
    [eligibilityFromHtml('<html>Internal Server Error</html>', { reqId: '26-1' }).status, 'unverified', 'error page'],
    [eligibilityFromHtml(page('26-2'), { reqId: '26-1' }).status, 'unverified', 'mismatched announcement'],
  ];
  for (const [actual, expected, label] of cases) {
    if (actual !== expected) throw new Error(`eligibility self-check failed: ${label}; expected ${expected}, got ${actual}`);
  }
  return cases.length;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const unverifiedEligibility = (job, detail) => ({
  ...job,
  restricted: null,
  restriction: null,
  eligibilityStatus: 'unverified',
  eligibilityCheck: detail,
});

async function checkEligibility(job) {
  if (!job.url) return unverifiedEligibility(job, 'missing detail URL');
  try {
    const res = await fetch(job.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return unverifiedEligibility(job, `HTTP ${res.status}`);
    const assessment = eligibilityFromHtml(await res.text(), { reqId: job.reqId });
    return {
      ...job,
      restricted: assessment.status === 'internal',
      restriction: assessment.restriction,
      eligibilityStatus: assessment.status,
      eligibilityCheck: assessment.status === 'unverified'
        ? `unverified: ${assessment.detail}`
        : 'checked',
    };
  } catch (err) {
    return unverifiedEligibility(job, `unavailable: ${err.message}`);
  }
}

/** "$76,608.00 - $120,814.00/year." → { min, max, unit } */
export function parseSalary(text) {
  // Bounded by the next label, NOT by a period: every figure contains one
  // ("$76,608.00"), so a `[^.]*` window stops at the first cent mark and the
  // rate is lost. That silently dropped 244 of 253 salaries.
  const m = text.match(/Salary:\s*([\s\S]*?)(?=\s*(?:Employment Type|HR Analyst|Work Location|View this)\s*:|$)/i);
  if (!m) return null;
  const raw = m[1];
  // JobAps writes both "$76,608.00/year" and "$31/hr - $40/hr". Matching only
  // the word "hour" labelled the abbreviated ones as annual, which read as a
  // $31-a-year salary.
  const unit = /hour|hourly|\/\s*hr\b/i.test(raw) ? 'HOUR' : 'YEAR';
  const nums = [...raw.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)].map((x) => Number(x[1].replace(/,/g, '')));
  if (!nums.length) return null;
  const min = nums[0];
  const max = nums.length > 1 ? nums[1] : nums[0];
  // Some contractual postings (Maryland Public Television production work) quote
  // a per-day or per-production rate with no unit given. Reporting "$175" as an
  // annual salary would be worse than reporting nothing, so drop it.
  if (unit === 'YEAR' && max < 15000) return null;
  return { min, max, unit };
}

const between = (text, label, next) => {
  const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\s*(?:${next})\\s*:|$)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim().replace(/\.$/, '') : '';
};

export function parseItem(block, now = new Date()) {
  const titleRaw = plain(rawField(block, 'title'));
  const desc = plain(rawField(block, 'description'));
  if (!titleRaw) return null;

  // "IT TECHNICAL SUPPORT SPECIALIST I - #26-004475-0001"
  const reqMatch = titleRaw.match(/-\s*#([\w-]+)\s*$/);
  const title = reqMatch ? titleRaw.slice(0, reqMatch.index).trim() : titleRaw;

  const openedRaw = between(desc, 'Date Opened', 'Filing Deadline|Salary');
  const deadlineRaw = between(desc, 'Filing Deadline', 'Salary|Employment Type');
  const opened = Date.parse(openedRaw);
  const deadline = Date.parse(deadlineRaw);

  return {
    company: `State of Maryland — ${between(desc, 'Department', 'Date Opened|Filing Deadline') || 'unspecified'}`,
    title,
    reqId: reqMatch ? reqMatch[1] : null,
    location: between(desc, 'Work Location', 'View this Recruitment') || '',
    url: unescapeHtml(rawField(block, 'link')).trim(),
    days: Number.isFinite(opened) ? Math.max(0, Math.round((now - opened) / 86400000)) : null,
    postedAtMs: Number.isFinite(opened) ? opened : null,
    // The one honest liveness signal in this whole search: the state says when
    // applications close, rather than leaving it to be inferred.
    deadlineMs: Number.isFinite(deadline) ? deadline : null,
    deadline: deadlineRaw || null,
    employmentType: between(desc, 'Employment Type', 'HR Analyst|Work Location') || null,
    salary: parseSalary(desc),
  };
}

export const isLocalCounty = (loc, counties = COUNTIES) =>
  counties.some((c) => String(loc || '').toLowerCase().includes(c.toLowerCase()));

if (process.argv.includes('--self-test')) {
  console.log(`eligibility self-checks passed: ${runEligibilitySelfChecks()}`);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = await fetch(FEED, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) { console.error(`JobAps feed returned HTTP ${res.status}`); process.exit(1); }
  const xml = await res.text();
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

  const now = new Date();
  const all = blocks.map((b) => parseItem(b, now)).filter(Boolean);
  const open = all.filter((j) => j.deadlineMs === null || j.deadlineMs >= now.getTime());
  const closed = all.length - open.length;
  const candidates = process.argv.includes('--all') ? open : open.filter((j) => isLocalCounty(j.location));
  const checked = await mapLimit(candidates, 6, checkEligibility);
  const restricted = checked.filter((j) => j.eligibilityStatus === 'internal');
  const unverified = checked.filter((j) => j.eligibilityStatus === 'unverified');
  const verified = checked.length - unverified.length;

  // A broad JobAps outage or markup change must not replace a healthy store
  // with a nearly empty one. Individual unverifiable rows fail closed; a batch
  // failure aborts before writing so the last successful store remains intact.
  if (checked.length && (verified === 0 || unverified.length / checked.length > 0.25)) {
    throw new Error(
      `eligibility verification failed for ${unverified.length}/${checked.length} candidates; preserving previous store`,
    );
  }

  const rows = checked.filter((j) => j.eligibilityStatus === 'public')
    .sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));

  writeFileSync(DEST, JSON.stringify(rows, null, 2));
  console.log(`wrote ${DEST}`);
  console.log(`  feed=${all.length} open=${open.length} (${closed} past their filing deadline) kept=${rows.length} internal-only excluded=${restricted.length} unverified excluded=${unverified.length}`);
  console.log(`  with salary=${rows.filter((r) => r.salary).length} | opened within 21d=${rows.filter((r) => r.days !== null && r.days <= 21).length}`);

  if (process.argv.includes('--pipeline')) {
    const { appendToPipeline, appendToScanHistory, loadSeenUrls, normalizeUrlForDedup } =
      await import('./scan.mjs');
    const { seen } = loadSeenUrls();
    const offers = rows
      .filter((r) => !seen.has(normalizeUrlForDedup(r.url)))
      .map((r) => ({
        url: r.url, company: r.company, title: r.title, location: r.location,
        salary: r.salary, postedAt: r.postedAtMs ?? undefined,
        note: r.deadline ? `md-gov; closes ${r.deadline}` : 'md-gov',
      }));
    if (offers.length === 0) console.log('  pipeline: nothing new — every row already seen');
    else {
      await appendToPipeline(offers);
      appendToScanHistory(offers, now.toISOString().slice(0, 10));
      console.log(`  pipeline: +${offers.length} new (${rows.length - offers.length} already seen)`);
    }
  }
}
