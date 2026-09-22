import { UserError, webURL, sourceInfo, hostPattern, identity, validateCookies, prepareCookies, inScope, conflicts, applyBatch } from '../core.mjs';

const local = chrome.storage.local;
const session = chrome.storage.session;
const ready = (async () => {
  await local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { lastOperation } = await session.get('lastOperation');
  if (lastOperation?.status === 'running') {
    await session.set({ lastOperation: { ...lastOperation, status: 'interrupted', message: '后台曾中断，请刷新列表核对结果；未自动重试。' } });
  }
})();

async function targetFor(tabId) {
  let tab;
  try { tab = tabId === undefined ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0] : await chrome.tabs.get(tabId); }
  catch { throw new UserError('目标标签页已关闭，请从目标网站重新打开插件。'); }
  if (!tab || tab.incognito) throw new UserError('请选择普通窗口中的网站。');
  const url = webURL(tab.url);
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find(item => item.tabIds.includes(tab.id));
  if (!store) throw new UserError('无法确定目标 Cookie 存储区。');
  return { tabId: tab.id, url: url.href, storeId: store.id };
}

async function checkTarget(target) {
  if (!target || !Number.isInteger(target.tabId) || typeof target.storeId !== 'string') throw new UserError('缺少有效目标，请从目标网站重新打开插件。');
  const current = await targetFor(target.tabId);
  if (current.url !== target.url || current.storeId !== target.storeId) throw new UserError('目标页面已经跳转，请重新绑定目标后再操作。');
  if (!await chrome.permissions.contains({ origins: [hostPattern(target.url)] })) throw new UserError('请先授权当前网站的 Cookie 访问权限。');
  return current;
}

async function listCookies(target) {
  await checkTarget(target);
  const cookies = await chrome.cookies.getAll({ storeId: target.storeId });
  return cookies.filter(cookie => !cookie.partitionKey && inScope(cookie, target.url));
}

function withoutValues(cookies) {
  return cookies.map(({ name, domain, path, storeId }) => ({ name, domain, path, storeId }));
}

async function verifyCookie(target, details) {
  const url = webURL(target.url);
  const cookies = await listCookies(target);
  const stored = cookies.find(cookie => identity(cookie) === identity({ ...details, domain: details.domain || url.hostname }));
  return Boolean(stored && stored.value === details.value && stored.secure === details.secure && stored.httpOnly === details.httpOnly && stored.sameSite === details.sameSite &&
    (details.expirationDate === undefined ? stored.session : !stored.session && Math.abs(stored.expirationDate - details.expirationDate) < 2));
}

async function removeExact(target, cookie) {
  const current = (await listCookies(target)).find(item => identity(item) === identity(cookie));
  if (!current) throw new UserError('该 Cookie 已不存在，请刷新列表。');
  if (current.value !== cookie.value) throw new UserError('Cookie 已被网站更新，请刷新列表后重新选择。');
  // Expiring the full identity avoids cookies.remove selecting a different path/domain.
  const details = { url: target.url, name: current.name, value: '', path: current.path, secure: current.secure, httpOnly: current.httpOnly, sameSite: current.sameSite, expirationDate: 1, storeId: target.storeId };
  if (!current.hostOnly) details.domain = current.domain;
  await chrome.cookies.set(details);
  if ((await listCookies(target)).some(item => identity(item) === identity(current))) throw new UserError('删除未生效，请检查网站是否重新设置了 Cookie。');
}

async function saveOperation(operation) {
  await session.set({ lastOperation: operation });
}

async function applyCookies(message) {
  const { target } = message;
  await checkTarget(target);
  const mapped = prepareCookies(message.cookies, target, { preservePath: true, preserveDomain: Boolean(message.original || message.edit) });
  const existing = await listCookies(target);
  const collision = conflicts(mapped, existing, target.url).filter(item => !message.original || identity(item) !== identity(message.original));
  if (collision.length) {
    if (!['keep', 'remove'].includes(message.conflictMode)) return { conflicts: withoutValues(collision) };
    const expected = new Set((message.conflictIds || []).map(identity));
    if (collision.some(item => !expected.has(identity(item)))) return { conflicts: withoutValues(collision), changed: true };
  }
  if (message.original) {
    validateCookies([message.original]);
    const actual = existing.find(item => identity(item) === identity(message.original));
    if (!actual || actual.value !== message.original.value) throw new UserError('原 Cookie 已变化，请刷新列表后重新编辑。');
  }
  const operation = { id: crypto.randomUUID(), type: 'apply', source: sourceInfo({ origin: target.url }), status: 'running', startedAt: Date.now(), rows: mapped.map(({ name, path }) => ({ name, path, status: 'pending' })) };
  await saveOperation(operation);
  try {
    if (message.conflictMode === 'remove') {
      for (const cookie of collision) await removeExact(target, cookie);
      operation.message = `已按确认清除 ${collision.length} 条冲突 Cookie。`;
    }
    operation.rows = await applyBatch(mapped, {
      checkTarget: () => checkTarget(target),
      write: cookie => chrome.cookies.set(cookie),
      verify: cookie => verifyCookie(target, cookie),
      progress: async rows => { operation.rows = rows; await saveOperation(operation); },
    });
    const succeeded = operation.rows.every(row => row.status === 'success');
    if (succeeded && message.original) {
      const nextKey = identity({ ...mapped[0], domain: mapped[0].domain || webURL(target.url).hostname });
      if (nextKey !== identity(message.original)) await removeExact(target, message.original);
    }
    operation.status = succeeded ? 'success' : 'partial';
    if (succeeded && message.refresh) {
      await checkTarget(target);
      await chrome.tabs.reload(target.tabId);
      operation.refreshed = true;
    }
  } catch (error) {
    operation.status = operation.rows.some(row => row.status === 'success') ? 'partial' : 'failed';
    operation.message = error instanceof UserError ? error.message : '操作未完成，请检查权限和 Cookie 属性；没有自动回滚。';
  }
  operation.finishedAt = Date.now();
  await saveOperation(operation);
  return { operation };
}

