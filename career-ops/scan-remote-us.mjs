// US remote search — scored against the CV, not just filtered.
//
// Intent: fully-remote US roles the candidate would genuinely screen well for.
// Pay is not a criterion; near-term employability is. This is the third net
// alongside the analyst/IT pipeline (portals.yml) and the Owings Mills local
// search (scan-owings-mills.mjs).
//
// Unlike the other two this one SCORES. "Would score well" is a match question,
// so each posting is weighted against terms the CV actually evidences, and only
// postings clearing a threshold are kept. Weights below map to real CV content:
// Salesforce/CRM ownership, first-line support, SQL/Power BI/Excel/Python
// reporting, cross-functional coordination, documented process work, and
// high-volume customer service.
//
// Coverage: the chunk window ROTATES between runs and results ACCUMULATE in a
// store — see sitemap-sweep.mjs for why a fixed `slice(0, N)` is a blind spot
// rather than a sample. This previously read the first 90 of ~465 chunks, every
// time, and the resulting yield of 4 roles was reported as "an accurate count
// of new matching postings" when it was a count across a fifth of the corpus.
import { writeFileSync } from 'fs';
import { entries, rotatingWindow, loadSweepState, saveSweepState, staleByLastmod } from './sitemap-sweep.mjs';

const UA = 'career-ops personal job search (+https://github.com/santifer/career-ops)';
const SITEMAP_INDEX = 'https://hiringcafe.com/job-posting-sitemap.xml';
const MAX_CHUNKS = 60;
const MAX_DETAILS = 1200;
// Both files sit at the repo root and are tracked, matching the other sweep
// stores. Under data/ they were gitignored, so the scheduled run could
// execute the sweep but never commit the result — and this sweep rotates
// through the sitemap and ACCUMULATES, so a store it cannot persist means
// coverage resets every run instead of building.
const SWEEP_STATE = 'remote-us-sweep.json';
const STORE = 'remote-us-store.json';
const CONCURRENCY = 4;
const DELAY_MS = 110;
const MAX_AGE_DAYS = 14;   // forward-looking: only genuinely current openings
const MIN_SCORE = 5;
// A title score floor matters more than the combined one. Without it, any role
// whose description happens to mention Salesforce/Excel/documentation scores
// well — a Product Counsel posting cleared the bar on description alone. The
// role must BE the kind of job, not merely mention the tools.
const MIN_TITLE_SCORE = 3;   // must match a named target title, not just a generic noun

// Slug prefilter: cheap gate before any page fetch. A slug must look remote AND
// carry a plausible title token, or we never fetch it.
const REMOTE_SLUG = ['remote', 'work-from-home', 'wfh', 'united-states', 'anywhere'];
const TITLE_SLUG = [
  // Tier 1
  'crm-analyst', 'crm-data', 'crm-support', 'salesforce', 'data-quality',
  'sales-operations', 'revenue-operations', 'business-development-specialist',
  // Tier 2
  'reporting-analyst', 'business-analyst', 'business-systems', 'operations-analyst',
  'data-analyst', 'bi-analyst', 'business-intelligence', 'power-bi', 'sales-enablement',
  // Tier 3
  'customer-success', 'client-services', 'member-services', 'data-coordinator',
  'data-management-specialist', 'office-administrator', 'crm',
  // Tier 4
  'marketing-operations',
  // Entry-level IT
  'help-desk', 'helpdesk', 'service-desk', 'it-support', 'technical-support',
  'desktop-support', 'application-support', 'systems-administrator', 'it-analyst',
];

