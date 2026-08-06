import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcimsSearchPage } from '../providers/icims.mjs';

const ORIGIN = 'https://careers-acme.icims.com';

const card = (labelText, value) => `
<li class="iCIMS_JobCardItem">
  <div class="row">
    <div class="col-xs-6 header left">
      <span class="sr-only field-label">${labelText}</span>
      <span > ${value}</span>
    </div>
    <div class="col-xs-12 title">
      <a href="${ORIGIN}/jobs/101/business-analyst/job?in_iframe=1" class="iCIMS_Anchor">
        <h3 > Business Analyst</h3>
      </a>
    </div>
  </div>
</li>`;

test('reads the observed default label "Job Locations" (plural, prefixed)', () => {
  // The parser anchored on the bare word "Location", which matched nothing on
  // tenants using this label. Every posting then carried an empty location, and
  // because the location filter passes rows with missing data, a full-directory
  // sweep admitted postings from anywhere into a location-scoped search.
  const [job] = parseIcimsSearchPage(card('Job Locations', 'US-MD-Silver Spring'), ORIGIN, 'acme');
  assert.equal(job.location, 'US-MD-Silver Spring');
});

test('still reads the bare "Location" label', () => {
  const [job] = parseIcimsSearchPage(card('Location', 'US-MI-Livonia'), ORIGIN, 'acme');
  assert.equal(job.location, 'US-MI-Livonia');
});

test('label matching is case-insensitive', () => {
  const [job] = parseIcimsSearchPage(card('JOB LOCATIONS', 'US-VA-Hampton'), ORIGIN, 'acme');
  assert.equal(job.location, 'US-VA-Hampton');
});

test('a themed field-label class list still matches', () => {
  const html = `
<li class="iCIMS_JobCardItem">
  <span class="sr-only field-label custom-theme">Job Locations</span>
  <span > US-OH-Fairborn</span>
  <a href="${ORIGIN}/jobs/1/x/job"><h3 >Data Analyst</h3></a>
</li>`;
  const [job] = parseIcimsSearchPage(html, ORIGIN, 'acme');
  assert.equal(job.location, 'US-OH-Fairborn');
});

test('a hyphenated lookalike class does not count as field-label', () => {
  const html = `
<li class="iCIMS_JobCardItem">
  <span class="field-label-inline">Job Locations</span>
  <span > US-CA-Nowhere</span>
  <a href="${ORIGIN}/jobs/1/x/job"><h3 >Data Analyst</h3></a>
</li>`;
  const [job] = parseIcimsSearchPage(html, ORIGIN, 'acme');
  assert.equal(job.location, '', 'must not widen the class match');
});

test('a card that genuinely omits the location yields an empty string, not a throw', () => {
  // Observed in the wild: some tenants emit an empty <div> where the location
  // would go. That is real missing data and stays empty by design.
  const html = `
<li class="iCIMS_JobCardItem">
  <div class="col-xs-6 header left"> </div>
  <a href="${ORIGIN}/jobs/2/y/job"><h3 >Staff RN II</h3></a>
</li>`;
  const [job] = parseIcimsSearchPage(html, ORIGIN, 'acme');
  assert.equal(job.location, '');
});

test('the Posted Date label is never mistaken for a location', () => {
  const html = `
<li class="iCIMS_JobCardItem">
  <span class="sr-only field-label">Posted Date</span>
  <span title="8/5/2026"> 8 hours ago</span>
  <a href="${ORIGIN}/jobs/3/z/job"><h3 >Data Analyst</h3></a>
</li>`;
  const [job] = parseIcimsSearchPage(html, ORIGIN, 'acme');
  assert.equal(job.location, '');
});
