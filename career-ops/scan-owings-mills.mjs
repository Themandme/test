// Owings Mills local search — a SEPARATE net from the main analyst/IT pipeline.
//
// Intent: any job within ~5 miles of Owings Mills, MD that Darren could
// plausibly get, excluding senior-level and medical/clinical roles.
//
// Why this is its own script rather than portals.yml config: career-ops has a
// single global title_filter/location_filter pair, and this search deliberately
// inverts the main one — geography-first with a wide-open title net, where the
// main pipeline is title-first and geography-second. Running it separately keeps
// data/pipeline.md (the evaluated analyst/IT funnel) uncontaminated.
//
// Geography note: this matches town names in the posting slug/location. That is
// a proxy for a 5-mile radius, not a geodesic calculation — the towns below were
// chosen as those whose centres sit within roughly 5 miles of Owings Mills 21117.
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
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';

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

// Towns within ~5 miles of Owings Mills, MD (21117), as slug fragments.
const NEAR = [
  'owings-mills', 'garrison', 'glyndon', 'reisterstown', 'pikesville',
  'randallstown', 'milford-mill', 'windsor-mill', 'stevenson', 'lochearn',
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
const locs = xml => [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());

// <url>/<sitemap> entries carrying both fields. Matched as blocks rather than
// two independent <loc>/<lastmod> scans so a missing lastmod cannot shift the
// pairing and attach one entry's date to the next entry's URL.
function entries(xml) {
  const out = [];
  for (const [, block] of String(xml).matchAll(/<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/g)) {
    const loc = (block.match(/<loc>([^<]+)<\/loc>/) || [])[1];
    if (!loc) continue;
    const lastmod = (block.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1];
    out.push({ loc: loc.trim(), lastmod: lastmod ? lastmod.trim() : null });
  }
  return out;
}

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

function loadStore() {
  if (!existsSync(STORE_PATH)) return { cursor: 0, run: 0, jobs: {} };
  try {
    const s = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    // chunkCount must survive the round trip: --render-only has no sitemap to
    // count, and a zero here collapses cycleRuns to 1, which shrinks the
    // unseen-expiry horizon to two runs and deletes most of the store.
    return { cursor: s.cursor || 0, run: s.run || 0, chunkCount: s.chunkCount || 0, jobs: s.jobs || {} };
  } catch {
    // A corrupt store costs one cycle to rebuild, which is strictly better than
    // failing the run and leaving the digest frozen.
    return { cursor: 0, run: 0, jobs: {} };
  }
}

const store = loadStore();
// --render-only re-applies the filters and rewrites the digest from the stored
// listings without touching the network. The title filters are applied on read
// as well as on capture (see below), so tightening one takes effect on entries
// already in the store instead of waiting for them to be re-swept.
const RENDER_ONLY = process.argv.includes('--render-only');
const run = RENDER_ONLY ? store.run : store.run + 1;

/* ------------------------------------------------------- rotating sweep */

const chunkEntries = RENDER_ONLY ? [] : entries(await get(SITEMAP_INDEX));
const chunkCount = chunkEntries.length || store.chunkCount || 0;
const cursor = chunkEntries.length ? store.cursor % chunkEntries.length : (store.cursor || 0);
const cycleRuns = Math.max(1, Math.ceil((chunkCount || WINDOW_CHUNKS) / WINDOW_CHUNKS));

// Wrap around the end of the index rather than clamping, so the window keeps a
// constant size and every chunk is visited once per cycle.
const window = [];
for (let k = 0; k < Math.min(WINDOW_CHUNKS, chunkEntries.length); k++) {
  window.push(chunkEntries[(cursor + k) % chunkEntries.length].loc);
}
const nextCursor = chunkEntries.length ? (cursor + window.length) % chunkEntries.length : cursor;

const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
const lastmodCutoff = cutoff - LASTMOD_SLACK_DAYS * 86400000;

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
    const lm = lastmod ? Date.parse(lastmod) : NaN;
    if (Number.isFinite(lm) && lm < lastmodCutoff) { stats.skippedByLastmod++; continue; }
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

const kept = [...byOpening.values()].sort((a, b) => (b.datePosted || '').localeCompare(a.datePosted || ''));
stats.kept = kept.length;

writeFileSync(STORE_PATH, JSON.stringify({
  note: 'Rotating-window sweep state for scan-owings-mills.mjs. Committed so scheduled runs accumulate coverage; safe to delete, costs one cycle to rebuild.',
  updatedAt: new Date().toISOString(),
  cursor: nextCursor, run, chunkCount, cycleRuns, jobs,
}, null, 2));

mkdirSync('data', { recursive: true });
writeFileSync('data/owings-mills.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  center: 'Owings Mills, MD 21117',
  radiusNote: '~5 miles, matched by town name (proxy, not geodesic)',
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
  `_Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${kept.length} openings within ~5 miles · posted in the last ${MAX_AGE_DAYS} days_`,
  '',
  'Any job that is realistically gettable as stopgap work. Senior-level and clinical/medical titles are excluded; non-clinical care roles are kept.',
  '',
  `Coverage: each run reads ${window.length} of ${chunkCount} sitemap chunks, rotating, so a full pass takes ${cycleRuns} runs (~${(cycleRuns / 2).toFixed(1)} days at twice daily). Listings accumulate across runs and drop out once they age past ${MAX_AGE_DAYS} days or go unseen for two full passes.`,
  '',
];
for (const [town, jobs] of [...byTown].sort((a, b) => b[1].length - a[1].length)) {
  md.push(`## ${town} (${jobs.length})`, '', '| Employer | Role | Pay | Posted |', '|---|---|---|---|');
  for (const j of jobs) {
    const title = j.title.replace(/\|/g, '\\|');
    md.push(`| ${j.company.replace(/\|/g, '\\|')} | [${title}](${j.url}) | ${pay(j.salary)} | ${j.datePosted || '—'} |`);
  }
  md.push('');
}
writeFileSync('owings-mills-latest.md', md.join('\n'));

console.log(JSON.stringify(stats, null, 2));
console.log(window.length
  ? `\nwindow ${cursor}..${(cursor + window.length - 1) % chunkCount} of ${chunkCount} chunks · run ${run} · full pass every ${cycleRuns} runs`
  : `\nrender-only from stored state · run ${run} · ${chunkCount} chunks · full pass every ${cycleRuns} runs`);
console.log(`store now holds ${kept.length} local jobs (+${stats.newThisRun} new, -${stats.expiredAge + stats.expiredUnseen} expired)`);
