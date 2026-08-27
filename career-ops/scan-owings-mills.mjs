// Owings Mills local search — a SEPARATE net from the main analyst/IT pipeline.
//
// Intent: any job within ~10 miles of Owings Mills, MD that Darren could
// plausibly get, excluding senior-level and medical/clinical roles.
//
// Why this is its own script rather than portals.yml config: career-ops has a
// single global title_filter/location_filter pair, and this search deliberately
// inverts the main one — geography-first with a wide-open title net, where the
// main pipeline is title-first and geography-second. Running it separately keeps
// data/pipeline.md (the evaluated analyst/IT funnel) uncontaminated.
//
// Geography note: this matches town names in the posting slug/location. That is
// a proxy for a 10-mile radius, not a geodesic calculation — the towns below were
// chosen as those whose centres sit within roughly 10 miles of Owings Mills 21117.
//
// ---------------------------------------------------------------------------
// COVERAGE (the reason this script has a state file)
//
// hiring.cafe's job sitemap is ~465 chunks of ~20k postings each, and each
// chunk is ~3 MB. Reading all of them is ~1.4 GB per run, which is not a
// reasonable thing to do to a free service twice a day.
//
// The previous version read `chunks.slice(0, 60)` — a fixed 12.9% of the index
// — which looked like a sample but behaved like a blind spot. Area matches are
// spread evenly across the whole index (measured: ~52-59 per 10 chunks at
// positions 0, 55, 200 and 455), so the first 60 chunks are not the newest or
// the nearest; they are simply the first. Postings drift in and out of that
// window when hiring.cafe re-shards, which it does daily — the chunk URLs carry
// a build id and every chunk's <lastmod> is stamped with the current date. Four
// Best Buy openings appeared to be "new" on 2026-08-05 purely because a
// re-shard moved them from chunk ~61 to chunk ~60.
//
// So instead: read a 60-chunk WINDOW that ROTATES each run, and accumulate
// results in a store. Eight runs (four days at twice daily) cover the whole
// index, and the published list is the union of recent sweeps rather than
// whatever the last one happened to see. Bandwidth per run is unchanged.
//
// Two consequences worth knowing:
//   - Entries are dropped when they age past MAX_AGE_DAYS, and also when they
//     have not been re-seen for two full cycles — a filled posting leaves the
//     sitemap, so absence across a whole cycle is the only available signal
//     that it is gone.
//   - The store must survive between runs, so it lives at the repo root next to
//     the digest rather than under data/ (gitignored), and CI commits it.
// ---------------------------------------------------------------------------
import { writeFileSync, mkdirSync } from 'fs';
import { entries, rotatingWindow, loadSweepState, saveSweepState, staleByLastmod } from './sitemap-sweep.mjs';

const UA = 'career-ops personal job search (+https://github.com/santifer/career-ops)';
const SITEMAP_INDEX = 'https://hiringcafe.com/job-posting-sitemap.xml';
const WINDOW_CHUNKS = 60;      // chunks read per run; ~3 MB each
const MAX_DETAILS = 600;
const CONCURRENCY = 4;
const DELAY_MS = 110;
const MAX_AGE_DAYS = 60;
const STORE_PATH = 'owings-mills-store.json';

// Slack on the sitemap's <lastmod> when using it to skip detail fetches.
// lastmod should never precede datePosted, but it is a crawl-side field and a
// cheap week of margin costs a few extra fetches while removing any chance of
// discarding a fresh posting unseen.
const LASTMOD_SLACK_DAYS = 7;

// Towns within ~10 miles of Owings Mills, MD (21117), as slug fragments.
const NEAR = [
  'owings-mills', 'garrison', 'glyndon', 'reisterstown', 'pikesville',
  'randallstown', 'milford-mill', 'windsor-mill', 'stevenson', 'lochearn',
  'finksburg', 'woodstock',
];

// Senior-level titles — excluded. Deliberately NOT excluding manager/supervisor/
// lead outright: this is a "anything to get by" net, and shift supervisor or
// assistant manager roles in retail and food service are realistically gettable.
// Only genuine seniority markers and high roman numerals are cut.
const SENIOR_RE = /\b(senior|sr\.?|staff|principal|director|head\s+of|vp|vice\s+president|chief|architect|executive|iii|iv)\b/i;

