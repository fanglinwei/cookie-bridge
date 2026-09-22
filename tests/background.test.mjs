import test from 'node:test';
import assert from 'node:assert/strict';

async function background({ cookies = [], permitted = true, rejectName = '', sessionData = {} } = {}) {
  const data = { local: {}, session: structuredClone(sessionData) };
  const target = { tabId: 7, url: 'http://localhost:5173/app/', storeId: '0' };
  let listener;
  let reloads = 0;
  let currentURL = target.url;
  const storage = area => ({
    setAccessLevel: async () => {},
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[area][key])])),
    set: async value => Object.assign(data[area], structuredClone(value)),
    remove: async key => { delete data[area][key]; },
  });
  const key = cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.storeId]);
  globalThis.chrome = {
    storage: { local: storage('local'), session: storage('session') },
    permissions: { contains: async () => permitted, getAll: async () => ({ origins: [] }) },
    tabs: { get: async () => ({ id: 7, url: currentURL, incognito: false }), query: async () => [{ id: 7, url: currentURL }], reload: async () => { reloads++; } },
    cookies: {
      getAllCookieStores: async () => [{ id: '0', tabIds: [7] }],
      getAll: async () => structuredClone(cookies),
      set: async details => {
        if (details.name === rejectName) throw Error('secret browser diagnostic');
        const cookie = { ...details, domain: details.domain || new URL(details.url).hostname, storeId: details.storeId || '0', hostOnly: !details.domain, session: details.expirationDate === undefined };
        delete cookie.url;
        cookies = cookies.filter(item => key(item) !== key(cookie));
        if (details.expirationDate === undefined || details.expirationDate > Date.now() / 1000) cookies.push(cookie);
        return cookie;
      },
    },
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: { addListener: callback => { listener = callback; } } },
  };
  await import(`../src/background.js?test=${crypto.randomUUID()}`);
  const send = (action, values = {}) => new Promise(resolve => listener({ action, ...values }, { id: 'test-extension', url: 'chrome-extension://test-extension/index.html' }, resolve));
  return { send, data, target, cookies: () => cookies, reloads: () => reloads, navigate: url => { currentURL = url; }, listener: () => listener };
}

const fixture = name => ({ name, value: 'fixture-only', path: '/', secure: false, httpOnly: false, sameSite: 'lax', session: true });

test('backend applies a batch, preserves unrelated cookies and refreshes only on complete success', async () => {
  const env = await background({ cookies: [{ ...fixture('unrelated'), domain: 'localhost', storeId: '0', hostOnly: true }] });
  const result = await env.send('apply', { target: env.target, cookies: [fixture('a'), fixture('b')], refresh: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.operation.status, 'success');
  assert.equal(env.cookies().length, 3);
  assert.equal(env.reloads(), 1);
  assert.equal(JSON.stringify(env.data.session.lastOperation).includes('fixture-only'), false);
});

test('backend reports partial failures without exposing browser diagnostics or refreshing', async () => {
  const env = await background({ rejectName: 'b' });
  const result = await env.send('apply', { target: env.target, cookies: [fixture('a'), fixture('b'), fixture('c')], refresh: true });
  assert.equal(result.data.operation.status, 'partial');
  assert.deepEqual(result.data.operation.rows.map(row => row.status), ['success', 'failed', 'pending']);
  assert.equal(env.reloads(), 0);
  assert.equal(JSON.stringify(result).includes('secret browser diagnostic'), false);
});

test('permissions and stale navigation prevent all writes', async () => {
  const denied = await background({ permitted: false });
  assert.equal((await denied.send('apply', { target: denied.target, cookies: [fixture('a')] })).ok, false);
  assert.equal(denied.cookies().length, 0);
  const navigated = await background();
  navigated.navigate('http://localhost:5173/changed/');
  assert.equal((await navigated.send('apply', { target: navigated.target, cookies: [fixture('a')] })).ok, false);
  assert.equal(navigated.cookies().length, 0);
});

test('favorites remain snapshots and worker restart marks unfinished operations interrupted', async () => {
  const env = await background({ sessionData: { lastOperation: { status: 'running', rows: [] } } });
  await env.send('saveFavorite', { name: '测试收藏', source: { origin: 'https://example.com/?secret=x#hidden' }, cookies: [fixture('demo')] });
  await env.send('copy', { target: env.target, cookies: [{ ...fixture('demo'), value: 'another-fixture' }] });
  const state = (await env.send('state')).data;
  assert.equal(state.favorites[0].cookies[0].value, 'fixture-only');
  assert.equal(state.favorites[0].source.origin, 'https://example.com');
  assert.equal(state.lastOperation.status, 'interrupted');
});

test('messages from website contexts are refused', async () => {
  const env = await background();
  const accepted = env.listener()({ action: 'state' }, { id: 'test-extension', url: 'https://example.com/' }, () => assert.fail());
  assert.equal(accepted, false);
});
