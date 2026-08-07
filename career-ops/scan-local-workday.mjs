// Title-blind, location-first pull across the Baltimore/DC Workday tenants.
//
// Why this exists: scan-ats-full.mjs filters on portals.yml title_filter.positive,
// which is built from the user's own target titles — so it can only ever return
// titles he already named. Against T. Rowe Price's tenant it returned ZERO while
// the tenant actually carries 83 Maryland postings. This asks the opposite
// question: what is open near Baltimore, whatever it happens to be called?
//
// No title filter. Location and freshness only.
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Targeting lives in portals.yml (User Layer). This file is System Layer and
// gets overwritten by `update-system.mjs apply`, so the tenant list and the
// location rules must not live here. The constants below are only a fallback
// for an install that has not configured `local_workday` yet.
const PORTALS = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');
const cfg = (() => {
  try {
    if (!existsSync(PORTALS)) return {};
    return yaml.load(readFileSync(PORTALS, 'utf8'))?.local_workday || {};
  } catch { return {}; }
})();

const TENANTS_FALLBACK = [
  ['T. Rowe Price', 'troweprice', 'wd5', 'troweprice'],
  ['M&T Bank', 'mtb', 'wd5', 'mtb'],
  ['M&T Bank (campus)', 'mtb', 'wd5', 'campus'],
  ['GBMC HealthCare', 'gbmc', 'wd1', 'gbmc'],
  ['Gilchrist / GBMC', 'gbmc', 'wd1', 'gilchristinova'],
  ['Brown Advisory', 'brownadvisory', 'wd1', 'brown'],
  // Probed 2026-08-06 across 8 instances x 14 site paths: no working CXS
  // endpoint. The tenant names are real but the sites 422, so these two are
  // either off Workday now or behind a path the public API does not expose.
  // Left in place, and deliberately noisy, because both are significant
  // Baltimore employers — a silently-absent employer looks identical to one
  // that simply is not hiring.
  ['Whiting-Turner', 'whiting', 'wd1', 'external'],
  ['Erickson Senior Living', 'erickson', 'wd5', 'external'],
  // wd1 returns 422; wd503 is the live instance (both are in the public
  // dataset, and only the second one works).
  ['Catalyte', 'catalyte', 'wd503', 'catalyte'],
  ['Goucher College', 'goucher', 'wd1', 'goucher_careers'],
  ['Loyola University MD', 'loyola', 'wd5', 'external'],
  ['University of Maryland', 'umd', 'wd1', 'umcp'],
  ['Mercy', 'mercy', 'wd1', 'mercycareers'],
  ['Novavax', 'novavax', 'wd1', 'careers'],
  ['GEICO', 'geico', 'wd1', 'external'],
  ['CACI', 'caci', 'wd1', 'external'],
  ['GDIT', 'gdit', 'wd5', 'external_career_site'],
  ['GDIT (early talent)', 'gdit', 'wd5', 'gdit_earlytalent'],
  ['ManTech', 'mantech', 'wd1', 'external'],
  ['MITRE', 'mitre', 'wd5', 'mitre'],
  ['Guidehouse', 'guidehouse', 'wd1', 'external'],
  ['ICF', 'icf', 'wd5', 'icfexternal_career_site'],
  ['Leidos', 'leidos', 'wd5', 'external'],
  ['Truist', 'truist', 'wd1', 'careers'],
  ['PNC', 'pnc', 'wd5', 'external'],
  ['Wegmans', 'wegmans', 'wd1', 'wegmans'],
  ['Wawa', 'wawa', 'wd1', 'careers'],
  ['Washington Gas (AltaGas)', 'wgl', 'wd5', 'altagas'],
];

const TENANTS = Array.isArray(cfg.tenants) && cfg.tenants.length
  ? cfg.tenants.map((t) => [t.name, t.tenant, t.instance, t.site])
  : TENANTS_FALLBACK;

