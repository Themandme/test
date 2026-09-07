import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualizedMinimum, hasEligibleLocalPay, isHiringCafeAccessBlock, milesBetween, normalizeHit } from '../scan-hiringcafe-full.mjs';

const hit = (overrides = {}) => ({
  objectID: 'source___board___123',
  apply_url: 'https://example.test/apply/123',
  is_expired: false,
  job_information: { title: 'Customer Support Specialist' },
  _geoloc: [{ lat: 39.4195, lon: -76.7803 }],
  v5_processed_job_data: {
    company_name: 'Example Co', workplace_cities: ['Owings Mills, Maryland, US'],
    estimated_publish_date: '2026-09-01T12:00:00Z', commitment: ['Full Time'],
    seniority_level: 'Entry Level', min_industry_and_role_yoe: 1,
    is_compensation_transparent: true,
    listed_compensation_frequency: 'Hourly', hourly_min_compensation: 25,
    hourly_max_compensation: 26, requirements_summary: 'Customer service experience.',
  },
  ...overrides,
});

test('distance calculation is geodesic and exact at center', () => {
  assert.equal(milesBetween({ lat: 39, lon: -76 }, { lat: 39, lon: -76 }), 0);
  assert.ok(milesBetween({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) > 69);
});

test('HiringCafe hit normalization preserves local pay and direct application URL', () => {
  const result = normalizeHit(hit(), Date.parse('2026-09-01T16:00:00Z'));
  assert.equal(result.reason, null);
  assert.equal(result.job.city, 'Owings Mills');
  assert.deepEqual(result.job.salary, { min: 25, max: 26, unit: 'HOUR' });
  assert.equal(result.job.url, 'https://example.test/apply/123');
});

test('HiringCafe normalization excludes senior metadata and off-radius results', () => {
  const senior = hit({ v5_processed_job_data: { ...hit().v5_processed_job_data, seniority_level: 'Senior Level' } });
  assert.equal(normalizeHit(senior).reason, 'senior');
  assert.equal(normalizeHit(hit({ _geoloc: [{ lat: 39.7, lon: -76.78 }] })).reason, null);
  assert.equal(normalizeHit(hit({ _geoloc: [{ lat: 39.95, lon: -76.78 }] })).reason, 'offArea');
});

test('frontline shift leadership stays eligible', () => {
  const lead = hit({ job_information: { title: 'Retail Shift Lead' }, v5_processed_job_data: { ...hit().v5_processed_job_data, seniority_level: 'Mid Level', min_industry_and_role_yoe: 2 } });
  assert.equal(normalizeHit(lead).reason, null);
});

test('hardcoded local compensation policy uses guaranteed minimum', () => {
  assert.equal(hasEligibleLocalPay({ min: 25, max: 30, unit: 'HOUR' }), true);
  assert.equal(hasEligibleLocalPay({ min: 24.99, max: 40, unit: 'HOUR' }), false);
  assert.equal(hasEligibleLocalPay({ min: 50000, max: 60000, unit: 'YEAR' }), true);
  assert.equal(hasEligibleLocalPay({ min: 49999, max: 90000, unit: 'YEAR' }), false);
  assert.equal(hasEligibleLocalPay({ min: 4166.67, unit: 'MONTH' }), true);
  assert.equal(hasEligibleLocalPay(null), false);
  assert.equal(annualizedMinimum({ min: 1000, unit: 'WEEK' }), 52000);
});

test('normalization excludes undisclosed and below-floor compensation', () => {
  const low = hit({ v5_processed_job_data: { ...hit().v5_processed_job_data, hourly_min_compensation: 24.99, hourly_max_compensation: 40 } });
  const hidden = hit({ v5_processed_job_data: { ...hit().v5_processed_job_data, is_compensation_transparent: false } });
  assert.equal(normalizeHit(low).reason, 'payIneligible');
  assert.equal(normalizeHit(hidden).reason, 'payIneligible');
});

test('Cloudflare verification is classified as a source access block', () => {
  assert.equal(isHiringCafeAccessBlock(403, '<title>Just a moment...</title> Cloudflare'), true);
  assert.equal(isHiringCafeAccessBlock(403, 'ordinary forbidden response'), false);
  assert.equal(isHiringCafeAccessBlock(500, 'Cloudflare'), false);
});
