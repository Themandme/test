// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// hiring.cafe provider — reads the site's published sitemaps, not its private API.
//
// Why sitemaps: hiringcafe.com's own /api/search-jobs requires authentication
// (401 GET / 405 POST). Its robots.txt allows /job/ for User-agent: * (the two
// blanket `Disallow: /` rules are scoped to named AI crawlers), and it publishes
// job-posting sitemaps refreshed daily — machine-readable by design.
//
// Flow: sitemap index -> chunk(s) of <loc> URLs -> cheap slug prefilter against
// the configured title keywords -> fetch only the survivors and read their
// JSON-LD JobPosting for exact title/company/location.
//
// Wire in via a `job_boards:` entry with `provider: hiringcafe`.

import { entries, rotatingWindow, loadSweepState, saveSweepState, staleByLastmod } from '../sitemap-sweep.mjs';

const SITEMAP_INDEX = 'https://hiringcafe.com/job-posting-sitemap.xml';
const UA = 'career-ops personal job search (+https://github.com/santifer/career-ops)';

// The window ROTATES between runs — see sitemap-sweep.mjs for why a fixed
// `slice(0, N)` is a blind spot rather than a sample. At 60 chunks against an
// index of ~465, a full pass takes 8 runs; the cursor lives in SWEEP_STATE.
const DEFAULT_MAX_CHUNKS = 60;    // ~20k <loc> entries and ~3 MB per chunk
const DEFAULT_MAX_DETAILS = 600;  // hard cap on job-page fetches per run
const SWEEP_STATE = 'data/hiringcafe-sweep.json';
const CONCURRENCY = 4;
const DELAY_MS = 120;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** "CRM Analyst" -> "crm-analyst" — matches how hiring.cafe builds its slugs. */
function slugify(s) {
  return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Pull the JobPosting object out of a job page's JSON-LD blocks.
 * Returns null when absent or unparseable — callers skip rather than guess,
 * because slug boundaries are ambiguous and would fabricate company names.
 */
function jobPostingFromHtml(html) {
  const blocks = [...String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (node && node['@type'] === 'JobPosting') return node;
    }
  }
  return null;
}

/**
 * JSON-LD `datePosted` (ISO) → epoch ms, or undefined when absent/unparseable.
 * Returning undefined rather than null/0 matters: scan.mjs's posting-age filter
 * treats a non-finite postedAt as "unknown, keep", whereas a bogus 0 would read
 * as 1970 and fail every age check.
 */
function postedAtOf(posting) {
  const raw = posting && posting.datePosted;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function locationOf(posting) {
  let loc = posting.jobLocation;
  if (Array.isArray(loc)) loc = loc[0];
  const addr = (loc && loc.address) || {};
  const parts = [addr.addressLocality, addr.addressRegion].filter(p => typeof p === 'string' && p.trim());
  if (parts.length) return parts.join(', ');
  const remote = posting.jobLocationType === 'TELECOMMUTE' ? 'Remote' : '';
  return remote || (typeof addr.addressCountry === 'string' ? addr.addressCountry : '');
}

/** Map with a small fixed worker pool, preserving input order. */
async function pooled(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
      await sleep(DELAY_MS);
    }
  }));
  return out;
}

