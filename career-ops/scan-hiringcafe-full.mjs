import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOME = 'https://hiringcafe.com/';
const CENTER = { lat: 39.41955, lon: -76.78025 };
const RADIUS_MILES = 10;
const MAX_AGE_DAYS = 60;
const MAX_PAGES = 400;
const PAGE_CONCURRENCY = 4;
const STORE_PATH = 'owings-mills-store.json';
const UA = 'Mozilla/5.0 (compatible; career-ops personal job search; +https://github.com/Themandme/test)';

const HARD_SENIOR_RE = /\b(?:senior|sr\.?|principal|director|head\s+of|(?:a|s|e)?vp|vice\s+president|chief|c-?suite|architect|executive|president|iii|iv|v|vi|vii)\b/i;
const STAFF_TECH_RE = /\bstaff\s+(?:(?:software|data|systems?|technical|information|security|cloud|network|machine\s+learning|ml|ai|product)\s+)*(?:engineer|developer|scientist|architect)\b/i;
const SENIOR_CONTEXT_RE = /\bsenior\s+(?:living|care|community|services?|companion|citizen)\b/gi;
const EXEC_ASSISTANT_RE = /\bexecutive\s+(?:administrative\s+)?assistant\b/gi;
const FRONTLINE_LEADERSHIP_RE = /\b(?:assistant|associate)\s+(?:(?:store|department|restaurant)\s+)?manager\b|\b(?:shift|team|crew|front[- ]?end|department|retail|food(?:\s+service)?|stock(?:ing)?(?:\s+team)?|warehouse)\s+(?:lead(?:er)?|supervisor|manager)\b|\b(?:lead|head)\s+(?:cashier|associate|team\s+member|crew\s+member|server|cook|barista|stock(?:ing)?|warehouse)\b/i;
const MEDICAL_PATTERNS = [
  /\bnurs(e|ing)\b/i, /\brn\b/i, /\blpn\b/i, /\bcna\b/i, /\bphysician\b/i,
  /\bsurgeon\b/i, /\bsurgic/i, /\bdentist\b/i, /\bdental\b/i, /\bpharmac/i,
  /\btherapist\b/i, /\btherapy\b/i, /\bradiolog/i, /\bphlebotom/i, /\bsonograph/i,
  /\bhospice\b/i, /\bveterinar/i, /\bpsychiatr/i, /\bparamedic\b/i, /\bemt\b/i,
  /\be\.?\s?r\.?\s+tech/i, /\bmedical\b/i, /\bclinic(al|ian)?\b/i, /\bpatient\b/i,
  /\bpatholog/i, /\bspeech\s+language/i, /\banesthes/i, /\boncolog/i,
  /\bphysical\s+therap/i, /\boccupational\s+therap/i, /\bbehavior(al)?\s+techn/i,
  /\bregistered\s+behavior/i, /\brbt\b/i, /\bbcba\b/i,
  /\bboard\s+certified\s+behavior/i, /\bbehavior\s+analyst\b/i, /\bmedic\b/i,
  /\bbehavior(?:al)?\s+(?:assistant|specialist|consultant|coach|aide)\b/i,
  /\bdialysis\b/i, /\bimaging\b/i, /\bmri\b/i, /\bx-?ray\b/i, /\bradiograph/i,
  /\bmedication\b/i, /\b(medical|lab|surgical|nuclear|ct)\s+technologist\b/i,
  /\bultrasound\b/i,
];

