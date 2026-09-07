// HiringCafe full-radius pull with donsetch as the HTTP transport.
//
// node fetch gets Cloudflare-blocked (HTTP 403) from some networks while
// donsetch's Chrome-parity TLS passes. This driver fetches the exact same
// Next.js data pages the primary scanner uses, then normalizes, dedupes,
// scores, and writes byte-identical store shapes via the primary scanner's
// own exported helpers. Run from the career-ops directory:
//
//   node scan-hiringcafe-via-donsetch.mjs [--pages N] [--build-id ID]
//
// --pages N caps the pull at N pages (smoke test). Requires donsetch with
// pdfium.dll beside it; see the `donsetch` skill.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  MAX_AGE_DAYS, MAX_PAGES, normalizeHit, payRank, payText, scoreJob, searchState,
} from './scan-hiringcafe-full.mjs';

const execFileAsync = promisify(execFile);
const DONSETCH = 'C:/Users/ajbig/AppData/Roaming/npm/donsetch.exe';
const HOME = 'https://hiringcafe.com/';
const STORE_PATH = 'owings-mills-store.json';
const PAGE_CONCURRENCY = 4;
const MAX_CHARS = 1500000;
const CKPT_DIR = 'checkpoint-hc-pages';
const ckptGet = (page) => {
  try {
    const parsed = JSON.parse(readFileSync(`${CKPT_DIR}/page-${page}.json`, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
};
const ckptPut = (page, pairs) => {
  mkdirSync(CKPT_DIR, { recursive: true });
  writeFileSync(`${CKPT_DIR}/page-${page}.json`, JSON.stringify(pairs));
};
const KNOWN_BUILD_ID = 'gvzuiDv2Jx0bRlrSouAQX'; // verified live 2026-09-06; auto re-resolves on 404
const FETCH_TIMEOUT_MS = 180000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stripBom = (s) => String(s || '').replace(/^﻿/, '');
// donsetch annotates repeat fetches with a leading "*[changed ...]*" notice,
// wraps non-HTML bodies as "<url>\n\n```\n<body>\n```", and ends split
// windows with a "*[truncated ...]*" trailer.
const stripWrapper = (s) => String(s || '')
  .replace(/^\s*\*\[.*?\]\*\s*/, '')
  .replace(/\s*https:\/\/hiringcafe\.com\/\S+\s*```\s*/g, '')
  .replace(/\s*```\s*$/, '');
// donsetch also injects per-window notices mid-stream on offset fetches.
const stripNotices = (s) => String(s || '')
  .replace(/\*\[changed since last fetch.*?\]\*/g, '')
  .replace(/\*\[truncated.*?\]\*/g, '');
// Some pages embed raw C0 control characters inside string values.
const CTL = new RegExp(String.fromCharCode(91) + String.fromCharCode(92) + 'u0001-' + String.fromCharCode(92) + 'u001f' + String.fromCharCode(93), 'g');
const sanitizeControls = (s) => String(s || '').replace(CTL, ' ');
const parsePage = (text) => {
  try { return JSON.parse(text).pageProps; }
  catch {
    try { return JSON.parse(stripWrapper(text)).pageProps; }
    catch { return JSON.parse(sanitizeControls(stripWrapper(text))).pageProps; }
  }
};

async function donsetchJson(args) {
  const { stdout } = await execFileAsync(DONSETCH, args, {
    timeout: FETCH_TIMEOUT_MS, maxBuffer: 300 * 1024 * 1024, windowsHide: true,
  });
  return JSON.parse(stripBom(stdout));
}

// Fetch one URL's full extraction, following next_offset windows.
async function fetchContent(url) {
  let content = '';
  let offset = 0;
  for (;;) {
    const args = ['fetch', url, '--max-chars', String(MAX_CHARS), '--json', '-q'];
    if (offset > 0) args.push('--offset', String(offset));
    const env = await donsetchJson(args);
    if (env.isError) {
      const err = new Error(`donsetch: ${env.structuredContent?.code || 'error'} for ${url}`);
      err.code = env.structuredContent?.code;
      err.envelope = env;
      throw err;
    }
    const next = env.meta?.next_offset ?? env.structuredContent?.next_offset;
    content += stripNotices(env.content);
    if (!next) return content;
    offset = next;
  }
}

async function resolveBuildId() {
  const probe = await donsetchJson(['fetch', HOME, '--selector', '#__NEXT_DATA__', '--max-chars', '200', '--json', '-q']);
  const total = probe.meta?.total_chars;
  if (!Number.isFinite(total)) throw new Error('donsetch homepage probe had no total_chars');
  const end = await donsetchJson(['fetch', HOME, '--selector', '#__NEXT_DATA__', '--max-chars', '6000', '--offset', String(Math.max(0, total - 5000)), '--json', '-q']);
  const match = String(end.content || '').match(/"buildId":"([^"]+)"/);
  if (!match) throw new Error('could not find buildId in homepage __NEXT_DATA__ tail');
  return match[1];
}

function pageUrl(buildId, page) {
  return `${HOME}_next/data/${buildId}/index.json?searchState=${encodeURIComponent(JSON.stringify(searchState()))}&page=${page}`;
}

async function fetchProps(buildId, page, attempts = 3) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const content = await fetchContent(pageUrl(buildId, page));
      const props = parsePage(content);
      if (!props || props.ssrError) throw new Error(`HiringCafe page ${page} error: ${props?.ssrError || 'missing pageProps'}`);
      if (!Array.isArray(props.ssrHits)) throw new Error(`HiringCafe page ${page} had no ssrHits array`);
      return props;
    } catch (caught) {
      error = caught;
      const text = String(caught?.envelope?.content || caught.message || '');
      if (/HTTP 404|not found/i.test(text) || caught.code === 'not_found') {
        const stale = new Error(`buildId ${buildId} is stale (HTTP 404 on page ${page})`);
        stale.code = 'STALE_BUILD_ID';
        throw stale;
      }
      if (attempt < attempts) await sleep(5000 * attempt);
    }
  }
  throw new Error(`HiringCafe page ${page} failed after ${attempts} attempts: ${error?.message}`);
}

