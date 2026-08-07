#!/usr/bin/env node

/**
  * build-dash-html.mjs — renders the job-search dashboard from the blob that
 * build-dash-data.mjs collects.
 *
 * Two scripts, deliberately: build-dash-data.mjs reads the gitignored user
 * layer (tracker, reports, CV, scan results) and emits one JSON file; this one
 * turns that JSON into a self-contained HTML page. Nothing user-specific is
 * baked in here — this file is System Layer and gets overwritten by
 * `update-system.mjs apply`, so identity, scores and listings all arrive
 * through the blob at run time.
 *
 * The page ships with no external requests (fonts, scripts, styles are all
 * inline) so it renders offline and under an artifact CSP.
 *
 * Usage:
 *   node build-dash-data.mjs                 # writes output/dash-data.json
 *   node build-dash-html.mjs                 # writes output/dashboard.html
 *   node build-dash-html.mjs <in.json> <out.html>
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || join(ROOT, 'output/dash-data.json');
const DEST = process.argv[3] || join(ROOT, 'output/dashboard.html');

const d = JSON.parse(readFileSync(SRC, 'utf8'));

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── Freshness ────────────────────────────────────────────────────────
// The operating heuristic for this search: in a competitive entry-level
// market an old posting usually means filled or unattended. Age drives the
// ordering everywhere on this page, so it is computed once, here.
const NOW = new Date(d.generatedAt || Date.now());
const ageDays = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((NOW - t) / 86400000));
};

// ── Normalise every scan source to one shape ─────────────────────────
// Workday reports anything past a month as "Posted 30+ Days Ago" — an
// open-ended bucket, not an age of exactly 30. Carried through as `censored`
// so the histogram can show it as a floor instead of inventing a spike at
// 22–30 days (553 of 2,211 records land here).
const localWorkday = (d.localWorkday || []).map((j) => ({
  company: j.company, title: j.title, location: j.location, url: j.url,
  days: typeof j.days === 'number' ? j.days : null,
  censored: /\d+\+/.test(String(j.postedOn || '')),
  source: 'Workday (local)',
}));
const owingsMills = ((d.owingsMills && d.owingsMills.jobs) || []).map((j) => ({
  company: j.company, title: j.title,
  location: [j.city, j.region].filter(Boolean).join(', '),
  url: j.url, days: ageDays(j.datePosted), salary: j.salary || null,
  source: 'hiring.cafe (local)',
}));
const listings = [...localWorkday, ...owingsMills];

// ── Hireability filter ───────────────────────────────────────────────
// Priority stated by the candidate: "anything I'll get hired for" — so this
// removes what he cannot be hired into, not what pays least. Clearance is a
// hard stop (he holds none); seniority, clinical licensure and deep-specialist
// engineering titles are the other three walls.
const CLEARANCE = /TS\/SCI|TS-SCI|\bPoly(graph)?\b|Top Secret|\bSecret\b|Clearance|Cleared|Full Scope/i;
const SENIOR = /\b(Senior|Sr\.?|Principal|Lead|Staff|Director|Manager|Architect|SME|Chief|Head of|VP|Supervisor|Professor|Attorney|Counsel)\b/i;
const CLINICAL = /\b(RN|Nurse|Nursing|Physician|Surgeon|Clinician|Therapist|Pharmacist|Radiolog|Sonograph|Phlebotom|CNA|LPN|Medical Assistant|Respiratory|Anesthes|Dental|Veterinar|Post.?Doc)\b/i;
const DEEP_TECH = /\b(DevOps|DevSecOps|Cloud Engineer|Software Engineer|Full Stack|Reverse Engineer|Penetration|Malware|Kernel|Firmware|Data Scientist|Machine Learning|Bioinformatics|Electrical Engineer|Mechanical Engineer|Cartographic|Linguist)\b/i;
// Deliberately NOT a list of his target titles. Filtering on those is the
// mirror that made a full ATS sweep return zero against a tenant carrying 83
// Maryland openings — it can only ever return roles already named.
const REACHABLE = /\b(Analyst|Coordinator|Administrator|Assistant|Associate|Specialist|Representative|Teller|Support|Service Desk|Help Desk|Customer|Client|Operations|Business|Data|Reporting|Office|Banker|Clerk|Scheduler|Registrar|Intake|Trainee|Entry|Cashier|Sales|Receptionist)\b/i;

const hireable = (j) => j.title && !CLEARANCE.test(j.title) && !SENIOR.test(j.title)
  && !CLINICAL.test(j.title) && !DEEP_TECH.test(j.title) && REACHABLE.test(j.title);

// ── Proximity to home ────────────────────────────────────────────────
// Home is Owings Mills. Sorting the shortlist by age alone buried the roles
// closest to the door under fresher ones an hour away in Virginia, so
// proximity is ranked FIRST and age breaks the tie inside each ring.
const TIER = [
  // Ring 1 — Owings Mills and the towns immediately around it, ~15 minutes.
  /Owings Mills|Reisterstown|Pikesville|Randallstown|Windsor Mill|Woodlawn|Garrison|Milford Mill|Lochearn|Stevenson, ?MD/i,
  // Ring 2 — greater Baltimore, a commutable drive.
  /Baltimore|Towson|Catonsville|Ellicott City|Columbia, ?MD|Hunt Valley|Lutherville|Timonium|Cockeysville|Sparks|Linthicum|Halethorpe|Arbutus|Glen Burnie|Elkridge|Hanover, ?MD|Annapolis|Dundalk|Parkville|Nottingham|White Marsh|Rosedale|Essex/i,
  // Ring 3 — rest of Maryland.
  /Maryland|, ?MD\b/i,
];
const tierOf = (loc) => {
  const s = String(loc || '');
  for (let i = 0; i < TIER.length; i++) if (TIER[i].test(s)) return i;
  return TIER.length;              // Ring 4 — DC, Virginia, remote
};
const TIER_LABEL = ['Owings Mills area', 'Greater Baltimore', 'Rest of Maryland', 'DC / Virginia / remote'];

const shortlist = listings
  .filter((j) => hireable(j) && j.days !== null && j.days <= 21)
  .map((j) => ({ ...j, tier: tierOf(j.location) }))
  .sort((a, b) => a.tier - b.tier || a.days - b.days);

// ── Hireability ──────────────────────────────────────────────────────
// Ranks the home ring by probability of an OFFER, not by desirability and not
// by date. Grounded in what cv.md actually evidences: ~15 months of register
// customer service across Walmart, Target and Chick-fil-A, ~1 year of CRM and
// account administration at Constellation, and a BS in Information Systems.
//
// This is title-and-employer inference, not a read of each posting — the only
// rows here verified against their JD are the M&T ones (reports 015-017).
// Treat a band as "worth the effort in this order", never as a promise.
const HIRE_BANDS = [
  {
    key: 'blocked',
    label: 'Blocked — a credential he cannot obtain in time',
    note: 'A state licence, active enrolment, or military enlistment. Nothing here is a judgement about the work being beneath him — only about a wall no application clears.',
    test: (j) => /Athletic Trainer|Student Assistant|National Guard|Chemical Operations Specialist/i.test(j.title),
  },
  {
    key: 'direct',
    label: 'Direct match — his exact prior job, high-volume hiring',
    note: 'Register and floor customer service at employers that hire continuously. The bar is months of service experience; he has roughly fifteen.',
    test: (j) => /Cashier|Customer Service|Retail Sales|Sales Associate|Merchandise|Merchandising|Front End|Service Deli|Food Service|Receiving Clerk|Membership Clerk|Stocking|Shoe Associate|Photo Specialist|Team Associate|Home Coordinator|Domestic Coordinator|Men's and Kids/i.test(j.title),
  },
  {
    key: 'training',
    label: 'Hires without prior experience — paid training',
    note: 'Direct support, recovery support and care roles. Typically a diploma and a driver\u2019s licence, trained on the job, and they hire year-round. Confirm the requirements on the posting — these have not been read individually.',
    test: (j) => /Direct Support|Recovery Support|Support Professional|Caregiver|Care Assistant/i.test(j.title),
  },
  {
    key: 'adjacent',
    label: 'Adjacent — entry professional, service or admin core',
    note: 'Coordinator, office and processing seats. His Constellation year is the argument; the work is administrative rather than analytical.',
    test: (j) => /Office (Assistant|Coordinator)|Receptionist|Front Desk|Coordinator|Accounts Receivable|Order Processor|Warranty|Fulfillment|Warehouse Support|Shipping|Management Trainee|Banker|Teller|Membership|Service Desk|Loss Prevention|Security Specialist/i.test(j.title),
  },
  {
    key: 'gated',
    label: 'Degree-relevant but gated on years',
    note: 'Uses the Information Systems degree. Most ask for experience he does not have yet — see the evaluated reports for the ones already checked.',
    test: () => true,
  },
];
const bandOf = (j) => HIRE_BANDS.findIndex((b) => b.test(j));

// Walmart is excluded at his request — a former employer, but not somewhere
// he wants to return to, so it is not a lead worth ranking.
const hourly = (j) => {
  const s = j.salary;
  if (!s || (!s.min && !s.max)) return null;
  const v = Number(s.max || s.min);
  if (!Number.isFinite(v)) return null;
  return /YEAR/i.test(s.unit || '') ? v / 2080 : v;   // normalise to $/hr
};
const nearHome = shortlist
  .filter((j) => j.tier === 0 && !/^Walmart$/i.test(j.company || ''))
  .map((j) => ({ ...j, band: bandOf(j), rate: hourly(j) }));
// Blocked rows sink to the bottom; everything else ranks by band, then recency.
const BLOCKED = 0;
const nearHomeRanked = [...nearHome].sort((a, b) => {
  const ab = a.band === BLOCKED ? 99 : a.band;
  const bb = b.band === BLOCKED ? 99 : b.band;
  if (ab !== bb) return ab - bb;
  // Money is the stated priority, so the best-paying known rate leads each
  // band; postings with no published rate fall in behind, newest first.
  if (a.rate !== b.rate) {
    if (a.rate === null) return 1;
    if (b.rate === null) return -1;
    return b.rate - a.rate;
  }
  return a.days - b.days;
});
const baltimore = shortlist.filter((j) => j.tier === 1);

// ── Aggregates ───────────────────────────────────────────────────────
// Last bucket is open-ended on purpose: it absorbs both the exact ages past 30
// and Workday's censored "30+", which cannot be placed more precisely.
const BUCKETS = [
  ['0–7 days', (j) => !j.censored && j.days <= 7],
  ['8–14', (j) => !j.censored && j.days > 7 && j.days <= 14],
  ['15–21', (j) => !j.censored && j.days > 14 && j.days <= 21],
  ['22–29', (j) => !j.censored && j.days > 21 && j.days < 30],
  ['30+', (j) => j.censored || j.days >= 30],
];
const dated = listings.filter((j) => j.days !== null);
const ageHistogram = BUCKETS.map(([label, test]) => ({ label, n: dated.filter(test).length }));
const censoredCount = dated.filter((j) => j.censored).length;

const byEmployer = Object.entries(
  shortlist.reduce((acc, j) => { acc[j.company] = (acc[j.company] || 0) + 1; return acc; }, {}),
).map(([company, n]) => ({ company, n })).sort((a, b) => b.n - a.n).slice(0, 12);

const reports = (d.reports || []).slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
const fresh7 = dated.filter((j) => j.days <= 7).length;

// ── Chart builders ───────────────────────────────────────────────────
// Single series throughout, so one hue and no legend (the title names it).
// Both hues validated against their own surface with the palette validator:
// light #2a78d6 and dark #3987e5 each pass lightness band, chroma floor and
// the 3:1 contrast gate.
function vBars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return `<div class="vbars">${rows.map((r) => {
    const pct = (r.n / max) * 100;
    return `<div class="vbar" tabindex="0" role="img" aria-label="${esc(r.label)}: ${r.n} postings">
      <div class="vbar-track"><div class="vbar-fill" style="height:${pct.toFixed(1)}%"></div></div>
      <div class="vbar-val">${r.n}</div>
      <div class="vbar-lab">${esc(r.label)}</div>
      <span class="tip">${esc(r.label)} — ${r.n} postings</span>
    </div>`;
  }).join('')}</div>`;
}

function hBars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar" tabindex="0" role="img" aria-label="${esc(r.company)}: ${r.n} reachable openings">
      <div class="hbar-lab">${esc(r.company)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${((r.n / max) * 100).toFixed(1)}%"></div></div>
      <div class="hbar-val">${r.n}</div>
      <span class="tip">${esc(r.company)} — ${r.n} reachable openings</span>
    </div>`).join('')}</div>`;
}

const decisionClass = (v) => {
  const s = String(v || '').toLowerCase();
  if (s.includes('apply')) return 'good';
  if (s.includes('skip') || s.includes('discard')) return 'critical';
  return 'neutral';
};

const reportRows = reports.map((r) => `
  <tr>
    <td class="num">${esc(r.score ?? '—')}</td>
    <td><strong>${esc(r.company)}</strong><div class="sub">${esc(r.role)}</div></td>
    <td>${esc(r.archetype ?? '')}</td>
    <td>${esc(r.advertised_comp ?? '—')}</td>
    <td><span class="badge ${decisionClass(r.final_decision)}">${esc(r.final_decision ?? '—')}</span></td>
    <td>${esc(r.risk_level ?? '')}</td>
  </tr>`).join('');

const payCell = (j) => {
  const s = j.salary;
  if (!s || (!s.min && !s.max)) return '<span class="dim">—</span>';
  const unit = /YEAR/i.test(s.unit || '') ? '/yr' : '/hr';
  const fmt = (v) => (/YEAR/i.test(s.unit || '') ? `$${Math.round(v / 1000)}k` : `$${Number(v).toFixed(2).replace(/\.00$/, '')}`);
  return s.min && s.max && s.min !== s.max ? `${fmt(s.min)}–${fmt(s.max)}${unit}` : `${fmt(s.max || s.min)}${unit}`;
};
const rowsFor = (list, limit) => list.slice(0, limit).map((j) => `
  <tr>
    <td class="num">${j.days}d</td>
    <td class="num">${payCell(j)}</td>
    <td>${esc(j.company)}</td>
    <td>${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a>` : esc(j.title)}</td>
    <td>${esc(j.location)}</td>
  </tr>`).join('');

// Inside a ring, age is still the thing that decides what is worth chasing —
// so it is shown as its own brackets rather than left implicit in the sort.
const AGE_BRACKETS = [
  ['Posted this week — 0–7 days', (n) => n <= 7],
  ['8–14 days', (n) => n > 7 && n <= 14],
  ['15–21 days', (n) => n > 14 && n <= 21],
];
const bracketedRows = (list, limitPerBracket) => AGE_BRACKETS.map(([label, test]) => {
  const rows = list.filter((j) => test(j.days));
  if (rows.length === 0) return '';
  return `<tr class="bracket"><td colspan="5">${esc(label)} · ${rows.length}</td></tr>`
    + rowsFor(rows, limitPerBracket);
}).join('');

// Owings Mills is bracketed by LOCATION — it stands on its own because of
// where it is, and stays a plain newest-first list. Age brackets belong to
// the other rings, where distance no longer separates anything and recency is
// the only thing left worth sorting on.
// Home ring is grouped by hireability band, each band newest-first inside.
const BAND_ORDER = [...HIRE_BANDS.keys()].filter((i) => i !== BLOCKED).concat(BLOCKED);
const nearHomeRows = BAND_ORDER.map((i) => {
  const band = HIRE_BANDS[i];
  const rows = nearHomeRanked.filter((j) => j.band === i);
  if (rows.length === 0) return '';
  return `<tr class="bracket"><td colspan="5">${esc(band.label)} · ${rows.length}<div class="bracket-note">${esc(band.note)}</div></td></tr>`
    // No cap on the home ring. Rows with no published rate sort last, so any
    // cap here would only ever hide those — which is precisely the set worth
    // seeing, since "no rate published" is not the same as "pays badly".
    + rowsFor(rows, rows.length);
}).filter(Boolean).join('');
const baltimoreRows = bracketedRows(baltimore, 15);
const elsewhere = shortlist.filter((j) => j.tier >= 2);
const elsewhereRows = bracketedRows(elsewhere, 15);

const tierTally = TIER_LABEL.map((label, i) => ({ label, n: shortlist.filter((j) => j.tier === i).length }));

const html = `<title>Job Search Command Center — ${esc(d.profile?.name || '')}</title>
<style>
  :root {
    color-scheme: light;
    --surface: #fcfcfb; --panel: #ffffff; --line: #e6e5e1;
    --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #83817b;
    --series: #2a78d6; --track: #eceae5;
    --good: #0ca30c; --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface: #1a1a19; --panel: #232322; --line: #383835;
      --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #8f8e85;
      --series: #3987e5; --track: #2e2e2c;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface: #1a1a19; --panel: #232322; --line: #383835;
    --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #8f8e85;
    --series: #3987e5; --track: #2e2e2c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px; background: var(--surface); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1120px; margin: 0 auto; }
  header { margin-bottom: 28px; }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .meta { color: var(--ink-2); font-size: 14px; }
  .meta .dim { color: var(--ink-3); }
  h2 { font-size: 17px; margin: 34px 0 4px; letter-spacing: -0.005em; }
  .note { color: var(--ink-2); font-size: 13.5px; margin: 0 0 14px; max-width: 76ch; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px; }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 18px; }
  .kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .kpi .n { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .kpi .k { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
  .kpi .s { color: var(--ink-3); font-size: 12px; margin-top: 4px; }

  /* Vertical bars — 2px surface gap between marks, 4px rounded data-end. */
  .vbars { display: flex; gap: 2px; align-items: flex-end; }
  .vbar { flex: 1; position: relative; text-align: center; padding: 0 4px; outline: none; }
  .vbar-track { height: 150px; display: flex; align-items: flex-end; }
  .vbar-fill { width: 100%; background: var(--series); border-radius: 4px 4px 0 0; min-height: 2px; }
  .vbar-val { font-size: 13px; font-weight: 600; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .vbar-lab { font-size: 12px; color: var(--ink-2); }

  .hbars { display: flex; flex-direction: column; gap: 6px; }
  .hbar { display: grid; grid-template-columns: 190px 1fr 44px; align-items: center; gap: 10px; position: relative; outline: none; }
  .hbar-lab { font-size: 13px; color: var(--ink-2); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbar-track { background: var(--track); border-radius: 4px; height: 16px; }
  .hbar-fill { background: var(--series); border-radius: 4px; height: 100%; min-width: 2px; }
  .hbar-val { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }

  /* Hover layer — an HTML chart is interactive by default. */
  .tip {
    position: absolute; left: 50%; bottom: 100%; transform: translate(-50%, -6px);
    background: var(--ink); color: var(--surface); font-size: 12px; white-space: nowrap;
    padding: 4px 8px; border-radius: 6px; opacity: 0; pointer-events: none; transition: opacity .12s; z-index: 5;
  }
  .vbar:hover .tip, .vbar:focus .tip, .hbar:hover .tip, .hbar:focus .tip { opacity: 1; }
  .hbar .tip { left: 190px; transform: translate(0, -6px); }

  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; font-weight: 600; color: var(--ink-2); font-size: 12px;
       text-transform: uppercase; letter-spacing: .04em; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td.num { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
  .sub { color: var(--ink-3); font-size: 12.5px; margin-top: 1px; }
  .dim { color: var(--ink-3); }
  .bracket-note { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 12px; color: var(--ink-3); margin-top: 3px; }
  tr.bracket td {
    background: var(--track); color: var(--ink-2); font-size: 11.5px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .05em; padding: 6px 10px; border-bottom: 1px solid var(--line);
  }
  a { color: var(--series); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Status never rides on color alone — every badge carries its own word. */
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600;
           border: 1px solid currentColor; white-space: nowrap; }
  .badge.good { color: var(--good); }
  .badge.critical { color: var(--critical); }
  .badge.neutral { color: var(--ink-3); }
  footer { margin-top: 40px; color: var(--ink-3); font-size: 12.5px; max-width: 76ch; }

  /* Narrow viewports: the label gutter is what pushes the page wider than the
     screen, so it collapses first. The body must never scroll horizontally. */
  @media (max-width: 640px) {
    .hbar { grid-template-columns: 104px 1fr 34px; gap: 8px; }
    .hbar .tip { left: 0; }
    .vbar-lab { font-size: 11px; }
    h1 { font-size: 22px; }
  }
</style>

<div class="wrap">
  <header>
    <h1>Job Search Command Center</h1>
    <div class="meta">
      ${esc(d.profile?.name || '')}${d.profile?.degree ? ` · ${esc(d.profile.degree)}` : ''}${d.profile?.location ? ` · ${esc(d.profile.location)}` : ''}
      <div class="dim">Built ${esc(new Date(d.generatedAt).toISOString().replace('T', ' ').slice(0, 16))} UTC</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="n">${listings.length.toLocaleString()}</div><div class="k">Local openings tracked</div><div class="s">Workday + hiring.cafe</div></div>
      <div class="kpi"><div class="n">${fresh7.toLocaleString()}</div><div class="k">Posted in last 7 days</div><div class="s">of ${dated.length.toLocaleString()} with a date</div></div>
      <div class="kpi"><div class="n">${nearHome.length.toLocaleString()}</div><div class="k">Owings Mills area</div><div class="s">≤15 min, reachable, ≤21d</div></div>
      <div class="kpi"><div class="n">${shortlist.length.toLocaleString()}</div><div class="k">Reachable &amp; fresh</div><div class="s">≤21d, no clearance, not senior</div></div>
      <div class="kpi"><div class="n">${reports.length}</div><div class="k">Roles evaluated</div><div class="s">full reports written</div></div>
      <div class="kpi"><div class="n">${(d.pipeline || []).length}</div><div class="k">Pipeline pending</div><div class="s">awaiting triage</div></div>
    </div>
  </header>

  <h2>Where the openings sit by age</h2>
  <p class="note">Postings age out fast in an entry-level market: an old listing usually means filled or unattended. Everything below is ordered by age for that reason, and the shortlist stops at 21 days.
  The final bar is open-ended — Workday reports anything past a month only as &ldquo;30+ days&rdquo;, so ${censoredCount.toLocaleString()} of these have no exact age and that bar is a floor, not a count at 30.</p>
  <div class="panel">${vBars(ageHistogram)}</div>

  <h2>Who is actually hiring for reachable roles</h2>
  <p class="note">Employers with the most openings that survive the reachability filter — no clearance requirement, not senior, not clinical, not deep-specialist engineering.</p>
  <div class="panel">${hBars(byEmployer)}</div>

  <h2>Evaluated roles</h2>
  <p class="note">Every role with a written report, best fit first.</p>
  <div class="panel scroll">
    <table>
      <thead><tr><th>Score</th><th>Company / Role</th><th>Archetype</th><th>Advertised</th><th>Decision</th><th>Risk</th></tr></thead>
      <tbody>${reportRows}</tbody>
    </table>
  </div>

  <h2>Owings Mills area — closest to home</h2>
  <p class="note">Owings Mills, Reisterstown, Pikesville, Randallstown, Windsor Mill, Woodlawn and Garrison — roughly fifteen minutes. All ${nearHome.length} reachable roles, ranked by what he would most likely actually be hired for — not by date and not by pay. Bands are title-and-employer inference, not a read of each posting; only the M&T rows have had their job description checked (reports 015-017).</p>
  <div class="panel scroll">
    <table>
      <thead><tr><th>Age</th><th>Pay</th><th>Employer</th><th>Role</th><th>Location</th></tr></thead>
      <tbody>${nearHomeRows || '<tr><td colspan="5">Nothing in this ring right now — the rings below are the next closest.</td></tr>'}</tbody>
    </table>
  </div>

  <h2>Greater Baltimore — by age</h2>
  <p class="note">Baltimore city, Towson, Catonsville, Columbia, Hunt Valley, Glen Burnie and the rest of the metro — a commutable drive. ${baltimore.length} reachable roles. Past the home ring the commute stops distinguishing anything, so these are worked by recency.</p>
  <div class="panel scroll">
    <table>
      <thead><tr><th>Age</th><th>Pay</th><th>Employer</th><th>Role</th><th>Location</th></tr></thead>
      <tbody>${baltimoreRows}</tbody>
    </table>
  </div>

  <h2>Rest of Maryland, DC, Virginia and remote — by age</h2>
  <p class="note">${elsewhere.length} reachable roles beyond the Baltimore metro. Furthest from home and the largest group, so recency does the filtering: the older brackets here are the least likely to be worth the drive or still open.</p>
  <div class="panel scroll">
    <table>
      <thead><tr><th>Age</th><th>Pay</th><th>Employer</th><th>Role</th><th>Location</th></tr></thead>
      <tbody>${elsewhereRows}</tbody>
    </table>
  </div>

  <p class="note">${shortlist.length} reachable roles in total — ${tierTally.map((t) => `${t.n} ${t.label.toLowerCase()}`).join(', ')}. Found title-blind: filtered on location, age and reachability, never on a list of target titles.</p>

  <footer>
    Built from the local scan results, the tracker and the evaluation reports at ${esc(new Date(d.generatedAt).toISOString().slice(0, 10))}.
    Posting ages are as recorded when each source was fetched, so they drift between scans — re-run
    <code>build-dash-data.mjs</code> then <code>build-dash-html.mjs</code> to refresh.
    A posting appearing here is not proof it is still open; confirm before investing in an application.
  </footer>
</div>
`;

writeFileSync(DEST, html);
console.log(`wrote ${DEST}`);
console.log(`  listings=${listings.length} dated=${dated.length} fresh7=${fresh7} shortlist=${shortlist.length} reports=${reports.length}`);