// Title weights — what the role IS. Strongest signals first.
const TITLE_WEIGHTS = [
  // Tier 1 — apply first
  [/\bcrm (analyst|data analyst|support analyst)\b/i, 6],
  [/\bsalesforce (administrator|admin)\b/i, 6],
  [/\bdata quality analyst\b/i, 6],
  [/\b(sales|revenue) operations analyst\b/i, 6],
  [/\bbusiness development specialist\b/i, 6],
  // Tier 2 — strong fit, wider net
  [/\breporting analyst\b/i, 5],
  [/\bbusiness (systems )?analyst\b/i, 5],
  [/\boperations analyst\b/i, 5],
  [/\bdata analyst\b/i, 5],
  [/\b(bi analyst|business intelligence analyst|power ?bi developer)\b/i, 5],
  [/\bsales enablement analyst\b/i, 5],
  // Tier 3 — opened up by the retail experience
  [/\bcustomer success (associate|coordinator)\b/i, 4],
  [/\b(client|member) services coordinator\b/i, 4],
  [/\bdata (coordinator|management specialist)\b/i, 4],
  [/\boffice administrator\b/i, 4],
  // Entry-level IT
  [/\b(help ?desk|service ?desk)\b/i, 4],
  [/\b(it|desktop|application|technical) support\b/i, 4],
  [/\b(it analyst|it specialist|systems administrator)\b/i, 4],
  // Tier 4 — one genuine stretch
  [/\bmarketing operations analyst\b/i, 3],
  // Bare CRM/Salesforce mentions still count for something
  [/\bsalesforce\b/i, 3], [/\bcrm\b/i, 3],
];

// Description weights — what the role USES. Confirms the title.
const DESC_WEIGHTS = [
  [/\bsalesforce\b/i, 4], [/\bcrm\b/i, 3],
  [/\bpower\s?bi\b/i, 3], [/\bsql\b/i, 3], [/\bpython\b/i, 2],
  [/\bexcel\b/i, 2], [/\bzendesk\b|\bfreshdesk\b|\bservicenow\b|\bjira\b/i, 2],
  [/\bticket(s|ing)?\b/i, 2], [/\bdata (integrity|quality|accuracy)\b/i, 3],
  [/\bdocument(ation|ing)\b/i, 1], [/\bcross-functional\b/i, 1],
  [/\breporting\b|\bdashboard/i, 2], [/\bstakeholder/i, 1],
];

// Hard exclusions.
const SENIOR_RE = /\b(senior|sr\.?|staff|principal|director|head\s+of|vp|vice\s+president|chief|architect|executive|manager|lead\b|iii|iv)\b/i;
const CLINICAL_RE = /\b(nurse|nursing|\brn\b|lpn|physician|clinic(al|ian)|therapist|pharmacist|tele\s?triage|medical (assistant|coder|biller))\b/i;
// Hard blockers he cannot satisfy today: an active clearance, or student-only
// programs. Both would waste an application.
const BLOCKER_RE = /\b(clearance|ts\/sci|polygraph|secret\b|co-?op\b|currently enrolled|rising (junior|senior))\b/i;
// Experience floors that would screen him out regardless of fit.
// Predatory-posting signals. These are NOT excluded — the user asked for
// anything gettable — but they are flagged, because commission-only and
// recruit-your-own-team structures target exactly people who need income now.
// Matched phrases are attached to the row and surfaced, never silently dropped:
// the brief is "anything gettable", and the user decides. Listed individually so
// the output can name what tripped rather than just asserting "suspicious".
const CAUTION_PATTERNS = [
  /commission[- ]only/i, /100% commission/i, /straight commission/i, /no base salary/i,
  /unlimited earning/i, /uncapped income/i, /be your own boss/i, /host agency/i,
  /recruit(ing)? (others|agents)/i, /build (your|a) team/i, /1099 (only|contractor)/i,
  /purchase (your|a) (starter|kit)/i, /licensing (fee|required)/i, /pay for (your )?training/i,
  // MLM/"opportunity" tells found in the wild: a $160-200k "Business Development
  // Specialist" whose description was daily training calls and building a
  // downline. The original pattern list missed every one of these.
  /performance[- ]based opportunity/i, /independent (professional|contractor)s? who/i,
  /daily live training/i, /work locally or expand globally/i,
  /flexible schedule \(full or part[- ]time\)/i, /personal growth and professional development/i,
];
const cautionsIn = (text) => CAUTION_PATTERNS
  .filter(re => re.test(text))
  .map(re => String(re).replace(/^\/|\/i$/g, ''));
