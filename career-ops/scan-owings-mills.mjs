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
import { writeFileSync, mkdirSync } from 'fs';

const UA = 'career-ops personal job search (+https://github.com/santifer/career-ops)';
const SITEMAP_INDEX = 'https://hiringcafe.com/job-posting-sitemap.xml';
const MAX_CHUNKS = 60;         // 20k <loc> per chunk; 467 exist (~9.3M postings)
const MAX_DETAILS = 600;
const CONCURRENCY = 4;
const DELAY_MS = 110;
const MAX_AGE_DAYS = 60;

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
  /\bmedic\b/i, /\bdialysis\b/i, /\bphlebot/i, /\bimaging\b/i,
  /\bmri\b/i, /\bx-?ray\b/i, /\bradiograph/i, /\bmedication\b/i,
  /\b(medical|lab|surgical|nuclear|ct)\s+technologist\b/i, /\bultrasound\b/i,
];
const MEDICAL_RE = { test: (t) => MEDICAL_PATTERNS.some(re => re.test(t)) };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const locs = xml => [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());

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

const index = await get(SITEMAP_INDEX);
const chunks = locs(index).slice(0, MAX_CHUNKS);

const candidates = [];
const chunkLists = await pooled(chunks, 4, async (c) => {
  try { return locs(await get(c)); } catch { return []; }
});
for (const list of chunkLists) {
  for (const url of list) {
    const slug = url.slice(url.lastIndexOf('/') + 1);
    if (NEAR.some(t => slug.includes(t))) candidates.push(url);
  }
}

const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
const stats = { candidates: candidates.length, fetched: 0, senior: 0, medical: 0, stale: 0, offArea: 0, kept: 0 };

const rows = await pooled(candidates.slice(0, MAX_DETAILS), CONCURRENCY, async (url) => {
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
  stats.kept++;
  return {
    title, url,
    company: (p.hiringOrganization && p.hiringOrganization.name || '').trim(),
    city, region,
    datePosted: Number.isFinite(posted) ? new Date(posted).toISOString().slice(0, 10) : null,
    employmentType: Array.isArray(p.employmentType) ? p.employmentType.join(', ') : (p.employmentType || null),
    salary: sal ? { min: sal.minValue ?? null, max: sal.maxValue ?? null, unit: sal.unitText || null } : null,
  };
});

const kept = rows.filter(Boolean)
  .filter((r, i, arr) => arr.findIndex(x => x.url === r.url) === i)
  .sort((a, b) => (b.datePosted || '').localeCompare(a.datePosted || ''));

mkdirSync('data', { recursive: true });
writeFileSync('data/owings-mills.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  center: 'Owings Mills, MD 21117',
  radiusNote: '~5 miles, matched by town name (proxy, not geodesic)',
  towns: NEAR,
  excluded: ['senior/lead/management titles', 'medical & clinical titles'],
  maxAgeDays: MAX_AGE_DAYS,
  stats,
  jobs: kept,
}, null, 2));

console.log(JSON.stringify(stats, null, 2));
console.log(`\nkept ${kept.length} local jobs`);
for (const r of kept.slice(0, 60)) {
  const pay = r.salary ? `${r.salary.min ?? '?'}-${r.salary.max ?? '?'}/${(r.salary.unit || '').toLowerCase()}` : 'n/a';
  console.log(`  ${r.datePosted || '?'}  ${r.company} | ${r.title} | ${r.city} | ${pay}`);
}
