import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePage, validatePages, openingKey } from '../scan-hiringcafe-via-donsetch.mjs';

const page = (ids, total = 3) => ({ ssrTotalCount: total, ssrPageSize: 2, ssrHits: ids.map(id => ({ objectID: id })) });
test('complete pagination passes', () => validatePages([page(['a', 'b']), page(['c'])], 3, 2));
test('missing page fails', () => assert.throws(() => validatePages([page(['a', 'b'])], 3, 2)));
test('empty page fails', () => assert.throws(() => validatePages([page(['a', 'b']), page([])], 3, 2)));
test('overlapping hits fail', () => assert.throws(() => validatePages([page(['a', 'b']), page(['a'])], 3, 2)));
test('changing totals fail', () => assert.throws(() => validatePages([page(['a', 'b']), page(['c'], 4)], 3, 2)));
test('missing identity fails', () => assert.throws(() => validatePages([page(['a', null]), page(['c'])], 3, 2)));
test('zero-result response passes', () => validatePages([page([], 0)], 0, 2));
test('distinct requisitions remain distinct', () => {
  const job = { company: 'Example', title: 'Support', city: 'Towson', sourceId: 'a' };
  assert.notEqual(openingKey(job), openingKey({ ...job, sourceId: 'b' }));
});
test('raw JSON preserves posting text', () => {
  const pageProps = { text: 'Use ```code``` and *[truncated example]* literally', ssrHits: [] };
  assert.deepEqual(parsePage(JSON.stringify({ pageProps })), pageProps);
});
test('transport wrapper is removed', () => {
  assert.deepEqual(parsePage('https://hiringcafe.com/test\n\n```\n{"pageProps":{"ssrHits":[]}}\n```'), { ssrHits: [] });
});
test('raw controls can be recovered', () => {
  assert.equal(parsePage('{"pageProps":{"text":"a' + String.fromCharCode(1) + 'b"}}').text, 'a b');
});
test('smoke-test return precedes any store write', () => {
  const code = readFileSync(new URL('../scan-hiringcafe-via-donsetch.mjs', import.meta.url), 'utf8');
  assert.match(code, /if \(pagesCapArg !== null\) \{[\s\S]*?published: false[\s\S]*?return;/);
  assert.ok(code.indexOf('published: false') < code.indexOf('writeFileSync(STORE_PATH'));
  assert.match(code, /return main\(true\)/);
});