// Clinical roles — excluded. Scoped to the WORK being medical, not the employer:
// a hospital cafeteria or housekeeping job is exactly the kind of "get by" work
// wanted here, so industry words (hospital, healthcare) are not disqualifying.
// Non-clinical care roles (Direct Support Professional, Care Manager) are kept
// deliberately — they are entry-accessible and not medical practice.
// Patterns are tested individually rather than as one \b(...)\b group: that
// wrapper silently failed on "E R TECHNICIAN", where the trailing \b could not
// match mid-word after "TECH".
const MEDICAL_PATTERNS = [
  /\bnurs(e|ing)\b/i, /\brn\b/i, /\blpn\b/i, /\bcna\b/i,
  /\bphysician\b/i, /\bsurgeon\b/i, /\bsurgic/i, /\bdentist\b/i, /\bdental\b/i,
  /\bpharmac/i, /\btherapist\b/i, /\btherapy\b/i, /\bradiolog/i, /\bphlebotom/i,
  /\bsonograph/i, /\bhospice\b/i, /\bveterinar/i, /\bpsychiatr/i, /\bparamedic\b/i,
  /\bemt\b/i, /\be\.?\s?r\.?\s+tech/i, /\bmedical\b/i, /\bclinic(al|ian)?\b/i,
  /\bpatient\b/i, /\bpatholog/i, /\bspeech\s+language/i, /\banesthes/i,
  /\boncolog/i, /\bphysical\s+therap/i, /\boccupational\s+therap/i,
  /\bbehavior(al)?\s+techn/i, /\bregistered\s+behavior/i, /\brbt\b/i,
  // ABA clinical practice. The technician-level patterns above missed the
  // credentialled tier entirely, so BCBA roles were being kept.
  /\bbcba\b/i, /\bboard\s+certified\s+behavior/i, /\bbehavior\s+analyst\b/i,
  /\bmedic\b/i, /\bdialysis\b/i, /\bphlebot/i, /\bimaging\b/i,
  /\bmri\b/i, /\bx-?ray\b/i, /\bradiograph/i, /\bmedication\b/i,
  /\b(medical|lab|surgical|nuclear|ct)\s+technologist\b/i, /\bultrasound\b/i,
];
const MEDICAL_RE = { test: (t) => MEDICAL_PATTERNS.some(re => re.test(t)) };

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
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
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k]); await sleep(DELAY_MS); }
  }));
  return out;
}

/* ------------------------------------------------------------------ store */

const store = loadSweepState(STORE_PATH);
// --render-only re-applies the filters and rewrites the digest from the stored
// listings without touching the network. The title filters are applied on read
// as well as on capture (see below), so tightening one takes effect on entries
// already in the store instead of waiting for them to be re-swept.
const RENDER_ONLY = process.argv.includes('--render-only');
const run = RENDER_ONLY ? store.run : store.run + 1;

/* ------------------------------------------------------- rotating sweep */

const chunkEntries = RENDER_ONLY ? [] : entries(await get(SITEMAP_INDEX));
const chunkCount = chunkEntries.length || store.chunkCount || 0;
const { window, cursor, nextCursor } = rotatingWindow(chunkEntries, store.cursor, WINDOW_CHUNKS);
const cycleRuns = Math.max(1, Math.ceil((chunkCount || WINDOW_CHUNKS) / WINDOW_CHUNKS));

const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;

const stats = {
  chunkCount, windowStart: cursor, windowSize: window.length, cycleRuns, run,
  urlsScanned: 0, areaMatches: 0, skippedByLastmod: 0,
  fetched: 0, senior: 0, medical: 0, stale: 0, offArea: 0,
  newThisRun: 0, refreshed: 0, expiredAge: 0, expiredUnseen: 0, refiltered: 0,
  duplicatesCollapsed: 0, kept: 0,
};

const chunkLists = await pooled(window, 4, async (c) => {
  try { return entries(await get(c)); } catch { return []; }
});

const candidates = [];
for (const list of chunkLists) {
  stats.urlsScanned += list.length;
  for (const { loc, lastmod } of list) {
    const slug = loc.slice(loc.lastIndexOf('/') + 1);
    if (!NEAR.some(t => slug.includes(t))) continue;
    stats.areaMatches++;
    // Skip the detail fetch when the sitemap already says the posting has not
    // been touched since before the freshness window. On the previous design
    // 200 of 353 detail fetches were spent on postings the age filter then
    // discarded; this removes most of that.
    if (staleByLastmod(lastmod, cutoff, LASTMOD_SLACK_DAYS)) { stats.skippedByLastmod++; continue; }
    candidates.push(loc);
  }
}

