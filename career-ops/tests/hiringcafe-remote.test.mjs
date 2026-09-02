import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNationwideUsRemote, normalizeRemoteHit } from '../scan-hiringcafe-remote.mjs';

const now = Date.parse('2026-09-03T14:00:00Z');
const baseV5 = {
  company_name: 'Example Co', workplace_type: 'Remote', workplace_countries: ['US'],
  workplace_states: [], boundless_workplace_states: [], boundless_workplace_countries: ['US'],
  seniority_level: 'Entry Level', min_industry_and_role_yoe: 1,
  min_management_and_leadership_yoe: 0, is_compensation_transparent: true,
  yearly_min_compensation: 60_000, yearly_max_compensation: 72_000,
  estimated_publish_date_millis: now - 60 * 60 * 1000, commitment: ['Full Time'],
};
const hit = (v5 = {}) => ({ objectID: 'source___1', apply_url: 'https://example.test/apply',
  is_expired: false, job_information: { title: 'Customer Support Analyst' },
  v5_processed_job_data: { ...baseV5, ...v5 } });

test('nationwide remote accepts boundless US and rejects state-limited remote', () => {
  assert.equal(isNationwideUsRemote(baseV5), true);
  assert.equal(isNationwideUsRemote({ ...baseV5, workplace_states: ['Texas, US'], boundless_workplace_countries: [] }), false);
});

test('remote normalization requires a salary floor above $55k and age under 24 hours', () => {
  assert.equal(normalizeRemoteHit(hit(), now).reason, null);
  assert.equal(normalizeRemoteHit(hit({ yearly_min_compensation: 55_000 }), now).reason, 'payBelowFloor');
  assert.equal(normalizeRemoteHit(hit({ estimated_publish_date_millis: now - 24 * 60 * 60 * 1000 }), now).reason, 'notUnder24Hours');
});

test('remote normalization rejects senior and clinical roles', () => {
  assert.equal(normalizeRemoteHit({ ...hit(), job_information: { title: 'Senior Support Analyst' } }, now).reason, 'senior');
  assert.equal(normalizeRemoteHit({ ...hit(), job_information: { title: 'Clinical Support Analyst' } }, now).reason, 'medical');
});
