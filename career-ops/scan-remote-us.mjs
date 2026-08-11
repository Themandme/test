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
// ── Eligibility, not just resemblance ────────────────────────────────────────
// The score above measures how much a posting LOOKS like the CV. It says
// nothing about whether the candidate clears the posting's stated bar, and
// those came apart badly: Nordic (4 years) scored 24, Eversheds (5+ years)
// scored 22 and UnitedHealth (5+ years, twice) scored 17, while the one role
// whose entire qualification was "Bachelor's degree" scored 5 and ranked
// second-to-last. Across 31 evaluations the stated years bar — and whether an
// equivalency clause lets education count against it — has been the single
// best predictor of reachability. So it is scored here rather than left to a
// human reading each JD.
//
// There WAS a floor filter, `EXP_FLOOR_RE` against `desc.slice(0, 2500)`. It
// never fired. Company boilerplate occupies the top of most postings, so the
// qualifications section sits past the window: 3446 chars into the Eversheds
// posting, 3978 into UnitedHealth, 5214 into Boise State, 5439 into Nordic.
// All four were missed. That is precisely the blind-spot-not-a-sample defect
// this file's own header describes for the sitemap window, reproduced 200
// lines later against a different corpus.
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// "One to four years" is as common as "1-4 years", and a digits-only pattern
// reads it as no requirement at all.
const spellOut = (t) => String(t || '').replace(
  /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
  (m) => String(WORD_NUM[m.toLowerCase()]));

// A range gates at its LOW end — "2-4 years" needs two, not four.
const YEARS_RE = /(\d{1,2})\s*(?:\+|\s*(?:-|–|to)\s*\d{1,2})?\s*(?:\+\s*)?\s*years?\b/i;
// Education or a mixed background standing in for the years. This is the clause
// that separated Wells Fargo (reachable) from M&T (not), and the one Maryland
// writes as "30 credit hours for each year of the required experience".
const EQUIVALENCY_RE = /\bor\s+equivalent\b|\bequivalent\s+(?:experience|combination|education)\b|\bmay\s+substitute\b|\bcredit\s+hours?\b|\bcombination\s+of\s+education\s+and\s+experience\b/i;
// Years inside a preference are not a gate.
const PREFERRED_RE = /\b(?:preferred|a\s+plus|nice\s+to\s+have|desired|ideally|bonus|would\s+be\s+great)\b/i;
// Section headings that flip everything beneath them into preferences, and back.
const PREF_HEADING_RE = /^\s*(?:preferred|desired|nice[\s-]to[\s-]have|bonus)\b[^.]{0,40}$/i;
const REQ_HEADING_RE = /^\s*(?:required|requirements|minimum|basic|must[\s-]have|qualifications)\b[^.]{0,40}$/i;

/**
 * Lowest number of years the posting genuinely gates on, across the WHOLE
 * description. Returns null when nothing gates on years.
 *
 * Two rules that a naive scan gets backwards:
 *
 *   - **A range gates at its floor.** "2-4 years" is cleared at two.
 *   - **Separate requirements gate at the MAXIMUM.** A posting listing "5+
 *     years analytics", "5+ years governance" and "1+ years AI" requires all
 *     three, so the binding constraint is five. Taking the minimum reads that
 *     posting as reachable at one year, which is how UnitedHealth's Data
 *     Analyst 2 scored 17 and looked open.
 *
 * Preference lines and lines carrying an equivalency clause are not gates, and
 * a "Preferred Qualifications" heading applies to everything beneath it.
 */
export function statedYearsFloor(desc) {
  // Bullets survive the HTML strip as a glyph, and postings use several — •,
  // ●, ▪, ‣, ◦, ·. Splitting on only "•" glued Boise State's whole requirements
  // list into one line, which hid two separate year gates inside it. Sentences
  // are the fallback unit when a posting uses no bullets at all.
  const lines = spellOut(desc)
    .split(/\n|[•●▪‣◦·]|(?<=\.)\s+(?=[A-Z])/)
    .map((l) => l.trim())
    .filter(Boolean);
  let preferredSection = false;
  let gate = null;
  for (const line of lines) {
    if (PREF_HEADING_RE.test(line)) { preferredSection = true; continue; }
    if (REQ_HEADING_RE.test(line)) { preferredSection = false; continue; }
    const m = line.match(YEARS_RE);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n === 0 || n > 25) continue;
    if (preferredSection || PREFERRED_RE.test(line) || EQUIVALENCY_RE.test(line)) continue;
    gate = gate === null ? n : Math.max(gate, n);
  }
  return gate;
}

const YEARS_HELD = 1;
const YEARS_HARD_STOP = 3;
// Weight chosen to matter without dominating: a posting with no stated years
// bar gains roughly what two strong title matches are worth, which is about
// what the evaluation history says it deserves.
const NO_FLOOR_BONUS = 6;
const STRETCH_PENALTY = -4;

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

  // Whole description, not a leading window — see the note on statedYearsFloor.
  const yearsFloor = statedYearsFloor(desc);
  if (yearsFloor !== null && yearsFloor >= YEARS_HARD_STOP) { stats.expFloor++; return null; }

  const titleScore = scoreOf(title, TITLE_WEIGHTS);
  if (titleScore < MIN_TITLE_SCORE) { stats.weakTitle++; return null; }
  if (BLOCKER_RE.test(title) || BLOCKER_RE.test(desc.slice(0, 2500))) { stats.blocked++; return null; }

  // Eligibility adjustment: reward a posting that gates on nothing but a
  // degree, and discount one that asks for more years than are held.
  const eligibility = yearsFloor === null ? NO_FLOOR_BONUS
    : yearsFloor > YEARS_HELD ? STRETCH_PENALTY
      : 0;
  const score = titleScore + scoreOf(desc, DESC_WEIGHTS) + eligibility;
  if (score < MIN_SCORE) { stats.lowScore++; return null; }

  const sal = p.baseSalary && p.baseSalary.value;
  // kept is counted from the store after the merge, not per-row.
  return {
    title, url, score,
    yearsFloor,          // null = no stated years bar; the strongest reachability signal found
    eligibility,         // the adjustment applied, so a score can be explained rather than guessed at
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
  excluded: ['senior/lead/management', 'clinical', 'roles gating on 3+ years with no equivalency clause'],
  // The store accumulates across runs, so after the eligibility signal landed
  // it holds two score scales at once: rows fetched since carry `yearsFloor`
  // and an eligibility adjustment, older rows do not. Ranking across the two is
  // not meaningful, so the split is counted rather than hidden. MAX_AGE_DAYS
  // prunes at 14 days, so this self-heals within a fortnight.
  scoreScale: {
    withEligibility: kept.filter((r) => 'yearsFloor' in r).length,
    legacyResemblanceOnly: kept.filter((r) => !('yearsFloor' in r)).length,
  },
  eligibility: 'Scored, not just filtered: +' + NO_FLOOR_BONUS + ' when no years bar is stated, ' + STRETCH_PENALTY + ' when the stated floor exceeds ' + YEARS_HELD + ' year(s). Equivalency clauses and years inside a preference are not treated as gates.',
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