const seen = new Set();
const fresh = candidates.filter(u => !seen.has(u) && seen.add(u)).slice(0, MAX_DETAILS);

const rows = await pooled(fresh, CONCURRENCY, async (url) => {
  let p; try { p = jobPosting(await get(url)); } catch { return null; }
  if (!p || typeof p.title !== 'string') return null;
  stats.fetched++;

  const title = p.title.trim();
  if (SENIOR_RE.test(title)) { stats.senior++; return null; }
  if (MEDICAL_RE.test(title)) { stats.medical++; return null; }

  const posted = Date.parse(p.datePosted || '');
  if (Number.isFinite(posted) && posted < cutoff) { stats.stale++; return null; }

  let loc = p.jobLocation; if (Array.isArray(loc)) loc = loc[0];
  const a = (loc && loc.address) || {};
  const city = (a.addressLocality || '').trim();
  const region = (a.addressRegion || '').trim();
  // Confirm the structured location really is one of the near towns in Maryland —
  // the slug can carry a town name that belongs to the employer, not the job.
  const cityOk = NEAR.some(t => city.toLowerCase().replace(/\s+/g, '-').includes(t));
  const mdOk = /maryland|^md$/i.test(region);
  if (!(cityOk && mdOk)) { stats.offArea++; return null; }

  const sal = p.baseSalary && p.baseSalary.value;
  return {
    title, url,
    company: (p.hiringOrganization && p.hiringOrganization.name || '').trim(),
    city, region,
    datePosted: Number.isFinite(posted) ? new Date(posted).toISOString().slice(0, 10) : null,
    employmentType: Array.isArray(p.employmentType) ? p.employmentType.join(', ') : (p.employmentType || null),
    salary: sal ? { min: sal.minValue ?? null, max: sal.maxValue ?? null, unit: sal.unitText || null } : null,
  };
});

/* ------------------------------------------------------- merge and expire */

const jobs = { ...store.jobs };
for (const r of rows) {
  if (!r) continue;
  if (jobs[r.url]) stats.refreshed++; else stats.newThisRun++;
  jobs[r.url] = { ...r, lastSeenRun: run };
}

// A posting that is filled disappears from the sitemap, so it simply stops
// being re-seen. One full cycle visits every chunk, so surviving two cycles
// without a sighting is the point at which absence is meaningful rather than
// an artefact of which window we happened to read.
const unseenLimit = 2 * cycleRuns;
for (const [url, j] of Object.entries(jobs)) {
  const posted = Date.parse(j.datePosted || '');
  if (Number.isFinite(posted) && posted < cutoff) { delete jobs[url]; stats.expiredAge++; continue; }
  // Only a real sweep can refresh lastSeenRun, so --render-only must never
  // expire on absence — it saw nothing by construction.
  if (!RENDER_ONLY && run - (j.lastSeenRun ?? run) > unseenLimit) { delete jobs[url]; stats.expiredUnseen++; continue; }
  // Re-apply the title filters on read. Capture-time filtering alone would let
  // anything admitted under an older, looser pattern sit in the store forever —
  // which is how nine BCBA roles survived a medical exclusion.
  if (SENIOR_RE.test(j.title) || MEDICAL_RE.test(j.title)) { delete jobs[url]; stats.refiltered++; }
}

// hiring.cafe carries the same opening at several URLs (measured: 88 redundant
// rows across 73 groups in a full sweep). Collapse on employer+title+town and
// keep the newest, so the digest reads as a list of openings rather than a list
// of postings. The store keeps every URL — dedup is a presentation concern, and
// discarding URLs would make them look new again next time they are swept.
const byOpening = new Map();
for (const j of Object.values(jobs)) {
  const k = [j.company, j.title, j.city].join(' ').toLowerCase();
  const prev = byOpening.get(k);
  if (!prev || (j.datePosted || '') > (prev.datePosted || '')) byOpening.set(k, j);
}
stats.duplicatesCollapsed = Object.keys(jobs).length - byOpening.size;

