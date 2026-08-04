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

const SITEMAP_INDEX = 'https://hiringcafe.com/job-posting-sitemap.xml';
const UA = 'career-ops personal job search (+https://github.com/santifer/career-ops)';

const DEFAULT_MAX_CHUNKS = 2;     // 20k <loc> entries per chunk
const DEFAULT_MAX_DETAILS = 150;  // hard cap on job-page fetches per run
const CONCURRENCY = 4;
const DELAY_MS = 120;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** "CRM Analyst" -> "crm-analyst" — matches how hiring.cafe builds its slugs. */
function slugify(s) {
  return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function locs(xml) {
  return [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
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
   * @param {{ name?: string, max_chunks?: number, max_details?: number, title_keywords?: string[] }} entry
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

    const index = await get(SITEMAP_INDEX);
    const chunks = locs(index).slice(0, Math.max(1, entry.max_chunks ?? DEFAULT_MAX_CHUNKS));
    if (chunks.length === 0) {
      throw new Error('hiringcafe: sitemap index contained no <loc> entries — layout may have changed');
    }

    // Prefilter on the slug: cheap, and keeps detail fetches bounded.
    const candidates = [];
    for (const chunkUrl of chunks) {
      const xml = await get(chunkUrl);
      for (const url of locs(xml)) {
        const slug = url.slice(url.lastIndexOf('/') + 1);
        if (needles.some(n => slug.includes(n))) candidates.push(url);
      }
      await sleep(DELAY_MS);
    }

    const capped = candidates.slice(0, Math.max(1, entry.max_details ?? DEFAULT_MAX_DETAILS));

    const rows = await pooled(capped, CONCURRENCY, async (url) => {
      let posting;
      try { posting = jobPostingFromHtml(await get(url)); } catch { return null; }
      if (!posting || typeof posting.title !== 'string' || !posting.title.trim()) return null;
      const company = (posting.hiringOrganization && typeof posting.hiringOrganization.name === 'string')
        ? posting.hiringOrganization.name.trim() : '';
      if (!company) return null;
      return { title: posting.title.trim(), url, company, location: locationOf(posting) };
    });

    return rows.filter(Boolean);
  },
};