const EXP_FLOOR_RE = /\b([3-9]|1[0-9])\+?\s*(\+)?\s*years?\b/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
function jobPosting(html) {
  for (const [, raw] of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let d; try { d = JSON.parse(raw); } catch { continue; }
    for (const n of Array.isArray(d) ? d : [d]) if (n && n['@type'] === 'JobPosting') return n;
  }
  return null;
}
async function pooled(items, limit, worker) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k]); await sleep(DELAY_MS); }
  }));
  return out;
}
const scoreOf = (text, weights) => weights.reduce((s, [re, w]) => s + (re.test(text) ? w : 0), 0);

const RENDER_ONLY = process.argv.includes('--render-only');
const store = loadSweepState(SWEEP_STATE);
const run = RENDER_ONLY ? store.run : store.run + 1;

const allChunks = RENDER_ONLY ? [] : entries(await get(SITEMAP_INDEX));
const chunkCount = allChunks.length || store.chunkCount || 0;
const { window: windowChunks, cursor, nextCursor, cycleRuns } =
  rotatingWindow(allChunks, store.cursor, MAX_CHUNKS);

const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
const stats = {
  chunkCount, windowStart: cursor, windowSize: windowChunks.length,
  cycleRuns: allChunks.length ? cycleRuns : Math.max(1, Math.ceil((chunkCount || MAX_CHUNKS) / MAX_CHUNKS)),
  run, candidates: 0, skippedByLastmod: 0,
  fetched: 0, notRemote: 0, notUS: 0, senior: 0, clinical: 0, expFloor: 0,
  lowScore: 0, stale: 0, weakTitle: 0, blocked: 0,
  newThisRun: 0, refreshed: 0, expiredAge: 0, expiredUnseen: 0, kept: 0,
};

const chunkLists = await pooled(windowChunks, 4,
  async c => { try { return entries(await get(c)); } catch { return []; } });

const candidates = [];
for (const list of chunkLists) {
  for (const { loc: url, lastmod } of list) {
    const slug = url.slice(url.lastIndexOf('/') + 1);
    if (!(REMOTE_SLUG.some(t => slug.includes(t)) && TITLE_SLUG.some(t => slug.includes(t)))) continue;
    // At a 14-day window most of the corpus is stale, so skipping on the
    // sitemap's own <lastmod> is where most of the fetch budget is saved.
    if (staleByLastmod(lastmod, cutoff)) { stats.skippedByLastmod++; continue; }
    candidates.push(url);
  }
}
stats.candidates = candidates.length;

// Deterministic spread across the candidate list: taking the head sampled one
// end of the corpus and returned 92% stale postings.
const step = Math.max(1, Math.floor(candidates.length / MAX_DETAILS));
const sampled = candidates.filter((_, i) => i % step === 0).slice(0, MAX_DETAILS);
const rows = await pooled(sampled, CONCURRENCY, async (url) => {
  let p; try { p = jobPosting(await get(url)); } catch { return null; }
  if (!p || typeof p.title !== 'string') return null;
  stats.fetched++;
  const title = p.title.trim();

  if (SENIOR_RE.test(title)) { stats.senior++; return null; }
  if (CLINICAL_RE.test(title)) { stats.clinical++; return null; }

  const posted = Date.parse(p.datePosted || '');
  if (Number.isFinite(posted) && posted < cutoff) { stats.stale++; return null; }

  let loc = p.jobLocation; if (Array.isArray(loc)) loc = loc[0];
  const a = (loc && loc.address) || {};
  const locText = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
  const isRemote = p.jobLocationType === 'TELECOMMUTE' || /remote|anywhere|work from home/i.test(locText + ' ' + title);
  if (!isRemote) { stats.notRemote++; return null; }

  const country = String(a.addressCountry || '') + ' ' + locText;
  const usOk = /\bUS\b|\bUSA\b|United States/i.test(country) || (p.applicantLocationRequirements &&
    JSON.stringify(p.applicantLocationRequirements).match(/United States|\bUS\b/i));
  if (!usOk) { stats.notUS++; return null; }

  const desc = strip(p.description);
  if (EXP_FLOOR_RE.test(desc.slice(0, 2500))) { stats.expFloor++; return null; }

  const titleScore = scoreOf(title, TITLE_WEIGHTS);
  if (titleScore < MIN_TITLE_SCORE) { stats.weakTitle++; return null; }
  if (BLOCKER_RE.test(title) || BLOCKER_RE.test(desc.slice(0, 2500))) { stats.blocked++; return null; }
  const score = titleScore + scoreOf(desc, DESC_WEIGHTS);
  if (score < MIN_SCORE) { stats.lowScore++; return null; }

  const sal = p.baseSalary && p.baseSalary.value;
  // kept is counted from the store after the merge, not per-row.
  return {
    title, url, score,
    company: (p.hiringOrganization && p.hiringOrganization.name || '').trim(),
    location: locText || 'Remote (US)',
    datePosted: Number.isFinite(posted) ? new Date(posted).toISOString().slice(0, 10) : null,
    employmentType: Array.isArray(p.employmentType) ? p.employmentType.join(', ') : (p.employmentType || null),
    salary: sal ? { min: sal.minValue ?? null, max: sal.maxValue ?? null, unit: sal.unitText || null } : null,
    matched: TITLE_WEIGHTS.filter(([re]) => re.test(title)).map(([re]) => String(re)).length,
    caution: cautionsIn(desc),
  };
});