const ROLE = {
  technical: /\b(data|business|financial|operations|program|project|systems?|application|software|technical|technology|information|reporting|quality assurance|qa|crm|salesforce|power bi|database|support engineer|help desk|service desk|analyst|developer|administrator)\b/i,
  office: /\b(administrative|office|reception|front desk|dispatcher|call center|coordinator|specialist|assistant|customer service|customer experience|guest services?|service advisor)\b/i,
  frontline: /\b(cashier|retail|sales associate|team member|crew member|hospitality|food service|server|cook|stock|merchandis|warehouse|deli|produce|grocery|valet)\b/i,
  credential: /\b(cdl|driver|electrician|hvac|plumber|machinist|mechanic|engineer|teacher|counselor|social worker|security officer|armed|inspector|technologist)\b/i,
  leadership: /\b(manager|supervisor|lead|leader|general manager|site manager)\b/i,
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const clamp = n => Math.max(0, Math.min(100, Math.round(n)));
const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

export function milesBetween(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const q = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function isSenior(hit, title) {
  const stripped = title.replace(SENIOR_CONTEXT_RE, '').replace(EXEC_ASSISTANT_RE, 'assistant');
  if (HARD_SENIOR_RE.test(stripped) || STAFF_TECH_RE.test(stripped)) return true;
  if (FRONTLINE_LEADERSHIP_RE.test(title)) return false;
  const v = hit.v5_processed_job_data || {};
  if (/senior|executive/i.test(v.seniority_level || '')) return true;
  if ((v.min_management_and_leadership_yoe ?? 0) >= 2) return true;
  if ((v.min_industry_and_role_yoe ?? 0) >= 5) return true;
  return false;
}

function salaryFrom(v) {
  // HiringCafe also calculates estimated compensation. Only label and rank pay
  // when the employer's posting actually disclosed it.
  if (v.is_compensation_transparent !== true) return null;
  const frequency = String(v.listed_compensation_frequency || '').toLowerCase();
  const map = {
    hourly: ['hourly_min_compensation', 'hourly_max_compensation', 'HOUR'],
    yearly: ['yearly_min_compensation', 'yearly_max_compensation', 'YEAR'],
    monthly: ['monthly_min_compensation', 'monthly_max_compensation', 'MONTH'],
    weekly: ['weekly_min_compensation', 'weekly_max_compensation', 'WEEK'],
    daily: ['daily_min_compensation', 'daily_max_compensation', 'DAY'],
  };
  let spec = map[frequency];
  if (!spec && (v.hourly_min_compensation != null || v.hourly_max_compensation != null)) {
    spec = ['hourly_min_compensation', 'hourly_max_compensation', 'HOUR'];
  }
  if (!spec) return null;
  const min = Number(v[spec[0]]);
  const max = Number(v[spec[1]]);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null;
  return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null, unit: spec[2] };
}

export function normalizeHit(hit, now = Date.now()) {
  if (!hit || hit.is_expired) return { reason: 'expired' };
  const v = hit.v5_processed_job_data || {};
  const title = String(hit.job_information?.title || v.core_job_title || '').trim();
  if (!title) return { reason: 'invalid' };
  if (isSenior(hit, title)) return { reason: 'senior' };
  if (MEDICAL_PATTERNS.some(re => re.test(title))) return { reason: 'medical' };

  const points = (Array.isArray(hit._geoloc) ? hit._geoloc : [hit._geoloc])
    .filter(p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
    .map(p => ({ lat: Number(p.lat), lon: Number(p.lon) }));
  if (!points.length) return { reason: 'noCoordinates' };
  let nearestIndex = 0;
  let miles = Infinity;
  points.forEach((point, index) => {
    const distance = milesBetween(CENTER, point);
    if (distance < miles) { miles = distance; nearestIndex = index; }
  });
  if (miles > RADIUS_MILES + 0.05) return { reason: 'offArea' };

  const postedMs = Number(v.estimated_publish_date_millis) || Date.parse(v.estimated_publish_date || '');
  if (Number.isFinite(postedMs) && postedMs < now - MAX_AGE_DAYS * 86400000) return { reason: 'stale' };
  const locations = Array.isArray(v.workplace_cities) ? v.workplace_cities : [];
  const city = String(locations[nearestIndex] || locations[0] || v.formatted_workplace_location || 'Near Owings Mills').split(',')[0].trim();
  const company = String(v.company_name || hit.attributed_org?.name || hit.enriched_company_data?.name || '').trim();
  const id = String(hit.objectID || hit.id || hit.requisition_id || '').trim();
  const url = String(hit.apply_url || '').trim() || `https://hiringcafe.com/job/${slug(title)}-${slug(company)}-${slug(city)}-${slug(hit.requisition_id || id)}`;
  return {
    reason: null,
    job: {
      title, url, company, city, region: 'Maryland', miles: Math.round(miles * 10) / 10,
      datePosted: Number.isFinite(postedMs) ? new Date(postedMs).toISOString().slice(0, 10) : null,
      employmentType: Array.isArray(v.commitment) ? v.commitment.join(', ') : null,
      salary: salaryFrom(v),
      sourceId: id || url,
      seniority: v.seniority_level || null,
      minYearsExperience: Number.isFinite(Number(v.min_industry_and_role_yoe)) ? Number(v.min_industry_and_role_yoe) : null,
      requirementsSummary: v.requirements_summary || null,
    },
  };
}

function searchState() {
  return {
    defaultToUserLocation: false,
    locations: [{
      formatted_address: 'Owings Mills, MD, USA',
      types: ['locality'],
      geometry: { location: CENTER },
      id: 'owings_mills_md',
      address_components: [
        { long_name: 'Owings Mills', short_name: 'Owings Mills', types: ['locality'] },
        { long_name: 'Maryland', short_name: 'MD', types: ['administrative_area_level_1'] },
        { long_name: 'United States', short_name: 'US', types: ['country'] },
      ],
      workplace_types: [],
      options: { radius: RADIUS_MILES, radius_unit: 'miles', ignore_radius: false },
    }],
    dateFetchedPastNDays: MAX_AGE_DAYS,
    sortBy: 'date',
  };
}

async function fetchJson(url, attempts = 4) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', 'x-nextjs-data': '1' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (caught) {
      error = caught;
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`HiringCafe request failed after ${attempts} attempts: ${url} (${error})`);
}

