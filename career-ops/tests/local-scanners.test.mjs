import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entries, rotatingWindow, staleByLastmod } from '../sitemap-sweep.mjs';
import { eligibilityFromHtml, internalRestriction } from '../scan-maryland-gov.mjs';
import {
  milesBetween,
  normalize,
  parseMdY,
  parseSalary,
  unifiedDedupKey,
  unifiedScore,
} from '../scan-neogov.mjs';

test('sitemap entries keep each location paired with its own lastmod', () => {
  const xml = `<sitemapindex>
    <sitemap><loc>https://example.test/a.xml</loc><lastmod>2026-08-27</lastmod></sitemap>
    <sitemap><loc>https://example.test/b.xml</loc></sitemap>
    <sitemap><loc>https://example.test/c.xml</loc><lastmod>2026-08-29</lastmod></sitemap>
  </sitemapindex>`;

  assert.deepEqual(entries(xml), [
    { loc: 'https://example.test/a.xml', lastmod: '2026-08-27' },
    { loc: 'https://example.test/b.xml', lastmod: null },
    { loc: 'https://example.test/c.xml', lastmod: '2026-08-29' },
  ]);
});

test('a rotating sweep covers all 483 current-style chunks', () => {
  const chunks = Array.from({ length: 483 }, (_, i) => `chunk-${i}`);
  const seen = new Set();
  let cursor = 0;
  const cycleRuns = rotatingWindow(chunks, cursor, 60).cycleRuns;

  assert.equal(cycleRuns, 9);
  for (let run = 0; run < cycleRuns; run += 1) {
    const sweep = rotatingWindow(chunks, cursor, 60);
    sweep.window.forEach((chunk) => seen.add(chunk));
    cursor = sweep.nextCursor;
  }
  assert.equal(seen.size, 483);
});

test('stale sitemap dates skip only postings outside the slack window', () => {
  const cutoff = Date.parse('2026-08-20T00:00:00Z');
  assert.equal(staleByLastmod('2026-08-01', cutoff, 7), true);
  assert.equal(staleByLastmod('2026-08-15', cutoff, 7), false);
  assert.equal(staleByLastmod(null, cutoff, 7), false);
  assert.equal(staleByLastmod('not-a-date', cutoff, 7), false);
});

const publicJobApsPage = (reqId = '26-001234-0001') => `
  <main>
    <h1>Recruitment #${reqId}</h1>
    <p>Filing Deadline: September 10, 2026</p>
    <p>Work Location: Baltimore County</p>
    <h2>Main Purpose of Job</h2>
    <p>This is an open recruitment available to qualified applicants.</p>
  </main>`;

test('Maryland eligibility catches the JobAps recruitment typo used on internal pages', () => {
  const html = `${publicJobApsPage()}
    <p>THIS RECURITMENT IS FOR CURRENT MARYLAND DEPARTMENT OF LABOR EMPLOYEES</p>`;

  assert.match(internalRestriction(html), /current employees only/i);
  assert.equal(eligibilityFromHtml(html, { reqId: '26-001234-0001' }).status, 'internal');
});

test('Maryland eligibility catches department-specific current-employee requirements', () => {
  const html = `${publicJobApsPage()}<p>You must be a current SDAT employee.</p>`;

  assert.match(internalRestriction(html), /current employees only/i);
  assert.equal(eligibilityFromHtml(html, { reqId: '26-001234-0001' }).status, 'internal');
});

test('Maryland eligibility ignores general employee application boilerplate', () => {
  const html = `${publicJobApsPage()}
    <p>Permanent State employees do not need to submit proof of Veterans status.</p>`;

  assert.equal(internalRestriction(html), null);
  assert.equal(eligibilityFromHtml(html, { reqId: '26-001234-0001' }).status, 'public');
});

test('Maryland eligibility accepts a structurally valid public recruitment', () => {
  const result = eligibilityFromHtml(publicJobApsPage(), { reqId: '26-001234-0001' });

  assert.equal(result.status, 'public');
  assert.equal(result.restriction, null);
});