// Accumulate across runs: one 60-chunk window is a thirteenth of the index, so
// the published list is the union of recent sweeps rather than whatever this
// run happened to see.
const jobs = { ...store.jobs };
for (const r of rows) {
  if (!r) continue;
  if (jobs[r.url]) stats.refreshed++; else stats.newThisRun++;
  jobs[r.url] = { ...r, lastSeenRun: run };
}

const unseenLimit = 2 * stats.cycleRuns;
for (const [url, j] of Object.entries(jobs)) {
  const posted = Date.parse(j.datePosted || '');
  if (Number.isFinite(posted) && posted < cutoff) { delete jobs[url]; stats.expiredAge++; continue; }
  if (!RENDER_ONLY && run - (j.lastSeenRun ?? run) > unseenLimit) { delete jobs[url]; stats.expiredUnseen++; }
}

const kept = Object.values(jobs)
  .sort((a, b) => b.score - a.score || (b.datePosted || '').localeCompare(a.datePosted || ''));
stats.kept = kept.length;

saveSweepState(SWEEP_STATE, { cursor: nextCursor, run, chunkCount, jobs });
writeFileSync(STORE, JSON.stringify({
  generatedAt: new Date().toISOString(),
  scope: 'Fully remote, US-eligible',
  scoring: 'Tiered target titles (user-supplied) weighted by tier, plus description confirmation; minimum score ' + MIN_SCORE,
  excluded: ['senior/lead/management', 'clinical', 'roles demanding 3+ years experience'],
  maxAgeDays: MAX_AGE_DAYS,
  coverage: {
    mode: 'rotating window with accumulation',
    chunksPerRun: windowChunks.length, chunksTotal: chunkCount,
    runsPerFullCycle: stats.cycleRuns, windowStart: cursor,
  },
  stats, jobs: kept,
}, null, 2));

stats.sampled = sampled.length;
console.log(JSON.stringify(stats, null, 2));
console.log(`\nstore holds ${kept.length} remote roles (+${stats.newThisRun} new this run)\n`);
const flagged = kept.filter(r => r.caution && r.caution.length);
for (const r of kept.slice(0, 40)) {
  const warn = r.caution && r.caution.length ? `  ⚠️  ${r.caution.join(', ')}` : '';
  console.log(`  [${String(r.score).padStart(2)}]  ${r.company} | ${r.title} | ${r.datePosted || '?'}${warn}`);
}
if (flagged.length) {
  console.log(`\n⚠️  ${flagged.length} listing(s) carry predatory-posting signals — shown, not removed, but read the description before applying.`);
}
