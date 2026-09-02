import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHiringCafeAccessBlock, milesBetween, normalizeHit } from '../scan-hiringcafe-full.mjs';

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
    listed_compensation_frequency: 'Hourly', hourly_min_compensation: 22,
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
  assert.deepEqual(result.job.salary, { min: 22, max: 26, unit: 'HOUR' });
  assert.equal(result.job.url, 'https://example.test/apply/123');
});

test('HiringCafe normalization excludes senior metadata and off-radius results', () => {
  const senior = hit({ v5_processed_job_data: { ...hit().v5_processed_job_data, seniority_level: 'Senior Level' } });
  assert.equal(normalizeHit(senior).reason, 'senior');
  assert.equal(normalizeHit(hit({ _geoloc: [{ lat: 39.7, lon: -76.78 }] })).reason, 'offArea');
});

test('frontline shift leadership stays eligible', () => {
  const lead = hit({ job_information: { title: 'Retail Shift Lead' }, v5_processed_job_data: { ...hit().v5_processed_job_data, seniority_level: 'Mid Level', min_industry_and_role_yoe: 2 } });
  assert.equal(normalizeHit(lead).reason, null);
});

test('Cloudflare verification is classified as a source access block', () => {
  assert.equal(isHiringCafeAccessBlock(403, '<title>Just a moment...</title> Cloudflare'), true);
  assert.equal(isHiringCafeAccessBlock(403, 'ordinary forbidden response'), false);
  assert.equal(isHiringCafeAccessBlock(500, 'Cloudflare'), false);
});
