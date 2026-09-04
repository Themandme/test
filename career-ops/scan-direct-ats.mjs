// Location-first scan of official non-Workday ATS boards near Owings Mills.
//
// HiringCafe is useful for discovering employers, but it is not a dependable
// scheduled dependency: its Cloudflare policy can reject GitHub-hosted runners.
// This scanner queries the employers' public ATS endpoints directly through
// career-ops' existing provider modules and keeps source failures explicit.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(ROOT, 'direct-ats-store.json');
const MAX_AGE_DAYS = 60;
const MAX_FAILED_REFRESH_RUNS = 3;
const BOARD_CONCURRENCY = 4;

// Town-centre proxy used by the pre-existing local scanners. Boards that only
// expose a city name cannot support a geodesic check, so rows are clearly
// labelled as a proxy rather than an exact coordinate-verified radius.
const CORE_LOCATION_RE = /\b(owings mills|garrison|glyndon|reisterstown|pikesville|randallstown|milford mill|windsor mill|stevenson|lochearn|finksburg|woodstock)\b/i;
const HARD_SENIOR_RE = /\b(?:senior|sr\.?|principal|director|head\s+of|(?:a|s|e)?vp|vice\s+president|chief|c-?suite|architect|executive|president|iii|iv|v|vi|vii)\b/i;
const STAFF_TECH_RE = /\bstaff\s+(?:(?:software|data|systems?|technical|information|security|cloud|network|machine\s+learning|ml|ai|product)\s+)*(?:engineer|developer|scientist|architect)\b/i;
const SENIOR_CONTEXT_RE = /\bsenior\s+(?:living|care|community|services?|companion|citizen)\b/gi;
const EXEC_ASSISTANT_RE = /\bexecutive\s+(?:administrative\s+)?assistant\b/gi;
const MEDICAL_RE = /\b(?:nurs(?:e|ing)|rn|lpn|cna|physician|surgeon|surgical|dentist|dental|pharmac(?:y|ist|ology)|therapist|therapy|radiolog(?:y|ist|ic)|phlebotom(?:y|ist)|sonograph(?:y|er)|hospice|veterinar(?:y|ian)|psychiatr(?:y|ist|ic)|paramedic|emt|medical|clinical|patient|patholog(?:y|ist)|anesthes(?:ia|iologist)|oncolog(?:y|ist)|behavioral technician|registered behavior|rbt|bcba|dialysis|mri|x-?ray|ultrasound)\b/i;

// Seeded from employers represented in the last successful local HiringCafe
// snapshot. These are board roots, not copied postings; every run asks the
// employer's official ATS for its current inventory.
export const DEFAULT_DIRECT_SOURCES = [
  { name: 'JMS Celebree School', provider: 'bamboohr', careers_url: 'https://celebreeny.bamboohr.com/careers' },
  { name: 'STEPS Behavioral Health', provider: 'bamboohr', careers_url: 'https://steps.bamboohr.com/careers' },
  { name: 'The 1916 Company', provider: 'bamboohr', careers_url: 'https://the1916company.bamboohr.com/careers' },
  { name: 'Curaleaf', provider: 'greenhouse', careers_url: 'https://job-boards.greenhouse.io/curaleaf' },
  { name: 'Mercer Advisors', provider: 'greenhouse', careers_url: 'https://job-boards.greenhouse.io/merceradvisors' },
  { name: 'Cellular Sales', provider: 'icims', careers_url: 'https://careers-cellularsales.icims.com/jobs/search?ss=1' },
  { name: 'Crash Champions', provider: 'icims', careers_url: 'https://ate-crashchampions.icims.com/jobs/search?ss=1' },
  { name: 'Dewberry', provider: 'icims', careers_url: 'https://careers-dewberry.icims.com/jobs/search?ss=1' },
  { name: 'Enterprise Mobility', provider: 'icims', careers_url: 'https://us-erac.icims.com/jobs/search?ss=1' },
  { name: 'FutureCare', provider: 'icims', careers_url: 'https://careers-futurecarehealth.icims.com/jobs/search?ss=1' },
  { name: 'Marvin', provider: 'icims', careers_url: 'https://infinity-jobs-marvin.icims.com/jobs/search?ss=1' },
  { name: 'OSL Retail Services', provider: 'icims', careers_url: 'https://uscareers-oslrs.icims.com/jobs/search?ss=1' },
  { name: 'Bartlett Tree Experts', provider: 'icims', careers_url: 'https://englishcareers-bartlett.icims.com/jobs/search?ss=1' },
  { name: 'Footprint Solutions', provider: 'jobvite', careers_url: 'https://jobs.jobvite.com/fprs' },
  { name: 'Mainspring Recovery', provider: 'rippling', careers_url: 'https://ats.rippling.com/mainspringrecovery/jobs' },
  { name: 'Nexplore', provider: 'rippling', careers_url: 'https://ats.rippling.com/nexploreusa/jobs' },
  { name: 'WPM Real Estate Management', provider: 'rippling', careers_url: 'https://ats.rippling.com/wpm-real-estate/jobs' },
  { name: "America's Best", provider: 'smartrecruiters', careers_url: 'https://jobs.smartrecruiters.com/NationalVision1' },
  { name: "Domino's", provider: 'smartrecruiters', careers_url: 'https://jobs.smartrecruiters.com/Dominos' },
  { name: 'Public Storage', provider: 'smartrecruiters', careers_url: 'https://jobs.smartrecruiters.com/PublicStorage' },
  { name: 'Sonic Automotive', provider: 'smartrecruiters', careers_url: 'https://jobs.smartrecruiters.com/SonicAutomotive' },
];

