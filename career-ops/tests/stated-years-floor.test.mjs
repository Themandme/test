// Regression tests for scan-remote-us.mjs's eligibility gate.
//
// The original filter was `EXP_FLOOR_RE.test(desc.slice(0, 2500))`. It never
// fired: company boilerplate occupies the top of most postings, so the
// qualifications section sits past a 2500-character window — 3446 chars into
// the Eversheds posting, 3978 into UnitedHealth, 5214 into Boise State. Roles
// demanding five years scored 17-24 and read as reachable.
//
// Cases below are transcribed from real postings swept on 2026-08-11. Each one
// encodes a rule that a naive scan gets backwards, so keep them concrete.

import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';

// scan-remote-us.mjs runs its sweep on import, so the function is lifted out of
// the source text rather than imported. That also means these tests assert
// against the shipped code, not a copy that could drift from it.
const src = readFileSync(join(ROOT, 'scan-remote-us.mjs'), 'utf8');
const grab = (re) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not lift ${re} out of scan-remote-us.mjs`);
  return m[0];
};
const parts = [
  ...['WORD_NUM', 'YEARS_RE', 'EQUIVALENCY_RE', 'PREFERRED_RE', 'PREF_HEADING_RE', 'REQ_HEADING_RE']
    .map((n) => grab(new RegExp(`^const ${n} = .*?;$`, 'ms'))),
  grab(/^const spellOut = .*?;$/ms),
  grab(/export function statedYearsFloor\(desc\) \{.*?\n\}/s).replace('export ', ''),
];
const { statedYearsFloor } = await import(
  `data:text/javascript,${encodeURIComponent(parts.join('\n') + '\nexport { statedYearsFloor };')}`
);

const cases = [
  {
    name: 'no years stated anywhere → null (Public Consulting Group)',
    text: 'Qualifications • Bachelor’s Degree or equivalent experience required; Masters a plus. '
      + '• Undergraduate or graduate work experience in consulting, Medicaid, technology, or public sector services a plus.',
    expect: null,
  },
  {
    name: 'a range gates at its floor, spelled out (KSA Integration)',
    text: 'Position Requirements: • Bachelor’s Degree. • One to four years of related experience. '
      + '• Proficiency in Python, R, or SQL.',
    expect: 1,
  },
  {
    name: 'a numeric range gates at its floor (Nordic)',
    text: 'Requirements • Bachelor’s degree in Business Administration. '
      + '• 2-4 years of experience in business operations, project coordination, process improvement.',
    expect: 2,
  },
  {
    name: 'separate required bullets gate at the MAXIMUM, not the minimum (UnitedHealth)',
    text: 'Required Qualifications: • 5+ years of experience of Analytics & Data in SQL, Databricks. '
      + '• 5+ years of experience Data of Management & Governance. '
      + '• 1+ years of experience AI & Automation with familiarity with Generative AI technologies.',
    expect: 5,
  },
  {
    name: 'a hard multi-year bar past a 2500-char boilerplate prefix is still found (Eversheds)',
    text: 'A'.repeat(3400) + ' Qualifications • Bachelor’s degree in a quantitative field. '
      + '• 5+ years of experience in data analysis and report development.',
    expect: 5,
  },
  {
    name: 'an equivalency clause means the years are not a wall (Boise State)',
    text: 'Minimum Qualifications • Bachelor’s Degree and 2 years of experience, '
      + 'or equivalent progressively responsible professional experience.',
    expect: null,
  },
  {
    name: 'years under a Preferred heading are not a gate (Boise State)',
    text: 'Minimum Qualifications • Bachelor’s Degree. Preferred Qualifications '
      + '• Platform Proficiency : 2+ years of experience configuring low-code platforms. '
      + '• Workflow Design : 2+ years facilitating discovery sessions.',
    expect: null,
  },
  {
    name: 'years inside a preference phrase on one line are not a gate',
    text: 'Requirements • Bachelor’s degree. • 3 years of Salesforce administration preferred.',
    expect: null,
  },
  {
    name: '● bullets split like • bullets — otherwise a whole list collapses into one line',
    text: 'Requirements ● Bachelor’s degree. ● 4 years of experience in operations.',
    expect: 4,
  },
  {
    name: 'a hard bar and a soft one on the same posting resolve to the hard one',
    text: 'Required • 2+ years hands-on experience as a Salesforce Administrator. '
      + '• Salesforce Certification is a plus.',
    expect: 2,
  },
  {
    name: 'implausible figures are ignored rather than treated as a bar',
    text: 'Requirements • Founded 40 years ago, we serve clients nationwide. • Bachelor’s degree.',
    expect: null,
  },
  { name: 'empty description → null', text: '', expect: null },
];

for (const { name, text, expect } of cases) {
  const got = statedYearsFloor(text);
  if (got === expect) pass(name);
  else fail(`${name} — expected ${expect}, got ${got}`);
}
