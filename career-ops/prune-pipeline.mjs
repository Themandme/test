// Retroactively re-filter data/pipeline.md through the CORRECTED location
// filter and the 60-day age policy.
//
// The pipeline accumulated under two defects: allow-list city names that also
// matched other states (and matched the employer's name via the URL slug), and
// the old AI-startup roster. Entries already written are not re-filtered by
// scan.mjs, so they have to be swept out here.
//
// Default is a dry run. Pass --apply to write.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
import { buildLocationFilter, buildPostingAgeFilter } from './scan.mjs';

const PIPE = process.env.CAREER_OPS_PIPELINE || path.join(ROOT, 'data', 'pipeline.md');
const APPLY = process.argv.includes('--apply');

const portals = yaml.load(fs.readFileSync(process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml'), 'utf8'));
const locOk = buildLocationFilter(portals.location_filter);
const ageOk = buildPostingAgeFilter(portals.max_posting_age_days);

const raw = fs.readFileSync(PIPE, 'utf8');
const lines = raw.split('\n');
const pendingIdx = lines.findIndex((l) => /^## Pending/.test(l));
const processedIdx = lines.findIndex((l) => /^## Processed/.test(l));
if (pendingIdx === -1 || processedIdx === -1) throw new Error('pipeline.md: expected ## Pending and ## Processed');

const head = lines.slice(0, pendingIdx + 1);
const body = lines.slice(pendingIdx + 1, processedIdx);
const tail = lines.slice(processedIdx);

const kept = [];
const dropped = [];
const noLocation = [];
for (const rawLine of body) {
  // Some rows were written with the posted stamp twice ("| posted: X | posted: X").
  const line = rawLine.replace(/\|\s*posted:\s*(\S+)\s*\|\s*posted:\s*\S+\s*$/, '| posted: $1');

  // Five fields = with location; four = the iCIMS shape, which carries none.
  // The location-less rows are NOT dropped: career-ops' rule is to not penalize
  // missing data, and one of them is the Johns Hopkins Data Quality Analyst —
  // the strongest local match found so far. They are counted and listed instead.
  let m = line.match(/^- \[ \] (\S+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*posted:\s*(\S+)\s*$/);
  if (!m) {
    const four = line.match(/^- \[ \] (\S+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*posted:\s*(\S+)\s*$/);
    if (four) {
      const ts4 = Date.parse(four[4]);
      if (!ageOk(Number.isFinite(ts4) ? ts4 : undefined)) {
        dropped.push({ company: four[2], title: four[3], location: '(none)', posted: four[4], reasons: [`age:${four[4]}`] });
      } else {
        noLocation.push({ company: four[2], title: four[3], posted: four[4] });
        kept.push(line);
      }
      continue;
    }
    // Third shape, from the Indeed/Apify source: "url | company | title |
    // location" with no posted stamp. These were previously surviving only by
    // falling through as unparsed — and they are the best rows in the file
    // (JHU, Welldoc, Blue Sky, Altruix are all genuinely local). Filter them on
    // location; the age rule cannot apply with no date.
    const noDate = line.match(/^- \[ \] (\S+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*$/);
    if (noDate && !/posted:/.test(line)) {
      const [, u2, c2, t2, l2] = noDate;
      if (!locOk(l2, u2, t2)) dropped.push({ company: c2, title: t2, location: l2, posted: '(none)', reasons: [`location:${l2}`] });
      else kept.push(line);
      continue;
    }
    kept.push(line);                               // blank lines / headings
    continue;
  }
  const [, url, company, title, location, posted] = m;
  const ts = Date.parse(posted);
  const reasons = [];
  if (!locOk(location, url, title)) reasons.push(`location:${location}`);
  if (!ageOk(Number.isFinite(ts) ? ts : undefined)) reasons.push(`age:${posted}`);
  if (reasons.length) dropped.push({ company, title, location, posted, reasons });
  else kept.push(line);
}

const entries = (a) => a.filter((l) => l.startsWith('- [ ]')).length;
console.log(`pending entries: ${entries(body)} → ${entries(kept)} kept, ${dropped.length} dropped\n`);

const byReason = { location: 0, age: 0, both: 0 };
for (const d of dropped) {
  const hasLoc = d.reasons.some((r) => r.startsWith('location'));
  const hasAge = d.reasons.some((r) => r.startsWith('age'));
  byReason[hasLoc && hasAge ? 'both' : hasLoc ? 'location' : 'age']++;
}
console.log(`  location only: ${byReason.location}   age only: ${byReason.age}   both: ${byReason.both}\n`);

console.log('sample of dropped (first 30):');
for (const d of dropped.slice(0, 30))
  console.log(`  ${d.company.slice(0, 26).padEnd(26)} ${d.title.slice(0, 38).padEnd(38)} ${d.location.slice(0, 30).padEnd(30)} ${d.posted}`);

console.log(`\nkept with NO location field (${noLocation.length}) — not verifiable as local, review by hand:`);
for (const n of noLocation)
  console.log(`  ${n.company.slice(0, 30).padEnd(30)} ${n.title.slice(0, 46).padEnd(46)} ${n.posted}`);

console.log('\nsurviving locations (tally):');
const tally = {};
for (const l of kept) {
  const m = l.match(/\|\s*([^|]*?)\s*\|\s*posted:/);
  if (m) tally[m[1]] = (tally[m[1]] || 0) + 1;
}
for (const [loc, n] of Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 25))
  console.log(`  ${String(n).padStart(3)}  ${loc}`);

if (APPLY) {
  fs.copyFileSync(PIPE, PIPE + '.bak');
  fs.writeFileSync(PIPE, [...head, ...kept, ...tail].join('\n'));
  console.log(`\nwritten. backup at ${PIPE}.bak`);
} else {
  console.log('\ndry run — pass --apply to write');
}