// Put jobs that clearly start at $20+/hour first, followed by ranges that can
// reach $20, unknown-pay jobs, then listings whose published ceiling is below
// $20. Annual/monthly/weekly ranges are normalized to an hourly equivalent.
const hourlyEquivalent = (value, unit) => {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const u = String(unit || '').toLowerCase();
  if (u === 'hour') return Number(value);
  if (u === 'year') return Number(value) / 2080;
  if (u === 'month') return Number(value) * 12 / 2080;
  if (u === 'week') return Number(value) * 52 / 2080;
  return null;
};
const payRank = (salary) => {
  if (!salary) return 2;
  const floor = hourlyEquivalent(salary.min, salary.unit);
  const ceiling = hourlyEquivalent(salary.max, salary.unit);
  if (floor != null && floor >= 20) return 0;
  if (ceiling != null && ceiling >= 20) return 1;
  if (floor == null && ceiling == null) return 2;
  return 3;
};

// User-approved compact scoring profile: Information Systems degree;
// Constellation analytics (SQL, Power BI, Excel, Python, Salesforce, APIs);
// Walmart/Target/Chick-fil-A customer service; seven-day availability.
const ROLE = {
  technical: /\b(data|business|financial|operations|program|project|systems?|application|software|technical|technology|information|reporting|quality assurance|qa|crm|salesforce|power bi|database|support engineer|help desk|service desk|analyst|developer|administrator)\b/i,
  office: /\b(administrative|office|reception|front desk|dispatcher|call center|coordinator|specialist|assistant|customer service|customer experience|guest services?|service advisor)\b/i,
  frontline: /\b(cashier|retail|sales associate|team member|crew member|hospitality|food service|server|cook|stock|merchandis|warehouse|deli|produce|grocery|valet)\b/i,
  credential: /\b(cdl|driver|electrician|hvac|plumber|machinist|mechanic|engineer|teacher|counselor|social worker|security officer|armed|inspector|technologist)\b/i,
  leadership: /\b(manager|supervisor|director|lead|general manager|site manager)\b/i,
};
const clamp = n => Math.max(0, Math.min(100, Math.round(n)));
const scoreJob = (job) => {
  const t = job.title || '';
  const technical = ROLE.technical.test(t);
  const office = ROLE.office.test(t);
  const frontline = ROLE.frontline.test(t);
  const credential = ROLE.credential.test(t);
  const leadership = ROLE.leadership.test(t);
  let qualification = technical ? 80 : office ? 86 : frontline ? 90 : 62;
  let interview = technical ? 70 : office ? 82 : frontline ? 88 : 58;
  let careerValue = technical ? 92 : office ? 70 : frontline ? 42 : 50;
  let overqualificationRisk = frontline ? 28 : office ? 15 : technical ? 5 : 18;
  let resume = technical ? 'Professional' : (office || frontline ? 'Customer service' : 'Review');
  if (credential) {
    qualification -= 35; interview -= 30; careerValue -= 15; resume = 'Review';
  }
  if (leadership) {
    qualification -= 22; interview -= 20;
    if (!technical) careerValue += 5;
  }
  const tier = payRank(job.salary);
  const payScore = [100, 78, 52, 28][tier];
  qualification = clamp(qualification);
  interview = clamp(interview);
  careerValue = clamp(careerValue);
  overqualificationRisk = clamp(overqualificationRisk);
  const overall = clamp(
    qualification * 0.30 + interview * 0.25 + payScore * 0.20 +
    careerValue * 0.20 + (100 - overqualificationRisk) * 0.05
  );
  const flags = [];
  if (credential) flags.push('credential/skill check');
  if (leadership) flags.push('leadership experience check');
  if (tier === 2) flags.push('pay undisclosed');
  if (tier === 3) flags.push('published pay below $20');
  return {
    overall, qualification, interview, pay: payScore, careerValue,
    overqualificationRisk, resume,
    confidence: 'preliminary — title/pay metadata', flags,
  };
};
const kept = [...byOpening.values()]
  .map(j => ({ ...j, fit: scoreJob(j) }))
  .sort((a, b) =>
    b.fit.overall - a.fit.overall
    || payRank(a.salary) - payRank(b.salary)
    || (b.datePosted || '').localeCompare(a.datePosted || '')
  );