async function buildId() {
  const response = await fetch(HOME, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!response.ok) throw new Error(`HiringCafe homepage HTTP ${response.status}`);
  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('HiringCafe homepage did not contain __NEXT_DATA__');
  const id = JSON.parse(match[1]).buildId;
  if (!id) throw new Error('HiringCafe __NEXT_DATA__ had no buildId');
  return id;
}

async function fetchPage(id, state, page) {
  const url = `${HOME}_next/data/${id}/index.json?searchState=${encodeURIComponent(JSON.stringify(state))}&page=${page}`;
  const props = (await fetchJson(url)).pageProps;
  if (!props || props.ssrError) throw new Error(`HiringCafe page ${page} error: ${props?.ssrError || 'missing pageProps'}`);
  if (!Array.isArray(props.ssrHits)) throw new Error(`HiringCafe page ${page} had no ssrHits array`);
  return props;
}

async function pooled(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index]);
    }
  }));
  return output;
}

function payRank(salary) {
  if (!salary) return 2;
  const factors = { HOUR: 1, YEAR: 1 / 2080, MONTH: 12 / 2080, WEEK: 52 / 2080, DAY: 260 / 2080 };
  const factor = factors[salary.unit] ?? null;
  if (!factor) return 2;
  const floor = salary.min == null ? null : salary.min * factor;
  const ceiling = salary.max == null ? null : salary.max * factor;
  if (floor != null && floor >= 20) return 0;
  if (ceiling != null && ceiling >= 20) return 1;
  return 3;
}

