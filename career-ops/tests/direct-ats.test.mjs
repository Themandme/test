import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DIRECT_SOURCES,
  isDirectTitleExcluded,
  mergeDirectSource,
  normalizeDirectJob,
} from '../scan-direct-ats.mjs';

const source = DEFAULT_DIRECT_SOURCES.find(item => item.provider === 'greenhouse');

test('direct ATS normalization keeps core locations and rejects regional-only locations', () => {
  const now = Date.parse('2026-09-04T12:00:00Z');
  const job = { title: 'Customer Support Specialist', url: 'https://example.test/1', location: 'Owings Mills, MD', postedAt: now - 3600000 };
  assert.equal(normalizeDirectJob(job, source, now).days, 0);
  assert.equal(normalizeDirectJob({ ...job, location: 'Towson, MD' }, source, now), null);
});

test('direct ATS excludes senior and clinical roles without misreading senior-service context', () => {
  assert.equal(isDirectTitleExcluded('Senior Data Analyst'), true);
  assert.equal(isDirectTitleExcluded('Clinical Support Specialist'), true);
  assert.equal(isDirectTitleExcluded('Pharmacist'), true);
  assert.equal(isDirectTitleExcluded('Senior Living Customer Service Associate'), false);
  assert.equal(isDirectTitleExcluded('Executive Assistant'), false);
});

test('failed sources retain cached rows for a bounded number of runs', () => {
  const board = `${source.provider}:${source.careers_url}`;
  const prior = [{ url: 'https://example.test/1', sourceBoard: board, sourceFailureRuns: 0 }];
  const first = mergeDirectSource(prior, source, [], 'timeout', 2);
  assert.equal(first.length, 1);
  assert.equal(first[0].sourceFailureRuns, 1);
  assert.equal(first[0].retainedAfterSourceFailure, true);
  assert.equal(mergeDirectSource(first, source, [], 'timeout', 1).length, 0);
});