stats.kept = kept.length;

saveSweepState(STORE_PATH, { cursor: nextCursor, run, chunkCount, cycleRuns, jobs });

mkdirSync('data', { recursive: true });
writeFileSync('data/owings-mills.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  center: 'Owings Mills, MD 21117',
  radiusNote: '~10 miles, matched by town name (proxy, not geodesic)',
  payPriority: 'Published ranges starting at $20+/hr first; then ranges reaching $20; unknown pay; below $20',
  fitScoring: '0-100 preliminary metadata score: qualification, interview likelihood, pay, career value, overqualification risk',
  towns: NEAR,
  excluded: ['senior/lead/management titles', 'medical & clinical titles'],
  maxAgeDays: MAX_AGE_DAYS,
  coverage: {
    mode: 'rotating window with accumulation',
    chunksPerRun: window.length,
    chunksTotal: chunkCount,
    runsPerFullCycle: cycleRuns,
    windowStart: cursor,
  },
  stats,
  jobs: kept,
}, null, 2));

// Human-readable digest at a NON-gitignored path, so scheduled CI runs can
// commit it and the results are viewable without running anything locally.
const byTown = new Map();
for (const j of kept) {
  if (!byTown.has(j.city)) byTown.set(j.city, []);
  byTown.get(j.city).push(j);
}
const pay = s => {
  if (!s || (s.min == null && s.max == null)) return '—';
  const u = (s.unit || '').toLowerCase();
  const f = v => v == null ? '?' : (u === 'year' ? '$' + Math.round(v / 1000) + 'k' : '$' + v);
  return (s.min === s.max ? f(s.min) : `${f(s.min)}–${f(s.max)}`) + (u === 'hour' ? '/hr' : '');
};
const md = [
  '# Jobs near Owings Mills, MD',
  '',
  `_Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${kept.length} openings within ~10 miles · posted in the last ${MAX_AGE_DAYS} days_`,
  '',
  'Any job that is realistically gettable as stopgap work. Senior-level and clinical/medical titles are excluded; non-clinical care roles are kept. Within each town, jobs with published pay starting at $20+/hour are listed first, followed by ranges that can reach $20, unknown-pay roles, and lower-paying roles.',
  '',
  `Coverage: each run reads ${window.length} of ${chunkCount} sitemap chunks, rotating, so a full pass takes ${cycleRuns} runs (~${(cycleRuns / 2).toFixed(1)} days at twice daily). Listings accumulate across runs and drop out once they age past ${MAX_AGE_DAYS} days or go unseen for two full passes.`,
  '',
];
md.push('## Best matches overall', '', '| Score | Employer | Role | Pay | Resume | Flags |', '|---:|---|---|---|---|---|');
for (const j of kept.slice(0, 40)) {
  const title = j.title.replace(/\|/g, '\\|');
  md.push(`| ${j.fit.overall} | ${j.company.replace(/\|/g, '\\|')} | [${title}](${j.url}) | ${pay(j.salary)} | ${j.fit.resume} | ${j.fit.flags.join('; ') || '—'} |`);
}
md.push('');
for (const [town, jobs] of [...byTown].sort((a, b) => b[1].length - a[1].length)) {
  md.push(`## ${town} (${jobs.length})`, '', '| Score | Employer | Role | Pay | Resume | Posted |', '|---:|---|---|---|---|---|');
  for (const j of jobs) {
    const title = j.title.replace(/\|/g, '\\|');
    md.push(`| ${j.fit.overall} | ${j.company.replace(/\|/g, '\\|')} | [${title}](${j.url}) | ${pay(j.salary)} | ${j.fit.resume} | ${j.datePosted || '—'} |`);
  }
  md.push('');
}
writeFileSync('owings-mills-latest.md', md.join('\n'));

console.log(JSON.stringify(stats, null, 2));
console.log(window.length
  ? `\nwindow ${cursor}..${(cursor + window.length - 1) % chunkCount} of ${chunkCount} chunks · run ${run} · full pass every ${cycleRuns} runs`
  : `\nrender-only from stored state · run ${run} · ${chunkCount} chunks · full pass every ${cycleRuns} runs`);
console.log(`store now holds ${kept.length} local jobs (+${stats.newThisRun} new, -${stats.expiredAge + stats.expiredUnseen} expired)`);