/** @type {Provider} */
export default {
  id: 'hiringcafe',

  /**
   * @param {{ name?: string, max_chunks?: number, max_details?: number, max_posting_age_days?: number, title_keywords?: string[] }} entry
   * @param {{ fetchText?: (url: string, opts?: any) => Promise<string>, fetchJson?: (url: string, opts?: any) => Promise<any>, titleFilter?: { positive?: string[] } }} ctx
   */
  async fetch(entry, ctx) {
    const get = async (url) => {
      if (typeof ctx.fetchText === 'function') {
        return await ctx.fetchText(url, { redirect: 'error', headers: { 'User-Agent': UA } });
      }
      const res = await globalThis.fetch(url, { redirect: 'error', headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`hiringcafe: HTTP ${res.status} for ${url}`);
      return await res.text();
    };

    // Keywords, in precedence order: an explicit entry override, whatever the
    // caller put on ctx, else portals.yml's own title_filter. scan.mjs's ctx
    // (providers/_http.mjs makeHttpCtx) carries only fetchJson/fetchText, so in
    // a normal scan the config read is the path that fires — reading it here
    // beats duplicating the whole keyword list into the job_boards entry and
    // letting the two drift apart.
    let keywords = (entry.title_keywords && entry.title_keywords.length)
      ? entry.title_keywords
      : (ctx.titleFilter && ctx.titleFilter.positive) || [];
    if (keywords.length === 0) {
      try {
        const [{ readFileSync }, { load }] = await Promise.all([import('node:fs'), import('js-yaml')]);
        const cfg = load(readFileSync('portals.yml', 'utf8')) || {};
        keywords = (cfg.title_filter && cfg.title_filter.positive) || [];
      } catch { /* fall through to the explicit error below */ }
    }
    const needles = [...new Set(keywords.map(slugify).filter(s => s.length >= 4))];
    if (needles.length === 0) {
      throw new Error('hiringcafe: no title keywords available to filter on — refusing to pull the full sitemap');
    }

    // The freshness policy lives in portals.yml as max_posting_age_days and is
    // enforced downstream by scan.mjs. Reading it here too lets the sitemap's
    // own <lastmod> skip detail fetches for postings that would be discarded
    // anyway — on a comparable sweep that removed a third of the fetches.
    let maxAgeDays = entry.max_posting_age_days;
    if (!Number.isFinite(maxAgeDays)) {
      try {
        const [{ readFileSync }, { load }] = await Promise.all([import('node:fs'), import('js-yaml')]);
        const cfg = load(readFileSync('portals.yml', 'utf8')) || {};
        maxAgeDays = cfg.max_posting_age_days;
      } catch { /* no policy available; skip the optimisation entirely */ }
    }
    const ageCutoff = Number.isFinite(maxAgeDays) ? Date.now() - maxAgeDays * 86400000 : null;

    const allChunks = entries(await get(SITEMAP_INDEX));
    if (allChunks.length === 0) {
      throw new Error('hiringcafe: sitemap index contained no <loc> entries — layout may have changed');
    }

    const state = loadSweepState(SWEEP_STATE);
    const { window: chunks, cursor, nextCursor, cycleRuns } =
      rotatingWindow(allChunks, state.cursor, Math.max(1, entry.max_chunks ?? DEFAULT_MAX_CHUNKS));

    // Prefilter on the slug: cheap, and keeps detail fetches bounded.
    const candidates = [];
    let skippedStale = 0;
    for (const chunkUrl of chunks) {
      const xml = await get(chunkUrl);
      for (const { loc: url, lastmod } of entries(xml)) {
        const slug = url.slice(url.lastIndexOf('/') + 1);
        if (!needles.some(n => slug.includes(n))) continue;
        if (ageCutoff !== null && staleByLastmod(lastmod, ageCutoff)) { skippedStale++; continue; }
        candidates.push(url);
      }
      await sleep(DELAY_MS);
    }

    // Advance the cursor even if the detail fetches below fail: the window was
    // genuinely read, and refusing to advance would pin the sweep on one slice.
    saveSweepState(SWEEP_STATE, {
      cursor: nextCursor, run: state.run + 1, chunkCount: allChunks.length,
      lastWindow: { start: cursor, size: chunks.length, cycleRuns },
      lastRun: { candidates: candidates.length, skippedStale },
    });

    // Slug matches far exceed the detail budget (a 6-chunk window produced 525
    // candidates), so this step is where the real sampling happens. Take an even
    // spread rather than the head: candidates arrive in chunk order, so
    // `slice(0, N)` would fetch only the window's first chunk or two and
    // reintroduce clustering one level down from the one rotation just fixed.
    const budget = Math.max(1, entry.max_details ?? DEFAULT_MAX_DETAILS);
    const step = Math.max(1, Math.floor(candidates.length / budget));
    const capped = candidates.filter((_, i) => i % step === 0).slice(0, budget);

    const rows = await pooled(capped, CONCURRENCY, async (url) => {
      let posting;
      try { posting = jobPostingFromHtml(await get(url)); } catch { return null; }
      if (!posting || typeof posting.title !== 'string' || !posting.title.trim()) return null;
      const company = (posting.hiringOrganization && typeof posting.hiringOrganization.name === 'string')
        ? posting.hiringOrganization.name.trim() : '';
      if (!company) return null;
      /** @type {{title:string,url:string,company:string,location:string,postedAt?:number}} */
      const job = { title: posting.title.trim(), url, company, location: locationOf(posting) };
      const postedAt = postedAtOf(posting);
      if (postedAt !== undefined) job.postedAt = postedAt;
      return job;
    });

    return rows.filter(Boolean);
  },
};
