// Collects every gitignored user-layer data source the dashboard renders into a
// single JSON blob, so the artifact ships self-contained (no fetch at runtime —
// artifacts run under a CSP that blocks external hosts anyway).
//
// Reads only; writes one file. Nothing here mutates the tracker or pipeline.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// Identity is read from the user layer at run time, never baked in here — this
// file is System Layer and gets overwritten by `update-system.mjs apply`.
function readProfile() {
  const y = readFileSync(join(ROOT, 'config/profile.yml'), 'utf8');
  const field = (k) => {
    const m = y.match(new RegExp(`^\\s{2}${k}:\\s*"?(.*?)"?\\s*$`, 'm'));
    return m ? m[1] : '';
  };
  return { name: field('full_name'), location: field('location') };
}

// --- tracker: data/applications.md -------------------------------------------
// Parsed, never written. The canonical write paths stay merge-tracker.mjs and
// set-status.mjs (Pipeline Integrity rules 1-2).
function parseTracker() {
  const lines = readFileSync(join(ROOT, 'data/applications.md'), 'utf8').split('\n');
  return lines
    .filter((l) => /^\|\s*\d+\s*\|/.test(l))
    .map((l) => {
      const c = l.split('|').slice(1, -1).map((s) => s.trim());
      return {
        num: Number(c[0]), date: c[1], company: c[2], role: c[3],
        score: c[4], status: c[5], pdf: c[6] === '✅',
        report: (c[7].match(/\(([^)]+)\)/) || [, null])[1],
        notes: c[8],
      };
    })
    .sort((a, b) => a.num - b.num);
}

// --- reports: pull the Machine Summary YAML block ----------------------------
// Hand-rolled scalar/list reader rather than a YAML dep: the block is written by
// this system to a fixed shape, so the surface is known and small.
function parseReports() {
  const dir = join(ROOT, 'reports');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{3}-.*\.md$/.test(f)).sort().map((f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    const yaml = (text.match(/## Machine Summary\s*```yaml\n([\s\S]*?)```/) || [, ''])[1];
    const out = { file: f, num: Number(f.slice(0, 3)) };
    let listKey = null;
    for (const raw of yaml.split('\n')) {
      const item = raw.match(/^\s+-\s+"?(.*?)"?\s*$/);
      if (item && listKey) { out[listKey].push(item[1]); continue; }
      const kv = raw.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      const [, k, v] = kv;
      if (v === '' ) { out[k] = []; listKey = k; }
      else if (v === '[]') { out[k] = []; listKey = null; }
      else {
        const scalar = v.replace(/^"|"$/g, '');
        // YAML `null` is absence, not the four-letter string — without this the
        // dashboard prints "null" where a field was simply never filled in.
        out[k] = scalar === 'null' || scalar === '~' ? null : scalar;
        listKey = null;
      }
    }
    // URL lives in the header, not the YAML block.
    out.url = (text.match(/\*\*URL:\*\*\s*(\S+)/) || [, null])[1];
    return out;
  });
}

// --- education strapline: first Education entry in cv.md ---------------------
// Reformulated from cv.md rather than restated here, so the dashboard can never
// disagree with the CV it was built from.
function educationLine() {
  const cv = readFileSync(join(ROOT, 'cv.md'), 'utf8');
  const block = (cv.match(/^##\s+Education\s*$([\s\S]*?)(?=^##\s|\Z)/m) || [, ''])[1];
  const org = (block.match(/\*\*(.+?)\*\*\s*\|\s*(.+)/) || []).slice(1);
  const degree = (block.match(/^(?!\*\*)([A-Z][^\n|*]+)$/m) || [, ''])[1].trim();
  if (!org.length) return degree;
  const short = (org[0].match(/\(([^)]+)\)/) || [, org[0]])[1];
  return [degree, `${short} (${org[1].trim()})`].filter(Boolean).join(', ');
}

// --- pipeline: data/pipeline.md ----------------------------------------------
function parsePipeline() {
  return readFileSync(join(ROOT, 'data/pipeline.md'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- [ ] '))
    .map((l) => {
      const [url, company, title, location, posted] = l.slice(6).split('|').map((s) => s.trim());
      return { url, company, title, location, posted: (posted || '').replace(/^posted:\s*/, '') || null };
    });
}

// Optional sources degrade to an empty set rather than throwing: a fresh
// install has none of them, and a scan that has not run yet should not break
// the dashboard build.
const readJsonOr = (p, fallback) => {
  try { return readJson(p); } catch { return fallback; }
};

const out = {
  generatedAt: new Date().toISOString(),
  profile: { ...readProfile(), degree: educationLine() },
  tracker: parseTracker(),
  reports: parseReports(),
  pipeline: parsePipeline(),
  owingsMills: readJsonOr('data/owings-mills.json', { jobs: [] }),
  remoteUs: readJsonOr('data/remote-us.json', { jobs: [] }),
  // Legacy Apify pull (12 rows, free tier). Superseded by indeedStore below,
  // which comes from the Indeed MCP connector via import-indeed.mjs.
  indeed: readJsonOr('data/indeed.json', { jobs: [] }),
  indeedStore: readJsonOr('indeed-store.json', []),
  // Maryland state government via JobAps — the only source that publishes a
  // real filing deadline, so "still open" is stated rather than inferred.
  marylandGov: readJsonOr('maryland-gov-store.json', []),
  // County and city government via NEOGOV (scan-neogov.mjs) — Baltimore County,
  // CCBC, Howard, Anne Arundel, Montgomery, M-NCPPC, Frederick, DC.
  neogov: readJsonOr('neogov-store.json', []),
  // Title-blind local Workday pull (scan-local-workday.mjs). Flat array, and
  // its records carry `days` (age at fetch) rather than a posted date.
  // Committed store first (written by scan-local-workday.mjs and refreshed by
  // the scheduled workflow); the old gitignored path is the fallback.
  localWorkday: readJsonOr('local-workday-store.json', readJsonOr('data/local-workday.json', [])),
};

const dest = process.argv[2] || join(ROOT, 'output/dash-data.json');
writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(`wrote ${dest}`);
console.log(`  tracker=${out.tracker.length} reports=${out.reports.length} pipeline=${out.pipeline.length}`);
console.log(`  owingsMills=${out.owingsMills.jobs.length} remoteUs=${out.remoteUs.jobs.length} indeed=${out.indeed.jobs.length}`);
console.log(`  localWorkday=${out.localWorkday.length} indeedStore=${out.indeedStore.length} marylandGov=${out.marylandGov.length} neogov=${out.neogov.length}`);
