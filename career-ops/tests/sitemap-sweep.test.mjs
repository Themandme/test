import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { entries, locs, rotatingWindow, loadSweepState, saveSweepState, staleByLastmod } from '../sitemap-sweep.mjs';

const XML = `<urlset>
  <url><loc>https://x/a</loc><lastmod>2026-01-02</lastmod></url>
  <url><loc>https://x/b</loc></url>
  <url><loc>https://x/c</loc><lastmod>2026-03-04</lastmod></url>
</urlset>`;

test('entries pairs each loc with its own lastmod, and null when absent', () => {
  assert.deepEqual(entries(XML), [
    { loc: 'https://x/a', lastmod: '2026-01-02' },
    { loc: 'https://x/b', lastmod: null },
    { loc: 'https://x/c', lastmod: '2026-03-04' },
  ]);
});

test('a missing lastmod does not shift dates onto the following entry', () => {
  // The bug this guards: scanning <loc> and <lastmod> independently would give
  // b the date 2026-03-04 and leave c undated.
  const e = entries(XML);
  assert.equal(e[1].lastmod, null);
  assert.equal(e[2].lastmod, '2026-03-04');
});

test('locs returns bare urls', () => {
  assert.deepEqual(locs(XML), ['https://x/a', 'https://x/b', 'https://x/c']);
});

test('rotatingWindow advances and wraps, covering every chunk once per cycle', () => {
  const chunks = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const seen = new Set();
  let cursor = 0;
  const cycles = rotatingWindow(chunks, 0, 3).cycleRuns;
  assert.equal(cycles, 4);            // ceil(10/3)
  for (let r = 0; r < cycles; r++) {
    const w = rotatingWindow(chunks, cursor, 3);
    w.window.forEach(c => seen.add(c));
    cursor = w.nextCursor;
  }
  assert.equal(seen.size, chunks.length, 'a full cycle must touch every chunk');
});

test('rotatingWindow keeps a constant window size by wrapping past the end', () => {
  const chunks = ['a', 'b', 'c', 'd', 'e'];
  const w = rotatingWindow(chunks, 4, 3);
  assert.deepEqual(w.window, ['e', 'a', 'b']);
  assert.equal(w.nextCursor, 2);
});

test('rotatingWindow tolerates a stale cursor past the index length', () => {
  const chunks = ['a', 'b', 'c'];
  assert.deepEqual(rotatingWindow(chunks, 97, 2).window, ['b', 'c']);
});

test('rotatingWindow on an empty index is inert rather than throwing', () => {
  const w = rotatingWindow([], 5, 3);
  assert.deepEqual(w.window, []);
  assert.equal(w.nextCursor, 5);
});

test('sweep state round-trips chunkCount', () => {
  // Regression: dropping chunkCount collapsed a caller's cycle length to 1,
  // shrinking its unseen-expiry horizon and deleting 317 stored listings.
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  const p = join(dir, 'state.json');
  try {
    saveSweepState(p, { cursor: 60, run: 3, chunkCount: 465, jobs: { u: { title: 't' } } });
    const s = loadSweepState(p);
    assert.equal(s.chunkCount, 465);
    assert.equal(s.cursor, 60);
    assert.equal(s.run, 3);
    assert.deepEqual(s.jobs, { u: { title: 't' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt state file yields a fresh state instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  const p = join(dir, 'state.json');
  try {
    writeFileSync(p, '{not json');
    assert.deepEqual(loadSweepState(p), { cursor: 0, run: 0, chunkCount: 0, jobs: {} });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing state file yields a fresh state', () => {
  assert.deepEqual(loadSweepState('/nonexistent/nope.json'), { cursor: 0, run: 0, chunkCount: 0, jobs: {} });
});

test('staleByLastmod skips only what is provably older than cutoff minus slack', () => {
  const cutoff = Date.parse('2026-08-01');
  assert.equal(staleByLastmod('2026-06-01', cutoff, 7), true);
  assert.equal(staleByLastmod('2026-07-28', cutoff, 7), false, 'inside the slack margin must be kept');
  assert.equal(staleByLastmod('2026-09-01', cutoff, 7), false);
});

test('staleByLastmod never skips on an absent or unparseable date', () => {
  const cutoff = Date.parse('2026-08-01');
  assert.equal(staleByLastmod(null, cutoff), false);
  assert.equal(staleByLastmod('not-a-date', cutoff), false);
});
