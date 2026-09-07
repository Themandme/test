import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePage, validateResults, openingKey } from '../scan-hiringcafe-via-donsetch.mjs';

const result = ids => ({ pairs: ids.map(id => [id, { reason: null }]) });
test('complete pagination passes', () => validateResults([result(['a', 'b']), result(['c'])], 3, 2, true));
test('missing page fails', () => assert.throws(() => validateResults([result(['a', 'b'])], 3, 2, true)));
test('empty page fails', () => assert.throws(() => validateResults([result(['a', 'b']), result([])], 3, 2, true)));
test('overlapping hits fail', () => assert.throws(() => validateResults([result(['a', 'b']), result(['a'])], 3, 2, true)));
test('missing identity fails', () => assert.throws(() => validateResults([result(['a', null]), result(['c'])], 3, 2, true)));
test('zero-result response passes', () => validateResults([result([])], 0, 2, true));
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
  assert.match(code, /CKPT_VERSION = 2/);
});
