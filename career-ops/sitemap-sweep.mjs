// Rotating sitemap sweeps — shared by every scanner that reads hiring.cafe's
// job-posting sitemap.
//
// THE PROBLEM THIS EXISTS TO SOLVE
//
// The sitemap index is ~465 chunks of ~20k postings, ~3 MB each. Reading all of
// it is ~1.4 GB per run, which is not a reasonable thing to do to a free service
// on a schedule. Every scanner here therefore reads a subset — and each one
// independently reached for `chunks.slice(0, N)`, which looks like sampling and
// behaves like a blind spot:
//
//   - Matches are spread evenly across the index, not concentrated at the front
//     (measured: ~52-59 area matches per 10 chunks at positions 0, 55, 200, 455).
//     The first N chunks are not the newest or the nearest. They are the first.
//   - hiring.cafe re-shards daily — chunk URLs carry a build id and every
//     chunk's <lastmod> is stamped with the current date — so postings drift in
//     and out of a fixed window, and that drift reads as "new listings today"
//     when nothing has actually changed.
//
// Read a window that ROTATES instead, and accumulate results across runs. Same
// bandwidth per run, complete coverage over a cycle, and the diff between runs
// starts meaning something.
//
// Pure and dependency-free so it can be unit-tested without network access.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Parse <url>/<sitemap> entries carrying both <loc> and <lastmod>.
 *
 * Matched as blocks rather than as two independent <loc>/<lastmod> scans: a
 * missing lastmod would otherwise shift the pairing and attach one entry's date
 * to the next entry's URL, which is worse than having no date at all.
 *
 * @param {string} xml
 * @returns {{loc: string, lastmod: string|null}[]}
 */
export function entries(xml) {
  const out = [];
  for (const [, block] of String(xml).matchAll(/<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/g)) {
    const loc = (block.match(/<loc>([^<]+)<\/loc>/) || [])[1];
    if (!loc) continue;
    const lastmod = (block.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1];
    out.push({ loc: loc.trim(), lastmod: lastmod ? lastmod.trim() : null });
  }
  return out;
}

/** Bare <loc> list, for callers that do not need dates. */
export function locs(xml) {
  return [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
}

/**
 * The window of chunk URLs this run should read, wrapping at the end of the
 * index so the window keeps a constant size and every chunk is visited once
 * per cycle.
 *
 * @param {{loc: string}[]|string[]} chunks
 * @param {number} cursor
 * @param {number} size
 */
export function rotatingWindow(chunks, cursor, size) {
  const n = chunks.length;
  const fallbackCursor = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
  if (!n) return { window: [], cursor: fallbackCursor, nextCursor: fallbackCursor, cycleRuns: 1 };

  const start = ((fallbackCursor % n) + n) % n; // tolerate a negative or stale cursor
  const requested = Number.isFinite(size) ? Math.max(1, Math.trunc(size)) : 1;
  const take = Math.min(requested, n);
  const window = [];
  for (let k = 0; k < take; k++) {
    const c = chunks[(start + k) % n];
    window.push(typeof c === 'string' ? c : c.loc);
  }
  return {
    window,
    cursor: start,
    nextCursor: (start + take) % n,
    cycleRuns: Math.max(1, Math.ceil(n / take)),
  };
}

/**
 * Cheap runtime checks for the pure sweep helpers. These catch the two failures
 * that are most destructive to accumulated stores: a broken wraparound window,
 * and an invalid window size producing an empty/NaN cursor advance.
 */
export function assertSweepHelpers() {
  const wrapped = rotatingWindow(['a', 'b', 'c', 'd'], 3, 3);
  if (wrapped.window.join(',') !== 'd,a,b' || wrapped.nextCursor !== 2 || wrapped.cycleRuns !== 2) {
    throw new Error('rotatingWindow wraparound invariant failed');
  }
  const defensive = rotatingWindow(['a', 'b'], Number.NaN, Number.NaN);
  if (defensive.window.join(',') !== 'a' || defensive.cursor !== 0 || defensive.nextCursor !== 1) {
    throw new Error('rotatingWindow invalid-input invariant failed');
  }
  const parsed = entries('<url><loc>https://example.test/a</loc></url><url><loc>https://example.test/b</loc><lastmod>2026-08-29</lastmod></url>');
  if (parsed.length !== 2 || parsed[0].lastmod !== null || parsed[1].lastmod !== '2026-08-29') {
    throw new Error('sitemap entry pairing invariant failed');
  }
}

/**
 * Read sweep state. Every field is defaulted, and a corrupt file yields a fresh
 * state rather than throwing: losing a cycle of accumulation is strictly better
 * than failing the run and leaving the output frozen.
 *
 * `chunkCount` must survive the round trip. Dropping it once collapsed a
 * caller's cycle length from 8 runs to 1, which shrank an unseen-expiry horizon
 * from 16 runs to 2 and deleted 317 stored listings.
 *
 * @param {string} path
 */
export function loadSweepState(path) {
  if (!existsSync(path)) return { cursor: 0, run: 0, chunkCount: 0, jobs: {} };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) || {};
    return {
      cursor: Number.isFinite(s.cursor) ? s.cursor : 0,
      run: Number.isFinite(s.run) ? s.run : 0,
      chunkCount: Number.isFinite(s.chunkCount) ? s.chunkCount : 0,
      jobs: (s.jobs && typeof s.jobs === 'object') ? s.jobs : {},
    };
  } catch {
    return { cursor: 0, run: 0, chunkCount: 0, jobs: {} };
  }
}

/** @param {string} path @param {object} state */
export function saveSweepState(path, state) {
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({
    note: 'Rotating sitemap sweep state. Safe to delete; costs one cycle to rebuild.',
    updatedAt: new Date().toISOString(),
    ...state,
  }, null, 2));
}

/**
 * True when a sitemap <lastmod> proves the posting is older than the freshness
 * window, so the detail fetch can be skipped entirely.
 *
 * lastmod should never precede datePosted — it records when the entry last
 * changed, which is at or after creation — so this is a safe necessary
 * condition. `slackDays` buys margin against that assumption for a few extra
 * fetches; an absent or unparseable date never skips.
 *
 * @param {string|null} lastmod
 * @param {number} cutoffMs  epoch ms; postings older than this are unwanted
 * @param {number} [slackDays]
 */
export function staleByLastmod(lastmod, cutoffMs, slackDays = 7) {
  if (!lastmod) return false;
  const ms = Date.parse(lastmod);
  if (!Number.isFinite(ms)) return false;
  return ms < cutoffMs - slackDays * 86400000;
}