function scoreJob(job) {
  const t = job.title || '';
  const technical = ROLE.technical.test(t);
  const office = ROLE.office.test(t);
  const frontlineLeadership = FRONTLINE_LEADERSHIP_RE.test(t);
  const frontline = ROLE.frontline.test(t) || frontlineLeadership;
  const credential = ROLE.credential.test(t);
  const leadership = ROLE.leadership.test(t);
  let qualification = technical ? 80 : office ? 86 : frontline ? 90 : 62;
  let interview = technical ? 70 : office ? 82 : frontline ? 88 : 58;
  let careerValue = technical ? 92 : office ? 70 : frontline ? 42 : 50;
  const overqualificationRisk = frontline ? 28 : office ? 15 : technical ? 5 : 18;
  let resume = technical ? 'Professional' : (office || frontline ? 'Customer service' : 'Review');
  if (credential) { qualification -= 35; interview -= 30; careerValue -= 15; resume = 'Review'; }
  if (leadership) { qualification -= frontlineLeadership ? 8 : 22; interview -= frontlineLeadership ? 7 : 20; }
  if ((job.minYearsExperience ?? 0) >= 4) { qualification -= 18; interview -= 15; }
  const tier = payRank(job.salary);
  const payScore = [100, 78, 52, 28][tier];
  const overall = clamp(clamp(qualification) * .30 + clamp(interview) * .25 + payScore * .20 + clamp(careerValue) * .20 + (100 - overqualificationRisk) * .05);
  const flags = [];
  if (credential) flags.push('credential/skill check');
  if (leadership) flags.push(frontlineLeadership ? 'frontline leadership check' : 'leadership experience check');
  if ((job.minYearsExperience ?? 0) >= 4) flags.push(`${job.minYearsExperience}+ years requested`);
  if (tier === 2) flags.push('pay undisclosed');
  if (tier === 3) flags.push('published pay below $20');
  return { overall, qualification: clamp(qualification), interview: clamp(interview), pay: payScore, careerValue: clamp(careerValue), overqualificationRisk, resume, confidence: 'structured title/pay/experience metadata', flags };
}

function payText(salary) {
  if (!salary) return '—';
  const suffix = { HOUR: '/hr', YEAR: '/yr', MONTH: '/mo', WEEK: '/wk', DAY: '/day' }[salary.unit] || '';
  const format = value => value == null ? '?' : `$${Math.round(value * 100) / 100}`;
  return `${salary.min === salary.max ? format(salary.min) : `${format(salary.min)}–${format(salary.max)}`}${suffix}`;
}

