#!/usr/bin/env node

/**
 * snapshot-data.mjs — copy the live user-layer data/ into a timestamped backup.
 *
 * Why this exists: `test-all.mjs` runs upgrade tests that copy fixture state
 * into the workspace, and on 2026-08-08 that overwrote `data/applications.md`
 * and `data/follow-ups.md` with fixture rows ("Acme / Beta / Gama"), destroying
 * 17 real tracker entries. They were only recoverable because an unrelated
 * dashboard build happened to hold a snapshot.
 *
 * The suite is not going to stop doing that, so the guard belongs here: take a
 * copy first, and the same failure becomes a restore instead of a loss.
 *
 * Snapshots land in `data-snapshots/` (gitignored — this is user data, and the
 * Data Contract keeps `data/*` out of the repo).
 *
 * Usage:
 *   node snapshot-data.mjs              # snapshot now
 *   node snapshot-data.mjs --list       # show what is kept
 *   node snapshot-data.mjs --restore <id>
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'data');
const DEST_ROOT = path.join(ROOT, 'data-snapshots');

// Enough history to cover "the suite ran a few times before anyone noticed",
// without letting copies of a 700 KB pipeline accumulate forever.
const KEEP = 10;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function listSnapshots() {
  if (!existsSync(DEST_ROOT)) return [];
  return readdirSync(DEST_ROOT)
    .filter((d) => statSync(path.join(DEST_ROOT, d)).isDirectory())
    .sort();
}

export function snapshot() {
  if (!existsSync(SRC)) throw new Error(`no data/ directory at ${SRC}`);
  const id = stamp();
  const dest = path.join(DEST_ROOT, id);
  mkdirSync(dest, { recursive: true });
  cpSync(SRC, dest, { recursive: true });

  // Prune oldest first, so the newest KEEP always survive.
  const all = listSnapshots();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
    rmSync(path.join(DEST_ROOT, old), { recursive: true, force: true });
  }
  return { id, dest, files: readdirSync(dest).length };
}

export function restore(id) {
  const src = path.join(DEST_ROOT, id);
  if (!existsSync(src)) throw new Error(`no snapshot "${id}" — run --list`);
  // Restore is additive per-file rather than a wipe-and-replace: a partial
  // clobber should not cost the files the suite left alone.
  cpSync(src, SRC, { recursive: true });
  return { id, files: readdirSync(src).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , flag, arg] = process.argv;
  if (flag === '--list') {
    const all = listSnapshots();
    if (!all.length) console.log('no snapshots yet');
    else all.forEach((d) => console.log(' ', d, `(${readdirSync(path.join(DEST_ROOT, d)).length} entries)`));
  } else if (flag === '--restore') {
    if (!arg) { console.error('usage: node snapshot-data.mjs --restore <id>'); process.exit(1); }
    const r = restore(arg);
    console.log(`restored ${r.files} entries from ${r.id}`);
  } else {
    const s = snapshot();
    console.log(`snapshot ${s.id} — ${s.files} entries → data-snapshots/${s.id}`);
    console.log(`  keeping the newest ${KEEP}; restore with: node snapshot-data.mjs --restore ${s.id}`);
  }
}
