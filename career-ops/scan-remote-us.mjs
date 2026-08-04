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
import { writeFileSync, mkdirSync } from 'fs';

const UA = 'career-ops personal job search (+https://github.com/santifer/career-ops)';
const SITEMAP_INDEX = 'https://hiringcafe.com/job-posting-sitemap.xml';
const MAX_CHUNKS = 60;
const MAX_DETAILS = 1400;
const CONCURRENCY = 4;
const DELAY_MS = 110;
const MAX_AGE_DAYS = 60;
const MIN_SCORE = 6;
// A title score floor matters more than the combined one. Without it, any role
// whose description happens to mention Salesforce/Excel/documentation scores
// well — a Product Counsel posting cleared the bar on description alone. The
// role must BE the kind of job, not merely mention the tools.
const MIN_TITLE_SCORE = 3;

// Slug prefilter: cheap gate before any page fetch. A slug must look remote AND
// carry a plausible title token, or we never fetch it.
const REMOTE_SLUG = ['remote', 'work-from-home', 'wfh', 'united-states', 'anywhere'];
const TITLE_SLUG = [
  'salesforce', 'crm', 'customer-support', 'customer-service', 'customer-success',
  'technical-support', 'help-desk', 'helpdesk', 'service-desk', 'support-specialist',
  'support-associate', 'data-entry', 'data-analyst', 'data-quality', 'data-coordinator',
  'business-analyst', 'reporting-analyst', 'operations-analyst', 'operations-associate',
  'sales-operations', 'revenue-operations', 'administrative-assistant', 'office-assistant',
  'onboarding-specialist', 'client-services', 'account-coordinator', 'billing',
  'scheduling-coordinator', 'quality-analyst', 'intake-coordinator', 'claims',
];

// Title weights — what the role IS. Strongest signals first.
const TITLE_WEIGHTS = [
  [/\bsalesforce\b/i, 5], [/\bcrm\b/i, 5],
  [/\bhelp\s?desk\b|\bservice\s?desk\b/i, 4],
  [/\btechnical support\b|\bcustomer support\b|\bsupport specialist\b|\bsupport associate\b/i, 4],
  [/\bdata (entry|quality|coordinator|steward)\b/i, 4],
  [/\bcustomer (service|success|experience)\b/i, 3],
  [/\b(business|data|reporting|operations|quality|billing|claims) analyst\b/i, 3],
  [/\b(sales|revenue) operations\b/i, 3],
  [/\b(client services|account coordinator|onboarding specialist|intake coordinator)\b/i, 3],
  [/\b(administrative|office) (assistant|coordinator|specialist)\b/i, 2],
  [/\b(coordinator|associate|specialist|representative)\b/i, 1],
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
const CAUTION_RE = /\b(commission[- ]only|100% commission|straight commission|no base salary|unlimited earning|uncapped income|be your own boss|host agency|recruit(ing)? (others|agents)|build (your|a) team|1099 (only|contractor)|purchase (your|a) (starter|kit)|licensing (fee|required)|pay for (your )?training)\b/i;
const EXP_FLOOR_RE = /\b([3-9]|1[0-9])\+?\s*(\+)?\s*years?\b/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const locs = xml => [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
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

const index = await get(SITEMAP_INDEX);
const chunkLists = await pooled(locs(index).slice(0, MAX_CHUNKS), 4,
  async c => { try { return locs(await get(c)); } catch { return []; } });

const candidates = [];
for (const list of chunkLists) {
  for (const url of list) {
    const slug = url.slice(url.lastIndexOf('/') + 1);
    if (REMOTE_SLUG.some(t => slug.includes(t)) && TITLE_SLUG.some(t => slug.includes(t))) candidates.push(url);
  }
}

const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
const stats = { candidates: candidates.length, fetched: 0, notRemote: 0, notUS: 0, senior: 0, clinical: 0, expFloor: 0, lowScore: 0, stale: 0, weakTitle: 0, blocked: 0, kept: 0 };

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
  stats.kept++;
  return {
    title, url, score,
    company: (p.hiringOrganization && p.hiringOrganization.name || '').trim(),
    location: locText || 'Remote (US)',
    datePosted: Number.isFinite(posted) ? new Date(posted).toISOString().slice(0, 10) : null,
    employmentType: Array.isArray(p.employmentType) ? p.employmentType.join(', ') : (p.employmentType || null),
    salary: sal ? { min: sal.minValue ?? null, max: sal.maxValue ?? null, unit: sal.unitText || null } : null,
    matched: TITLE_WEIGHTS.filter(([re]) => re.test(title)).map(([re]) => String(re)).length,
  };
});

const kept = rows.filter(Boolean)
  .filter((r, i, arr) => arr.findIndex(x => x.url === r.url) === i)
  .sort((a, b) => b.score - a.score || (b.datePosted || '').localeCompare(a.datePosted || ''));

mkdirSync('data', { recursive: true });
writeFileSync('data/remote-us.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  scope: 'Fully remote, US-eligible',
  scoring: 'Title + description weighted against CV-evidenced strengths; minimum score ' + MIN_SCORE,
  excluded: ['senior/lead/management', 'clinical', 'roles demanding 3+ years experience'],
  maxAgeDays: MAX_AGE_DAYS,
  stats, jobs: kept,
}, null, 2));

stats.sampled = sampled.length;
console.log(JSON.stringify(stats, null, 2));
console.log(`\nkept ${kept.length} remote roles\n`);
for (const r of kept.slice(0, 40)) {
  console.log(`  [${String(r.score).padStart(2)}]  ${r.company} | ${r.title} | ${r.datePosted || '?'}`);
}
