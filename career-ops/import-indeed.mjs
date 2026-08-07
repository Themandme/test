#!/usr/bin/env node

/**
 * import-indeed.mjs — turn Indeed MCP search output into a scanner source.
 *
 * Indeed is reached through an MCP connector, which only the agent can call —
 * there is no key a cron job could use. So the split is:
 *
 *   1. the agent runs `search_jobs` and appends the raw result blocks to
 *      data/indeed-raw.md (append-only; every capture is kept)
 *   2. this script parses that file, normalises each posting to the same shape
 *      the other scanners emit, filters on location, and writes
 *      indeed-store.json
 *
 * That keeps the MCP-only step honest — nothing is invented between the search
 * and the store, and re-running the parse never needs the connector.
 *
 * Location-first, like the other sweeps: no title filter. Filtering on the
 * user's own target titles is the mirror that made scan-ats-full return zero
 * against a tenant carrying 83 Maryland openings.
 *
 * Usage:
 *   node import-indeed.mjs                 # data/indeed-raw.md → indeed-store.json
 *   node import-indeed.mjs <in.md> <out.json>
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Positional args only — otherwise `--pipeline` is read as the input path and
// the script reports a missing capture file that is sitting right there.
const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const SRC = positional[0] || path.join(ROOT, 'data/indeed-raw.md');
const DEST = positional[1] || path.join(ROOT, 'indeed-store.json');

const PORTALS = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');
const cfg = (() => {
  try {
    if (!existsSync(PORTALS)) return {};
    return yaml.load(readFileSync(PORTALS, 'utf8'))?.local_workday || {};
  } catch { return {}; }
})();

// Same rules as the Workday sweep — one definition of "local" across sources.
const DEFAULT_INCLUDE = String.raw`(,\s*MD\b)|Maryland|Baltimore|Owings Mills|Towson|Columbia,\s*MD|Annapolis|Hunt Valley|Linthicum|Sparks|Hanover,\s*MD|Bethesda|Rockville|Silver Spring|Gaithersburg|Fort Meade|Laurel,\s*MD|Washington,?\s*D\.?C\.?|District of Columbia|,\s*VA\b|Virginia`;
const DEFAULT_EXCLUDE = String.raw`Richmond|Norfolk|Virginia Beach|Roanoke|Blacksburg|Charlottesville|Lynchburg|Newport News|Chesapeake|Hampton`;
const LOCAL = new RegExp(cfg.include || DEFAULT_INCLUDE, 'i');
const FAR = new RegExp(cfg.exclude || DEFAULT_EXCLUDE, 'i');

/** "$45,000 - $48,000 a year" / "$23 - $25 an hour" / "From $17 an hour" */
export function parseCompensation(raw) {
  if (!raw || /^n\/?a$/i.test(raw.trim())) return null;
  const unit = /an hour|hourly|\/hr/i.test(raw) ? 'HOUR'
    : /a year|annually|\/yr/i.test(raw) ? 'YEAR' : null;
  const nums = [...raw.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  if (!nums.length || !unit) return null;
  // "From $17 an hour" is a floor, not a range — do not invent a ceiling.
  return { min: nums[0], max: nums.length > 1 ? nums[1] : nums[0], unit };
}

/** "August 05, 2026" → whole days before `now`. */
export function parsePostedOn(raw, now = new Date()) {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 86400000));
}

const FIELD = (block, label) => {
  const m = block.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
  return m ? m[1].trim() : '';
};

export function parseIndeed(text, now = new Date()) {
  const out = [];
  // Blocks are delimited by the Job Title line; split on it and keep the rest.
  const chunks = String(text).split(/\*\*Job Title:\*\*/).slice(1);
  for (const chunk of chunks) {
    const block = `**Job Title:**${chunk}`;
    const title = FIELD(block, 'Job Title');
    const company = FIELD(block, 'Company');
    const location = FIELD(block, 'Location');
    const url = FIELD(block, 'View Job URL');
    if (!title || !company || !url) continue;
    out.push({
      company, title, location, url,
      days: parsePostedOn(FIELD(block, 'Posted on'), now),
      // Keep the real timestamp. Reconstructing a date from the rounded day
      // count shifts it by up to 24h — a posting dated August 06 came out as
      // 2026-08-05 in the pipeline.
      postedAtMs: (() => { const t = Date.parse(FIELD(block, 'Posted on')); return Number.isFinite(t) ? t : null; })(),
      postedOn: FIELD(block, 'Posted on') || null,
      employmentType: FIELD(block, 'Job Type') || null,
      salary: parseCompensation(FIELD(block, 'Compensation')),
    });
  }
  return out;
}

export function isLocal(loc) {
  const s = String(loc || '');
  if (!LOCAL.test(s)) return false;
  if (FAR.test(s) && !/,\s*MD\b|Maryland|Baltimore|D\.?C\.?/i.test(s)) return false;
  return true;
}

// Same key as the dashboard's cross-source dedupe, so a role Indeed and
// Workday both carry collapses instead of appearing twice.
const key = (j) => [
  String(j.company || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]/g, ''),
  String(j.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(),
  String(j.location || '').split(',')[0].toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(),
].join('|');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(SRC)) {
    console.error(`No capture file at ${SRC}. Run the Indeed searches first and append their output there.`);
    process.exit(1);
  }
  const parsed = parseIndeed(readFileSync(SRC, 'utf8'));
  const local = parsed.filter((j) => isLocal(j.location));
  const byKey = new Map();
  for (const j of local) {
    const k = key(j);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, j); continue; }
    if (prev.days === null && j.days !== null) { prev.days = j.days; prev.postedAtMs = j.postedAtMs; }
    else if (prev.days !== null && j.days !== null && j.days < prev.days) { prev.days = j.days; prev.postedAtMs = j.postedAtMs; }
    if (!prev.salary && j.salary) prev.salary = j.salary;
  }
  const rows = [...byKey.values()].sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));
  writeFileSync(DEST, JSON.stringify(rows, null, 2));
  console.log(`wrote ${DEST}`);
  console.log(`  parsed=${parsed.length} local=${local.length} deduped=${rows.length}`);
  console.log(`  with pay=${rows.filter((r) => r.salary).length} | within 21d=${rows.filter((r) => r.days !== null && r.days <= 21).length}`);

  // --pipeline: hand the rows to the pipeline through scan.mjs's own writers,
  // never by editing data/pipeline.md directly. That keeps the lock, the dedup
  // history and the row format identical to every other scanner (Pipeline
  // Integrity rule 1).
  if (process.argv.includes('--pipeline')) {
    const { appendToPipeline, appendToScanHistory, loadSeenUrls, normalizeUrlForDedup } =
      await import('./scan.mjs');
    // loadSeenUrls returns { seen, recheckEligible }, not a bare Set.
    const { seen } = loadSeenUrls();
    const offers = rows
      .filter((r) => !seen.has(normalizeUrlForDedup(r.url)))
      .map((r) => ({
        url: r.url, company: r.company, title: r.title, location: r.location,
        salary: r.salary,
        postedAt: r.postedAtMs ?? undefined,
        note: 'indeed',
      }));
    if (offers.length === 0) {
      console.log('  pipeline: nothing new — every row already seen');
    } else {
      await appendToPipeline(offers);
      appendToScanHistory(offers, new Date().toISOString().slice(0, 10));
      console.log(`  pipeline: +${offers.length} new (${rows.length - offers.length} already seen)`);
    }
  }
}
