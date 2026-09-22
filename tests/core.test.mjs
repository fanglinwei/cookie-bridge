import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImport, validateCookies, prepareCookies, identity, inScope, conflicts, applyBatch } from '../core.mjs';

const target = { url: 'http://localhost:5173/app/', storeId: '0' };
const sample = (name = 'demo') => ({ name, value: 'fixture-only', domain: 'source.example', path: '/', secure: false, httpOnly: false, sameSite: 'lax', session: true });

test('Cookie text preserves equals, empty values and encoded values', () => {
  assert.deepEqual(parseImport('a=example==; b=; c=%2F').cookies.map(({ name, value }) => [name, value]), [['a', 'example=='], ['b', ''], ['c', '%2F']]);
});

test('import rejects malformed, duplicate, oversized and unsafe input', () => {
  for (const text of ['a', 'a=1; a=2', 'a=x\nb=y', '{broken', 'x'.repeat(1024 * 1024 + 1)]) assert.throws(() => parseImport(text));
  assert.throws(() => parseImport(JSON.stringify({ version: 2, cookies: [sample()] })));
  assert.throws(() => validateCookies([{ name: 'a', value: 2 }]));
  assert.throws(() => validateCookies([{ ...sample(), secure: 'false' }]));
  assert.throws(() => validateCookies([{ ...sample(), session: false, expirationDate: 1e99 }]));
  assert.throws(() => validateCookies([{ ...sample(), partitionKey: { topLevelSite: 'https://example.com' } }]));
});

test('versioned JSON preserves metadata but strips URL query and hash', () => {
  const parsed = parseImport(JSON.stringify({ version: 1, name: '开发账号', source: { origin: 'https://example.com/a?secret=x#fragment', path: '/a?secret=x' }, cookies: [sample()] }));
  assert.equal(parsed.source.origin, 'https://example.com');
  assert.equal(parsed.source.path, '/a');
  assert.equal(parsed.cookies[0].value, 'fixture-only');
});

test('cross-site mapping drops source domain, preserves flags and uses root path', () => {
  const [cookie] = prepareCookies([{ ...sample(), path: '/source', httpOnly: true }], target);
  assert.equal(cookie.domain, undefined);
  assert.equal(cookie.path, '/');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.storeId, '0');
  assert.equal(cookie.url, target.url);
});

test('mapping rejects collapsed identities, expired cookies and incompatible security', () => {
  assert.throws(() => prepareCookies([sample(), { ...sample(), path: '/other' }], target));
  assert.throws(() => prepareCookies([{ ...sample(), expirationDate: 1, session: false }], target));
  assert.throws(() => prepareCookies([{ ...sample(), secure: true }], { ...target, url: 'http://dev.example/' }));
  assert.throws(() => prepareCookies([{ ...sample(), sameSite: 'no_restriction' }], target));
  assert.throws(() => prepareCookies([sample('__Host-demo')], target));
});

test('host scope respects domain boundaries and distinguishes paths', () => {
  assert.equal(inScope({ ...sample(), domain: '.example.com', hostOnly: false }, 'https://sub.example.com/'), true);
  assert.equal(inScope({ ...sample(), domain: '.example.com', hostOnly: false }, 'https://evil-example.com/'), false);
  assert.equal(inScope({ ...sample(), domain: 'example.com', hostOnly: true }, 'https://sub.example.com/'), false);
  assert.notEqual(identity(sample()), identity({ ...sample(), path: '/other' }));
  const existing = [{ ...sample(), domain: 'localhost', path: '/app' }];
  assert.equal(conflicts(prepareCookies([sample()], target), existing, target.url).length, 1);
});

test('batch stops on failure and never reloads on partial success', async () => {
  const written = [];
  const result = await applyBatch(prepareCookies([sample('a'), sample('b'), sample('c')], target), {
    checkTarget: async () => {},
    write: async c => { if (c.name === 'b') throw Error('sensitive internal text'); written.push(c); },
    verify: async () => true,
    progress: async () => {},
  });
  assert.deepEqual(written.map(c => c.name), ['a']);
  assert.deepEqual(result.map(r => r.status), ['success', 'failed', 'pending']);
  assert.equal(JSON.stringify(result).includes('sensitive internal text'), false);
});

test('navigation and failed readback halt further writes', async () => {
  let count = 0;
  const result = await applyBatch(prepareCookies([sample('a'), sample('b')], target), {
    checkTarget: async () => {}, write: async () => count++, verify: async () => false, progress: async () => {},
  });
  assert.equal(count, 1);
  assert.equal(result[0].status, 'failed');
  await assert.rejects(() => applyBatch(prepareCookies([sample()], target), {
    checkTarget: async () => { throw Error('目标已变化'); }, write: async () => assert.fail(), verify: async () => true, progress: async () => {},
  }));
});