export async function main() {
  const startedAt = Date.now();
  const id = await buildId();
  const state = searchState();
  const first = await fetchPage(id, state, 0);
  const total = Number(first.ssrTotalCount);
  const pageSize = Number(first.ssrPageSize);
  if (!Number.isFinite(total) || !Number.isFinite(pageSize) || pageSize < 1) throw new Error('HiringCafe returned invalid pagination metadata');
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount > MAX_PAGES) throw new Error(`HiringCafe requested ${pageCount} pages, above safety cap ${MAX_PAGES}`);
  const remaining = Array.from({ length: pageCount - 1 }, (_, index) => index + 1);
  console.log(`HiringCafe structured search: ${total} result groups across ${pageCount} pages`);
  const pages = [first, ...(await pooled(remaining, PAGE_CONCURRENCY, async page => {
    const props = await fetchPage(id, state, page);
    if (page % 20 === 0 || page === pageCount - 1) console.log(`Fetched page ${page + 1}/${pageCount}`);
    return props;
  }))];
  if (pages.length !== pageCount) throw new Error(`HiringCafe completeness check failed: ${pages.length}/${pageCount} pages`);

  const hits = new Map();
  for (const page of pages) for (const hit of page.ssrHits) hits.set(hit.objectID || hit.id || JSON.stringify(hit), hit);
  const stats = { mode: 'structured full-radius search', radiusMiles: RADIUS_MILES, buildId: id, resultGroups: total, pagesExpected: pageCount, pagesFetched: pages.length, rawHits: hits.size, expired: 0, senior: 0, medical: 0, noCoordinates: 0, offArea: 0, stale: 0, invalid: 0, duplicatesCollapsed: 0, kept: 0, payStartsAt20: 0, payReaches20: 0, payUnknown: 0, payBelow20: 0, durationSeconds: 0 };
  const jobsBySource = new Map();
  for (const hit of hits.values()) {
    const normalized = normalizeHit(hit);
    if (normalized.reason) { stats[normalized.reason] = (stats[normalized.reason] || 0) + 1; continue; }
    jobsBySource.set(normalized.job.sourceId, normalized.job);
  }
  const byOpening = new Map();
  for (const job of jobsBySource.values()) {
    const key = [job.company, job.title, job.city].join('\0').toLowerCase();
    const previous = byOpening.get(key);
    if (!previous || (job.datePosted || '') > (previous.datePosted || '')) byOpening.set(key, job);
  }
  stats.duplicatesCollapsed = jobsBySource.size - byOpening.size;
  const kept = [...byOpening.values()].map(job => ({ ...job, fit: scoreJob(job) })).sort((a, b) => payRank(a.salary) - payRank(b.salary) || b.fit.overall - a.fit.overall || (b.datePosted || '').localeCompare(a.datePosted || ''));
  for (const job of kept) [['payStartsAt20', 0], ['payReaches20', 1], ['payUnknown', 2], ['payBelow20', 3]].forEach(([key, rank]) => { if (payRank(job.salary) === rank) stats[key] += 1; });
  stats.kept = kept.length;
  stats.durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (total > 0 && hits.size === 0) throw new Error('HiringCafe returned nonzero total but zero hits');

  let prior = { run: 0 };
  try { prior = JSON.parse(readFileSync(STORE_PATH, 'utf8')); } catch {}
  const run = Number(prior.run || 0) + 1;
  const storedJobs = Object.fromEntries(kept.map(job => [job.sourceId, { ...job, lastSeenRun: run }]));
  writeFileSync(STORE_PATH, JSON.stringify({ note: 'Complete HiringCafe structured search within an exact 10-mile radius.', updatedAt: new Date().toISOString(), cursor: 0, run, chunkCount: 0, cycleRuns: 1, jobs: storedJobs, lastCompleteSearch: { buildId: id, pages: pageCount, resultGroups: total } }, null, 2));

  mkdirSync('data', { recursive: true });
  writeFileSync('data/owings-mills.json', JSON.stringify({ generatedAt: new Date().toISOString(), center: 'Owings Mills, MD 21117', radiusNote: 'Exact 10-mile HiringCafe radius, independently verified with posting coordinates', payPriority: '$20+/hour-equivalent listings first', excluded: ['senior/executive or 5+ year roles', 'medical and clinical titles'], maxAgeDays: MAX_AGE_DAYS, coverage: { mode: stats.mode, pagesFetched: pages.length, pagesExpected: pageCount, complete: pages.length === pageCount }, stats, jobs: kept }, null, 2));

  const md = ['# Jobs near Owings Mills, MD', '', `_Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${kept.length} openings within an exact 10-mile radius · last ${MAX_AGE_DAYS} days_`, '', `Complete HiringCafe structured search: ${pages.length}/${pageCount} pages fetched. Jobs starting at $20+/hour equivalent are shown first. Senior/executive, 5+ year, and clinical titles are excluded.`, '', '## Best matches overall', '', '| Score | Distance | Employer | Role | Pay | Resume | Flags |', '|---:|---:|---|---|---|---|---|'];
  for (const job of kept) md.push(`| ${job.fit.overall} | ${job.miles} mi | ${job.company.replace(/\|/g, '\\|')} | [${job.title.replace(/\|/g, '\\|')}](${job.url}) | ${payText(job.salary)} | ${job.fit.resume} | ${job.fit.flags.join('; ') || '—'} |`);
  writeFileSync('owings-mills-latest.md', md.join('\n'));
  console.log(JSON.stringify(stats, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