const sourceId = source => `${source.provider}:${source.careers_url}`;

export function isDirectTitleExcluded(title) {
  const stripped = String(title || '').replace(SENIOR_CONTEXT_RE, '').replace(EXEC_ASSISTANT_RE, 'assistant');
  return HARD_SENIOR_RE.test(stripped) || STAFF_TECH_RE.test(stripped) || MEDICAL_RE.test(stripped);
}

export function normalizeDirectJob(job, source, now = Date.now()) {
  const title = String(job?.title || '').trim();
  const url = String(job?.url || '').trim();
  const location = String(job?.location || '').trim();
  if (!title || !url) return null;
  if (!CORE_LOCATION_RE.test(location)) return null;
  if (isDirectTitleExcluded(title)) return null;

  const postedAtMs = Number(job.postedAt);
  const hasDate = Number.isFinite(postedAtMs);
  if (hasDate && postedAtMs < now - MAX_AGE_DAYS * 86400000) return null;
  const salary = job.salary && (job.salary.min != null || job.salary.max != null)
    ? { ...job.salary, unit: job.salary.unit || (job.salary.currency ? 'YEAR' : null) }
    : null;
  return {
    company: String(job.company || source.name).trim() || source.name,
    title, url, location,
    postedAtMs: hasDate ? postedAtMs : null,
    datePosted: hasDate ? new Date(postedAtMs).toISOString() : null,
    days: hasDate ? Math.max(0, Math.floor((now - postedAtMs) / 86400000)) : null,
    salary,
    source: `Direct ATS (${source.provider})`,
    sourceBoard: sourceId(source),
    sourceFailureRuns: 0,
    retainedAfterSourceFailure: false,
  };
}

export function mergeDirectSource(previous, source, current, error = null, maxFailedRuns = MAX_FAILED_REFRESH_RUNS) {
  if (!error) return current;
  return previous
    .filter(job => job.sourceBoard === sourceId(source))
    .map(job => ({
      ...job,
      sourceFailureRuns: (Number(job.sourceFailureRuns) || 0) + 1,
      retainedAfterSourceFailure: true,
      sourceFailure: String(error),
    }))
    .filter(job => job.sourceFailureRuns <= maxFailedRuns);
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

function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    return parsed && Array.isArray(parsed.jobs) ? parsed : { jobs: [], sourceHealth: [] };
  } catch {
    return { jobs: [], sourceHealth: [] };
  }
}

async function main() {
  const [{ loadProviders }, { makeHttpCtx }] = await Promise.all([
    import('./providers/_registry.mjs'),
    import('./providers/_http.mjs'),
  ]);
  const providers = await loadProviders(path.join(ROOT, 'providers'));
  const ctx = { ...makeHttpCtx(), maxPages: 40 };
  const previous = readStore();
  const now = Date.now();

  const results = await pooled(DEFAULT_DIRECT_SOURCES, BOARD_CONCURRENCY, async source => {
    const provider = providers.get(source.provider);
    if (!provider) {
      const reason = `provider ${source.provider} is unavailable`;
      return { jobs: mergeDirectSource(previous.jobs, source, [], reason), health: { name: source.name, provider: source.provider, status: 'failed', reason } };
    }
    try {
      const raw = await provider.fetch(source, ctx);
      const candidates = [];
      for (const job of raw) {
        // iCIMS list pages omit dates. Enrich only location-matching rows, so
        // an employer-wide board never causes a detail request for irrelevant cities.
        if (!job.postedAt && provider.enrichDate && CORE_LOCATION_RE.test(String(job.location || ''))) {
          try { await provider.enrichDate(job, ctx); } catch { /* remains undated */ }
        }
        const normalized = normalizeDirectJob(job, source, now);
        if (normalized) candidates.push(normalized);
      }
      return { jobs: candidates, health: { name: source.name, provider: source.provider, status: 'success', fetched: raw.length, kept: candidates.length } };
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      const retained = mergeDirectSource(previous.jobs, source, [], reason);
      return { jobs: retained, health: { name: source.name, provider: source.provider, status: 'failed', reason, retained: retained.length } };
    }
  });

  const byUrl = new Map();
  for (const result of results) for (const job of result.jobs) byUrl.set(job.url, job);
  const jobs = [...byUrl.values()].sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));
  const sourceHealth = results.map(result => result.health);
  writeFileSync(STORE_PATH, JSON.stringify({
    generatedAt: new Date(now).toISOString(),
    scope: 'Official non-Workday ATS boards; 10-mile town-centre proxy around Owings Mills',
    maxFailedRefreshRuns: MAX_FAILED_REFRESH_RUNS,
    sourceHealth,
    jobs,
  }, null, 2));

  const failed = sourceHealth.filter(source => source.status !== 'success');
  console.log(`direct ATS: ${jobs.length} local jobs from ${DEFAULT_DIRECT_SOURCES.length - failed.length}/${DEFAULT_DIRECT_SOURCES.length} healthy boards`);
  for (const source of failed) console.error(`  ${source.name}: ${source.reason}; retained ${source.retained || 0}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(`Direct ATS scan failed: ${error.message}`);
    process.exit(1);
  });
}