async function deleteCookies(message) {
  const cookies = validateCookies(message.cookies);
  await checkTarget(message.target);
  const operation = { id: crypto.randomUUID(), type: 'delete', source: sourceInfo({ origin: message.target.url }), status: 'running', startedAt: Date.now(), rows: cookies.map(({ name, path }) => ({ name, path, status: 'pending' })) };
  await saveOperation(operation);
  for (let i = 0; i < cookies.length; i++) {
    try { await removeExact(message.target, cookies[i]); operation.rows[i].status = 'success'; }
    catch (error) {
      operation.rows[i].status = 'failed';
      operation.rows[i].message = error instanceof UserError ? error.message : '删除失败，请检查权限和 Cookie 属性。';
      break;
    }
    await saveOperation(operation);
  }
  operation.status = operation.rows.every(row => row.status === 'success') ? 'success' : 'partial';
  await saveOperation(operation);
  return { operation };
}

async function handle(message) {
  await ready;
  switch (message.action) {
    case 'state': {
      const { favorites = [], settings = { autoRefresh: true } } = await local.get(['favorites', 'settings']);
      const { clipboard = null, lastOperation = null } = await session.get(['clipboard', 'lastOperation']);
      return { favorites, settings, clipboard, lastOperation, permissions: (await chrome.permissions.getAll()).origins || [] };
    }
    case 'target': return { target: await targetFor(message.tabId) };
    case 'read': return { cookies: await listCookies(message.target) };
    case 'apply': return applyCookies(message);
    case 'delete': return deleteCookies(message);
    case 'copy': {
      await checkTarget(message.target);
      const clipboard = { cookies: validateCookies(message.cookies), source: sourceInfo({ origin: message.target.url }), copiedAt: Date.now() };
      await session.set({ clipboard });
      return { clipboard };
    }
    case 'clearClipboard': await session.remove('clipboard'); return {};
    case 'saveFavorite': {
      const { favorites = [] } = await local.get('favorites');
      if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 80) throw new UserError('收藏名称应为 1～80 个字符。');
      const cookies = validateCookies(message.cookies);
      const index = favorites.findIndex(item => item.id === message.id);
      if (message.id && index < 0) throw new UserError('收藏已不存在，请刷新列表。');
      if (index < 0 && favorites.length >= 200) throw new UserError('最多保存 200 份收藏，请先删除不再需要的配置。');
      const now = Date.now();
      const favorite = { id: message.id || crypto.randomUUID(), name: message.name.trim(), source: sourceInfo(message.source), cookies, createdAt: index >= 0 ? favorites[index].createdAt : now, updatedAt: now };
      if (index < 0) favorites.push(favorite); else favorites[index] = favorite;
      await local.set({ favorites });
      return { favorite };
    }
    case 'deleteFavorite': {
      const { favorites = [] } = await local.get('favorites');
      await local.set({ favorites: favorites.filter(item => item.id !== message.id) });
      return {};
    }
    case 'sourcePreview': {
      const { favorites = [] } = await local.get('favorites');
      const favorite = favorites.find(item => item.id === message.id);
      if (!favorite?.source.origin || favorite.source.origin !== webURL(message.target.url).origin) throw new UserError('请在收藏的来源网站打开插件后再更新。');
      const current = await listCookies(message.target);
      const cookies = favorite.cookies.map(saved => current.find(item => item.name === saved.name && item.domain === saved.domain && item.path === saved.path));
      if (cookies.some(item => !item)) throw new UserError('来源网站缺少部分收藏项，请重新登录或重新选取 Cookie。');
      return { cookies };
    }
    case 'settings':
      if (typeof message.autoRefresh !== 'boolean') throw new UserError('设置格式错误。');
      await local.set({ settings: { autoRefresh: message.autoRefresh } }); return {};
    default: throw new UserError('未知操作，请重新打开插件。');
  }
}

// ponytail: one queue for this small local tool; split by cookie store/host if throughput becomes a concern.
let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only extension pages can invoke privileged operations, never website content scripts.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  const task = queue.then(() => handle(message));
  queue = task.catch(() => {});
  task.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error instanceof UserError ? error.message : '操作失败，请检查浏览器权限或本机存储空间后重试。' }));
  return true;
});
