// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// USAJOBS provider — official federal job API (https://developer.usajobs.gov).
//
// Credentials: the Search API returns 401 without an Authorization-Key. The key
// is free but tied to a personal email, so it is read from the environment
// (career-ops already loads dotenv; .env is gitignored) rather than committed:
//
//   USAJOBS_API_KEY=...
//   USAJOBS_EMAIL=you@example.com   # the address the key was registered with
//
// With either missing the provider logs one line and returns [] — a scan
// without a key still succeeds instead of erroring out.
//
// The keyless www.usajobs.gov/Search/Feed/{rss,Json} endpoints are NOT used:
// they are 403'd at the CDN edge for non-browser clients and 404 after their
// lowercase redirect. Working around that would mean impersonating a browser.
//
// Wire in via a `job_boards:` entry with `provider: usajobs`.

const API = 'https://data.usajobs.gov/api/search';
const RESULTS_PER_PAGE = 250;
const MAX_PAGES = 4;           // per (location, keyword) pair
const DEFAULT_LOCATIONS = ['Baltimore, Maryland', 'Washington, DC'];
const DELAY_MS = 250;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function descriptorToRow(item) {
  const d = item && item.MatchedObjectDescriptor;
  if (!d || typeof d.PositionTitle !== 'string' || !d.PositionTitle.trim()) return null;
  const url = typeof d.PositionURI === 'string' ? d.PositionURI.trim() : '';
  if (!/^https?:\/\//i.test(url)) return null;
  const row = {
    title: d.PositionTitle.trim(),
    url,
    company: (typeof d.OrganizationName === 'string' && d.OrganizationName.trim())
      ? d.OrganizationName.trim()
      : 'US Federal Government',
    location: typeof d.PositionLocationDisplay === 'string' ? d.PositionLocationDisplay.trim() : '',
    _id: typeof d.PositionID === 'string' ? d.PositionID : url,
  };
  // Feed the posting-age filter. Omit the key when unparseable — a 0 would read
  // as 1970 and fail every age check.
  const ms = Date.parse(d.PublicationStartDate || '');
  if (Number.isFinite(ms)) row.postedAt = ms;
  return row;
}

/** @type {Provider} */
export default {
  id: 'usajobs',

  /**
   * @param {{ name?: string, locations?: string[], keywords?: string[], max_pages?: number }} entry
   * @param {{ fetchJson?: (url: string, opts?: any) => Promise<any> }} ctx
   */
  async fetch(entry, ctx) {
    const key = process.env.USAJOBS_API_KEY;
    const email = process.env.USAJOBS_EMAIL;
    if (!key || !email) {
      console.log('  ℹ usajobs: skipped — set USAJOBS_API_KEY and USAJOBS_EMAIL in .env (free key: https://developer.usajobs.gov/apirequest/)');
      return [];
    }

    const headers = { 'Authorization-Key': key, 'User-Agent': email, Host: 'data.usajobs.gov' };
    const get = async (url) => {
      if (typeof ctx.fetchJson === 'function') return await ctx.fetchJson(url, { redirect: 'error', headers });
      const res = await globalThis.fetch(url, { redirect: 'error', headers });
      if (!res.ok) throw new Error(`usajobs: HTTP ${res.status}`);
      return await res.json();
    };

    // Keywords: entry override, else portals.yml's title filter (see hiringcafe.mjs
    // for why the config read lives in the provider).
    let keywords = (entry.keywords && entry.keywords.length) ? entry.keywords : [];
    if (keywords.length === 0) {
      try {
        const [{ readFileSync }, { load }] = await Promise.all([import('node:fs'), import('js-yaml')]);
        const cfg = load(readFileSync('portals.yml', 'utf8')) || {};
        keywords = (cfg.title_filter && cfg.title_filter.positive) || [];
      } catch { /* handled below */ }
    }
    if (keywords.length === 0) throw new Error('usajobs: no keywords configured');

    const locations = (entry.locations && entry.locations.length) ? entry.locations : DEFAULT_LOCATIONS;
    const maxPages = Math.max(1, entry.max_pages ?? MAX_PAGES);

    const seen = new Set();
    const rows = [];

    for (const location of locations) {
      for (const keyword of keywords) {
        for (let page = 1; page <= maxPages; page++) {
          const url = `${API}?Keyword=${encodeURIComponent(keyword)}`
            + `&LocationName=${encodeURIComponent(location)}`
            + `&ResultsPerPage=${RESULTS_PER_PAGE}&Page=${page}`;
          let json;
          try { json = await get(url); } catch { break; }
          const items = json?.SearchResult?.SearchResultItems;
          if (!Array.isArray(items) || items.length === 0) break;

          for (const item of items) {
            const row = descriptorToRow(item);
            if (!row || seen.has(row._id)) continue;
            seen.add(row._id);
            const { _id, ...clean } = row;
            rows.push(clean);
          }

          const total = Number(json?.SearchResult?.SearchResultCountAll ?? 0);
          if (page * RESULTS_PER_PAGE >= total) break;
          await sleep(DELAY_MS);
        }
        await sleep(DELAY_MS);
      }
    }

    return rows;
  },
};