async function pooled(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

export async function main() {
  const argv = process.argv.slice(2);
  const pagesCapArg = argv.includes('--pages') ? Number(argv[argv.indexOf('--pages') + 1]) : null;
  const buildIdArg = argv.includes('--build-id') ? argv[argv.indexOf('--build-id') + 1] : null;
  const startedAt = Date.now();
  let buildId = buildIdArg || KNOWN_BUILD_ID;
  let first;
  try {
    first = await fetchProps(buildId, 0);
  } catch (caught) {
    if (caught.code === 'STALE_BUILD_ID' && !buildIdArg) {
      console.log(`Known buildId stale; re-resolving...`);
      buildId = await resolveBuildId();
      console.log(`Fresh buildId: ${buildId}`);
      first = await fetchProps(buildId, 0);
    } else throw caught;
  }
  const total = Number(first.ssrTotalCount);
  const pageSize = Number(first.ssrPageSize);
  if (!Number.isFinite(total) || !Number.isFinite(pageSize) || pageSize < 1) throw new Error('HiringCafe returned invalid pagination metadata');
  let pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (Number.isFinite(pagesCapArg) && pagesCapArg > 0) pageCount = Math.min(pageCount, pagesCapArg);
  if (pageCount > MAX_PAGES) throw new Error(`HiringCafe requested ${pageCount} pages, above safety cap ${MAX_PAGES}`);
  console.log(`HiringCafe structured search via donsetch: ${total} result groups across ${pageCount} pages (buildId ${buildId})`);

  const keyOf = (hit) => hit.objectID || hit.id || JSON.stringify(hit);
  const fetchNormalized = async (page, props) => {
    const cached = ckptGet(page);
    if (cached) return { cached: true, pairs: cached };
    const pp = props || await fetchProps(buildId, page);
    const pairs = pp.ssrHits.map((hit) => [keyOf(hit), normalizeHit(hit)]);
    ckptPut(page, pairs);
    return { cached: false, pairs };
  };
  const remaining = Array.from({ length: pageCount - 1 }, (_, index) => index + 1);
  let cachedPages = 0;
  let donePages = 0;
  const onOneDone = (cached) => {
    if (cached) cachedPages += 1;
    donePages += 1;
    if (donePages % 10 === 0 || donePages === pageCount) console.log(`Fetched page ${donePages}/${pageCount} (${cachedPages} from checkpoint)`);
  };
  const firstNorm = await fetchNormalized(0, first);
  onOneDone(firstNorm.cached);
  const byPage = new Map([[0, firstNorm]]);
  const fillPool = (pending) => pooled(pending, PAGE_CONCURRENCY, async (page) => {
    try {
      const result = await fetchNormalized(page, null);
      byPage.set(page, result);
      onOneDone(result.cached);
    } catch (caught) {
      if (caught.code === 'STALE_BUILD_ID') throw caught;
      byPage.set(page, { failed: true, page, error: String((caught && caught.message) || caught) });
      onOneDone(false);
    }
  });
  let pending = remaining;
  for (let round = 1; pending.length > 0; round += 1) {
    if (round > 4) {
      const failed = pending.map((p) => `${p} (${(byPage.get(p) || {}).error || 'unknown'})`);
      throw new Error(`HiringCafe pages still failing after 4 rounds: ${failed.join('; ')}`);
    }
    if (round > 1) {
      console.log(`Retry round ${round}: ${pending.length} pages after 60s cooldown...`);
      await sleep(60000);
    }
    try {
      await fillPool(pending);
    } catch (caught) {
      if (caught.code !== 'STALE_BUILD_ID') throw caught;
      console.log('buildId expired mid-run; re-resolving and retrying pages missing from checkpoint...');
      buildId = await resolveBuildId();
      console.log(`Fresh buildId: ${buildId}`);
    }
    pending = pending.filter((p) => byPage.get(p) && byPage.get(p).failed);
  }
  const results = Array.from({ length: pageCount }, (_, p) => byPage.get(p));
  if (results.length !== pageCount) throw new Error(`HiringCafe completeness check failed: ${results.length}/${pageCount} pages`);

  const stats = { mode: 'structured full-radius search', transport: 'donsetch', radiusMiles: 30, buildId, resultGroups: total, pagesExpected: pageCount, pagesFetched: results.length, rawHits: 0, expired: 0, senior: 0, medical: 0, noCoordinates: 0, offArea: 0, stale: 0, invalid: 0, duplicatesCollapsed: 0, kept: 0, payStartsAt20: 0, payReaches20: 0, payUnknown: 0, payBelow20: 0, durationSeconds: 0 };
  const jobsBySource = new Map();
  for (const { pairs } of results) {
    stats.rawHits += pairs.length;
    for (const [, normalized] of pairs) {
      if (normalized.reason) { stats[normalized.reason] = (stats[normalized.reason] || 0) + 1; continue; }
      jobsBySource.set(normalized.job.sourceId, normalized.job);
    }
  }
  const byOpening = new Map();
  for (const job of jobsBySource.values()) {
    const key = [job.company, job.title, job.city].join('\0').toLowerCase();
    const previous = byOpening.get(key);
    if (!previous || (job.datePosted || '') > (previous.datePosted || '')) byOpening.set(key, job);
  }
  stats.duplicatesCollapsed = jobsBySource.size - byOpening.size;
  const kept = [...byOpening.values()].map((job) => ({ ...job, fit: scoreJob(job) })).sort((a, b) => payRank(a.salary) - payRank(b.salary) || b.fit.overall - a.fit.overall || (b.datePosted || '').localeCompare(a.datePosted || ''));
  for (const job of kept) [['payStartsAt20', 0], ['payReaches20', 1], ['payUnknown', 2], ['payBelow20', 3]].forEach(([key, rank]) => { if (payRank(job.salary) === rank) stats[key] += 1; });
  stats.kept = kept.length;
  stats.durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (total > 0 && stats.rawHits === 0) throw new Error('HiringCafe returned nonzero total but zero hits');

  let prior = { run: 0 };
  try { prior = JSON.parse(readFileSync(STORE_PATH, 'utf8')); } catch {}
  const run = Number(prior.run || 0) + 1;
  const storedJobs = Object.fromEntries(kept.map(({ fit, requirementsSummary, sourceId, ...job }) => [
    sourceId,
    { ...job, lastSeenRun: run },
  ]));
  writeFileSync(STORE_PATH, JSON.stringify({ note: 'Complete HiringCafe structured search within an exact 30-mile radius.', updatedAt: new Date().toISOString(), cursor: 0, run, chunkCount: 0, cycleRuns: 1, jobs: storedJobs, lastCompleteSearch: { buildId, transport: 'donsetch', pages: pageCount, resultGroups: total } }, null, 2));

  mkdirSync('data', { recursive: true });
  writeFileSync('data/owings-mills.json', JSON.stringify({ generatedAt: new Date().toISOString(), center: 'Owings Mills, MD 21117', radiusNote: 'Exact 30-mile HiringCafe radius, independently verified with posting coordinates', payPriority: '$20+/hour-equivalent listings first', excluded: ['senior/executive or 5+ year roles', 'medical and clinical titles'], maxAgeDays: MAX_AGE_DAYS, coverage: { mode: stats.mode, transport: stats.transport, pagesFetched: results.length, pagesExpected: pageCount, complete: results.length === pageCount }, stats, jobs: kept }, null, 2));

  const md = ['# Jobs near Owings Mills, MD', '', `_Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${kept.length} openings within an exact 30-mile radius · last ${MAX_AGE_DAYS} days_`, '', `Complete HiringCafe structured search: ${results.length}/${pageCount} pages fetched. Jobs starting at $20+/hour equivalent are shown first. Senior/executive, 5+ year, and clinical titles are excluded.`, '', '## Best matches overall', '', '| Score | Distance | Employer | Role | Pay | Resume | Flags |', '|---:|---:|---|---|---|---|---|'];
  for (const job of kept) md.push(`| ${job.fit.overall} | ${job.miles} mi | ${job.company.replace(/\|/g, '\\|')} | [${job.title.replace(/\|/g, '\\|')}](${job.url}) | ${payText(job.salary)} | ${job.fit.resume} | ${job.fit.flags.join('; ') || '—'} |`);
  writeFileSync('owings-mills-latest.md', md.join('\n'));
  rmSync(CKPT_DIR, { recursive: true, force: true });
  console.log(JSON.stringify(stats, null, 2));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