test('Maryland eligibility does not treat an invalid or mismatched page as public', () => {
  assert.equal(eligibilityFromHtml('<html><body>Access denied</body></html>', {
    reqId: '26-001234-0001',
  }).status, 'unverified');
  assert.equal(eligibilityFromHtml(publicJobApsPage('26-009999-0009'), {
    reqId: '26-001234-0001',
  }).status, 'unverified');
});

test('NEOGOV salary parsing preserves the stated pay unit', () => {
  assert.deepEqual(parseSalary('$58,037.00 - $66,390.00 Annually'), {
    min: 58037,
    max: 66390,
    unit: 'YEAR',
  });
  assert.deepEqual(parseSalary('$26.39 - $36.37 Hourly'), {
    min: 26.39,
    max: 36.37,
    unit: 'HOUR',
  });
  assert.deepEqual(parseSalary('$4,000 - $5,000 Monthly'), {
    min: 4000,
    max: 5000,
    unit: 'MONTH',
  });
  assert.equal(parseSalary('Salary unavailable'), null);
});

test('NEOGOV distance uses great-circle miles', () => {
  assert.equal(milesBetween({ lat: 39, lon: -76 }, { lat: 39, lon: -76 }), 0);
  const oneDegreeAtEquator = milesBetween({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
  assert.ok(oneDegreeAtEquator > 69 && oneDegreeAtEquator < 69.2);
});

test('NEOGOV closing dates remain open through the end of the Eastern day', () => {
  assert.equal(
    new Date(parseMdY('08/29/26', true)).toISOString(),
    '2026-08-30T03:59:59.999Z',
  );
  assert.equal(
    new Date(parseMdY('12/31/26', true)).toISOString(),
    '2027-01-01T04:59:59.999Z',
  );
  assert.equal(parseMdY('Continuous', true), null);
  assert.equal(parseMdY('02/31/26', true), null);
});

test('NEOGOV normalization distinguishes verified from missing coordinates', () => {
  const agency = { slug: 'baltimorecounty', name: 'Baltimore County Government' };
  const base = {
    ID: 123,
    JobTitle: 'analyst',
    Classification: 'Analyst I',
    JobNumber: 'REQ-123',
    PostingDate: '08/28/26',
    ClosingDate: '08/29/26',
    SalaryInfo: '$25.00 Hourly',
    IsSalaryVisible: true,
    JobCity: ['Towson'],
    JobAbbrvState: ['MD'],
  };

  const verified = normalize({ ...base, Lattitude: 39.4015, Longitude: -76.6019 }, agency);
  assert.equal(verified.coordinatesVerified, true);
  assert.equal(typeof verified.miles, 'number');
  assert.equal(new Date(verified.deadlineMs).toISOString(), '2026-08-30T03:59:59.999Z');

  const missing = normalize({ ...base, ID: 124, Lattitude: null, Longitude: null }, agency);
  assert.equal(missing.coordinatesVerified, false);
  assert.equal(missing.miles, null);
});

test('unified deduplication keeps separate requisitions and locations distinct', () => {
  const base = {
    company: 'Example Agency',
    title: 'Program Assistant',
    location: 'Towson, MD',
    source: 'County/city NEOGOV',
  };

  assert.notEqual(
    unifiedDedupKey({ ...base, reqId: 'REQ-100' }),
    unifiedDedupKey({ ...base, reqId: 'REQ-101' }),
  );
  assert.notEqual(
    unifiedDedupKey(base),
    unifiedDedupKey({ ...base, location: 'Owings Mills, MD' }),
  );
});

test('unified scoring demotes senior and stale continuous postings', () => {
  const base = {
    title: 'Customer Support Specialist',
    salary: { min: 25, max: 28, unit: 'HOUR' },
    days: 2,
    continuous: false,
  };
  const junior = unifiedScore(base);
  const senior = unifiedScore({ ...base, title: 'Senior Customer Support Specialist' });
  const stale = unifiedScore({ ...base, days: 500, continuous: true });

  assert.ok(junior.overall > senior.overall);
  assert.ok(junior.overall > stale.overall);
  assert.ok(stale.flags.includes('older continuous/standing recruitment'));
});
