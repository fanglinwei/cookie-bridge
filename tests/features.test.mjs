import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

test('business state changes only after success, previews preserve snapshots and permissions keep the click gesture', async t => {
  const previousChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = previousChrome; });
  const target = { tabId: 7, url: 'http://localhost/app/', storeId: '0' };
  const cookie = { name: 'session', value: 'saved', domain: 'localhost', path: '/', secure: false, httpOnly: true, hostOnly: true, sameSite: 'lax', session: true };
  const favorite = { id: 'favorite-1', name: 'Account', source: { origin: 'http://localhost', path: '/app/' }, cookies: [cookie], createdAt: 1, updatedAt: 1 };
  let storedFavorites = [structuredClone(favorite)];
  let nextFavoriteId = 2;
  let failedAction = '';
  let permitted = true;
  let grantResult = true;
  let removeResult = false;
  let permissionRequests = 0;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: async message => {
        if (message.action === failedAction) return { ok: false, error: 'Request rejected' };
        if (message.action === 'saveFavorite') {
          const saved = { ...favorite, id: message.id || `favorite-${nextFavoriteId++}`, name: message.name.trim(), updatedAt: 2 };
          const index = storedFavorites.findIndex(item => item.id === saved.id);
          if (index < 0) storedFavorites.push(saved); else storedFavorites[index] = saved;
          return { ok: true, data: { favorite: structuredClone(saved) } };
        }
        if (message.action === 'deleteFavorite') storedFavorites = storedFavorites.filter(item => item.id !== message.id);
        const responses = {
          state: { favorites: storedFavorites },
          deleteFavorite: {},
          sourcePreview: { cookies: [{ ...cookie, value: 'current' }] },
          settings: {},
          target: { target },
          read: { cookies: [cookie] },
        };
        assert.ok(Object.hasOwn(responses, message.action));
        return { ok: true, data: structuredClone(responses[message.action]) };
      },
    },
    permissions: {
      contains: async () => permitted,
      request: () => { permissionRequests++; permitted = grantResult; return Promise.resolve(grantResult); },
      remove: async () => removeResult,
      getAll: async () => ({ origins: [] }),
    },
  };
  const { useFavorites } = await import('../.test-build/src/composables/useFavorites.js');
  const { useSettings } = await import('../.test-build/src/composables/useSettings.js');
  const { useTargetSite } = await import('../.test-build/src/composables/useTargetSite.js');
  const favorites = ref([structuredClone(favorite)]);
  const library = useFavorites(favorites);
  const settings = ref({ autoRefresh: true });
  const permissions = ref(['http://localhost/*']);
  const preferences = useSettings(settings, permissions);

  failedAction = 'saveFavorite';
  await assert.rejects(library.save({ ...favorite, name: 'Changed' }), /Request rejected/);
  assert.deepEqual(favorites.value, [favorite]);
  failedAction = 'deleteFavorite';
  await assert.rejects(library.remove(favorite.id), /Request rejected/);
  assert.deepEqual(favorites.value, [favorite]);
  failedAction = 'settings';
  await assert.rejects(preferences.save(false), /Request rejected/);
  assert.equal(settings.value.autoRefresh, true);
  await assert.rejects(preferences.revoke(permissions.value[0]), /权限移除未完成/);
  assert.deepEqual(permissions.value, ['http://localhost/*']);

  failedAction = '';
  const preview = await library.preview(favorites.value[0], target);
  assert.equal(preview.cookies[0].value, 'current');
  assert.match(preview.summary, /其中 1 项发生变化/);
  assert.deepEqual(favorites.value, [favorite]);
  await library.save({ ...favorite, name: ' Changed ' });
  assert.equal(favorites.value.length, 1);
  assert.equal(favorites.value[0].name, 'Changed');
  assert.equal(favorites.value[0].updatedAt, 2);
  await library.save({ name: 'Second', source: favorite.source, cookies: favorite.cookies });
  assert.deepEqual(favorites.value.map(item => item.id), ['favorite-1', 'favorite-2']);
  await library.remove(favorite.id);
  assert.deepEqual(favorites.value.map(item => item.id), ['favorite-2']);
  // Another window deletes a cached favorite and creates one this window has never seen.
  storedFavorites = [{ ...favorite, id: 'remote-1', name: 'Other window' }];
  await library.save({ name: 'Third', source: favorite.source, cookies: favorite.cookies });
  assert.deepEqual(favorites.value, storedFavorites, 'save must replace stale local favorites with the full backend snapshot');
  assert.deepEqual(favorites.value.map(item => item.id), ['remote-1', 'favorite-3']);
  storedFavorites = [storedFavorites[1], { ...favorite, id: 'remote-2', name: 'Another window' }];
  await library.remove('favorite-3');
  assert.deepEqual(favorites.value, storedFavorites, 'delete must also reflect unrelated remote additions and deletions');
  assert.deepEqual(favorites.value.map(item => item.id), ['remote-2']);
  await preferences.save(false);
  assert.equal(settings.value.autoRefresh, false);
  removeResult = true;
  await preferences.revoke(permissions.value[0]);
  assert.deepEqual(permissions.value, []);

  const site = useTargetSite(true, '7');
  await site.bindTarget();
  assert.deepEqual(site.target.value, target);
  assert.equal(site.selectionResetKey.value, 1);
  assert.deepEqual(site.cookies.value, [cookie]);
  assert.equal(site.origin.value, 'http://localhost');
  assert.equal(site.targetPath.value, '/app/');
  failedAction = 'target';
  await assert.rejects(site.bindTarget(), /Request rejected/);
  assert.equal(site.selectionResetKey.value, 1);
  failedAction = '';
  await site.bindTarget();
  assert.equal(site.selectionResetKey.value, 2);
  permitted = false;
  await site.read();
  assert.equal(site.authorized.value, false);
  assert.deepEqual(site.cookies.value, []);
  const grant = site.grantAccess();
  assert.equal(permissionRequests, 1, 'permission request must run before grantAccess returns its Promise');
  await grant;
  assert.equal(site.authorized.value, true);
  assert.deepEqual(site.cookies.value, [cookie]);
  grantResult = false;
  await assert.rejects(site.grantAccess(), /未获得网站授权/);
  assert.equal(permissionRequests, 2);
  assert.deepEqual(site.cookies.value, [cookie], 'denied grant preserves the existing Cookie view');
});