// Maryland / DC / near-in Virginia. Anchored to state tokens, never bare city
// names — the same collision that let "Columbia" match South Carolina.
// Both rules come from portals.yml `local_workday`; these are the fallback.
const DEFAULT_INCLUDE = String.raw`(,\s*MD\b)|Maryland|Baltimore|Owings Mills|Towson|Columbia,\s*MD|Annapolis|Hunt Valley|Linthicum|Sparks|Hanover,\s*MD|Bethesda|Rockville|Silver Spring|Gaithersburg|Fort Meade|Laurel,\s*MD|Washington,?\s*D\.?C\.?|District of Columbia|,\s*VA\b|Virginia`;
const DEFAULT_EXCLUDE = String.raw`Richmond|Norfolk|Virginia Beach|Roanoke|Blacksburg|Charlottesville|Lynchburg|Newport News|Chesapeake|Hampton`;
const LOCAL = new RegExp(cfg.include || DEFAULT_INCLUDE, 'i');
// Virginia is broad; drop the far-southwest metros that are not commutable.
const FAR_VA = new RegExp(cfg.exclude || DEFAULT_EXCLUDE, 'i');

function daysAgo(postedOn) {
  if (!postedOn) return null;
  const s = String(postedOn);
  if (/today/i.test(s)) return 0;
  if (/yesterday/i.test(s)) return 1;
  const m = s.match(/(\d+)\+?\s*days?/i);
  return m ? Number(m[1]) : null;
}

async function page(tenant, inst, site, offset) {
  const url = `https://${tenant}.${inst}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
    });
    if (!r.ok) return { err: r.status };
    return await r.json();
  } catch (e) {
    return { err: e.name === 'AbortError' ? 'timeout' : 'neterr' };
  } finally { clearTimeout(t); }
}

const MAX_PAGES = Number(cfg.max_pages_per_tenant) > 0 ? Number(cfg.max_pages_per_tenant) : 60;
const results = [];
const summary = [];

for (const [name, tenant, inst, site] of TENANTS) {
  const first = await page(tenant, inst, site, 0);
  if (first.err) { summary.push(`${name.padEnd(26)} ERR ${first.err}`); continue; }
  const total = first.total ?? 0;
  let local = 0, scanned = 0, truncated = false;
  const pages = Math.min(Math.ceil(total / 20), MAX_PAGES);
  if (Math.ceil(total / 20) > MAX_PAGES) truncated = true;

  for (let p = 0; p < pages; p++) {
    const j = p === 0 ? first : await page(tenant, inst, site, p * 20);
    if (j.err) break;
    for (const it of j.jobPostings || []) {
      scanned++;
      const loc = it.locationsText || '';
      if (!LOCAL.test(loc)) continue;
      if (FAR_VA.test(loc) && !/,\s*MD\b|Maryland|Baltimore|D\.?C\.?/i.test(loc)) continue;
      local++;
      results.push({
        company: name, title: it.title, location: loc,
        days: daysAgo(it.postedOn), postedOn: it.postedOn,
        url: `https://${tenant}.${inst}.myworkdayjobs.com/${site}${it.externalPath}`,
      });
    }
  }
  summary.push(`${name.padEnd(26)} ${String(total).padStart(5)} total  ${String(local).padStart(4)} local${truncated ? '  (TRUNCATED)' : ''}`);
  console.error(summary[summary.length - 1]);
}

results.sort((a, b) => (a.days ?? 999) - (b.days ?? 999));
// Root, not data/: data/* is gitignored, and the scheduled workflow has to be
// able to commit this so results survive between runs the way the Owings Mills
// store does. Same class of content as owings-mills-store.json — public job
// postings, no personal data.
writeFileSync(path.join(ROOT, 'local-workday-store.json'), JSON.stringify(results, null, 2));

console.log('\n' + summary.join('\n'));
console.log(`\n${results.length} local postings across ${TENANTS.length} tenants\n`);
const fresh = results.filter(r => r.days !== null && r.days <= 21);
console.log(`--- posted within 21 days (${fresh.length}) ---`);
for (const r of fresh)
  console.log(`${String(r.days).padStart(3)}d  ${r.company.slice(0, 22).padEnd(22)} ${r.title.slice(0, 52).padEnd(52)} ${r.location.slice(0, 24)}`);
