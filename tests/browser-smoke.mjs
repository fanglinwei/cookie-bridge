// Run with PLAYWRIGHT_MODULE pointing at an existing Playwright installation; no test dependencies are installed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temporary = await mkdtemp(join(tmpdir(), 'cookie-bridge-test-'));
const output = resolve('test-results');
await mkdir(output, { recursive: true });
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="en"><title>Cookie Bridge fixture</title><body><h1>Synthetic cookie test page</h1></body></html>');
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;
let browser;
let panel;
const results = [];
const errors = [];
const passed = name => { results.push(name); console.log(`PASS ${name}`); };

try {
  const extension = join(temporary, 'extension');
  await cp(resolve('dist'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // Pre-authorize only the two disposable test hosts; production permissions remain optional.
  manifest.host_permissions = ['http://localhost/*', 'http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const defaultContext = await chromium.launchPersistentContext(join(temporary, 'profile'), { executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, viewport: { width: 1100, height: 850 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
  browser = defaultContext.browser();
  const cdp = await browser.newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  const source = await defaultContext.newPage();
  await source.goto(`http://127.0.0.1:${port}/source/`);
  const destination = await defaultContext.newPage();
  await destination.goto(`http://localhost:${port}/app/`);
  panel = await defaultContext.newPage();
  panel.on('pageerror', error => errors.push(error.message));
  panel.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await panel.goto(`chrome-extension://${id}/index.html?view=manage`);
  const send = (action, data = {}) => panel.evaluate(async ({ action, data }) => {
    const result = await chrome.runtime.sendMessage({ action, ...data });
    if (!result.ok) throw Error(result.error);
    return result.data;
  }, { action, data });
  const tabIds = await panel.evaluate(async () => (await chrome.tabs.query({})).filter(tab => tab.url?.startsWith('http://')).map(tab => ({ id: tab.id, url: tab.url })));
  const sourceId = tabIds.find(tab => tab.url.includes('127.0.0.1')).id;
  const destinationId = tabIds.find(tab => tab.url.includes('localhost')).id;
  const sourceInfo = (await send('target', { tabId: sourceId })).target;
  const targetInfo = (await send('target', { tabId: destinationId })).target;
  const fixtureCookies = [
    { name: 'demo_session', value: 'fixture-admin==', path: '/', sameSite: 'lax', httpOnly: true },
    { name: 'demo_access', value: 'fixture-access', path: '/', sameSite: 'lax' },
  ];
  await panel.evaluate(async ({ sourceInfo, targetInfo, fixtureCookies }) => {
    for (const cookie of fixtureCookies) await chrome.cookies.set({ ...cookie, url: sourceInfo.url });
    await chrome.cookies.set({ url: targetInfo.url, name: 'unrelated', value: 'keep', path: '/' });
  }, { sourceInfo, targetInfo, fixtureCookies });
  await panel.goto(`chrome-extension://${id}/index.html?view=manage&target=${sourceId}`);
  await panel.getByText('demo_session', { exact: true }).waitFor();
  assert.equal(await panel.locator('.cookie-row').count(), 2);
  await panel.getByLabel('全选可见项').check();
  await panel.getByRole('button', { name: '复制选中项', exact: true }).click();
  await panel.getByText('已复制 2 项', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '收藏选中项' }).click();
  await panel.getByLabel('收藏名称').fill('测试管理员');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('收藏已保存。', { exact: true }).waitFor();
  passed('source selection, HttpOnly read, temporary copy and named favorite');

  await panel.goto(`chrome-extension://${id}/index.html?view=manage&target=${destinationId}`);
  await panel.getByRole('button', { name: '应用已复制项', exact: true }).click();
  await panel.getByText('Cookie 已应用，目标页面已刷新。', { exact: true }).waitFor();
  const destinationCookies = (await send('read', { target: targetInfo })).cookies;
  assert.equal(destinationCookies.find(cookie => cookie.name === 'demo_session').value, 'fixture-admin==');
  assert.equal(destinationCookies.find(cookie => cookie.name === 'demo_session').httpOnly, true);
  assert.equal(destinationCookies.find(cookie => cookie.name === 'unrelated').value, 'keep');
  passed('cross-host application, readback, refresh and unrelated-cookie preservation');

  await panel.getByRole('button', { name: '导入', exact: true }).click();
  await panel.getByLabel('Cookie 文本或 JSON').fill('a=one; a=two');
  await panel.getByRole('button', { name: '解析并预览' }).click();
  await panel.getByRole('alert').filter({ hasText: '重复' }).waitFor();
  await panel.getByLabel('Cookie 文本或 JSON').fill('imported=fixture==; empty=');
  await panel.getByRole('button', { name: '解析并预览' }).click();
  await panel.getByRole('heading', { name: '已解析 2 项' }).waitFor();
  await panel.getByRole('button', { name: '应用到当前站', exact: true }).click();
  await panel.getByText('Cookie 已应用，目标页面已刷新。', { exact: true }).waitFor();
  assert.equal((await send('read', { target: targetInfo })).cookies.find(cookie => cookie.name === 'imported').value, 'fixture==');
  passed('import validation, text parser and actual Chrome writes');

  await panel.evaluate(async target => chrome.cookies.set({ url: target.url, name: 'demo_session', value: 'old-fixture', path: '/app', sameSite: 'lax' }), targetInfo);
  await panel.getByRole('button', { name: '应用已复制项', exact: true }).click();
  await panel.getByRole('heading', { name: '发现同名 Cookie 冲突' }).waitFor();
  await panel.getByLabel('删除上列冲突项后写入').check();
  await panel.getByRole('button', { name: '确认应用', exact: true }).click();
  await panel.getByText('Cookie 已应用，目标页面已刷新。', { exact: true }).waitFor();
  assert.equal((await send('read', { target: targetInfo })).cookies.filter(cookie => cookie.name === 'demo_session').length, 1);
  passed('path conflict confirmation and exact deletion');

  await panel.getByRole('button', { name: '＋ 新增', exact: true }).click();
  await panel.getByLabel('名称', { exact: true }).fill('created');
  await panel.getByLabel('值', { exact: true }).fill('new-fixture');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('Cookie 已保存。', { exact: true }).waitFor();
  const createdRow = panel.locator('.cookie-row').filter({ has: panel.getByText('created', { exact: true }) });
  await createdRow.getByRole('button', { name: '编辑', exact: true }).click();
  await panel.getByLabel('名称', { exact: true }).fill('renamed');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('renamed', { exact: true }).first().waitFor();
  assert.equal((await send('read', { target: targetInfo })).cookies.some(cookie => cookie.name === 'created'), false);
  passed('create and identity-changing edit');

  await panel.setViewportSize({ width: 1100, height: 850 });
  await panel.screenshot({ path: join(output, 'manager-desktop.png'), fullPage: true });
  await panel.setViewportSize({ width: 375, height: 812 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: join(output, 'manager-mobile.png'), fullPage: true });
  await panel.keyboard.press('Tab');
  assert.equal(await panel.evaluate(() => document.activeElement !== document.body), true);
  passed('desktop/mobile layout without horizontal overflow and keyboard focus');

  await panel.evaluate(async info => chrome.cookies.set({ url: info.url, name: 'demo_session', value: 'fixture-user', path: '/', httpOnly: true, sameSite: 'lax' }), sourceInfo);
  await panel.goto(`chrome-extension://${id}/index.html?view=manage&target=${sourceId}`);
  await panel.getByLabel('全选可见项').check();
  await panel.getByRole('button', { name: '收藏选中项' }).click();
  await panel.getByLabel('收藏名称').fill('测试普通用户');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('收藏已保存。', { exact: true }).waitFor();
  await panel.evaluate(async info => chrome.cookies.set({ url: info.url, name: 'demo_session', value: 'fixture-user-updated', path: '/', httpOnly: true, sameSite: 'lax' }), sourceInfo);
  await panel.getByRole('button', { name: /^收藏 \d/ }).click();
  const userFavorite = panel.locator('.favorite-card').filter({ has: panel.getByRole('heading', { name: '测试普通用户' }) });
  await userFavorite.getByRole('button', { name: '从来源更新' }).click();
  await panel.getByRole('heading', { name: '从来源更新收藏' }).waitFor();
  assert.equal((await send('state')).favorites.find(item => item.name === '测试普通用户').cookies.find(cookie => cookie.name === 'demo_session').value, 'fixture-user');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('收藏已保存。', { exact: true }).waitFor();
  await panel.goto(`chrome-extension://${id}/index.html?view=manage&target=${destinationId}`);
  await panel.getByRole('button', { name: /^收藏 \d/ }).click();
  for (const [name, value] of [['测试普通用户', 'fixture-user-updated'], ['测试管理员', 'fixture-admin==']]) {
    const card = panel.locator('.favorite-card').filter({ has: panel.getByRole('heading', { name }) });
    await card.getByRole('button', { name: '应用到当前站', exact: true }).click();
    await panel.getByText('Cookie 已应用，目标页面已刷新。', { exact: true }).waitFor();
    assert.equal((await send('read', { target: targetInfo })).cookies.find(cookie => cookie.name === 'demo_session').value, value);
  }
  passed('two-account switching and explicitly confirmed source refresh');

  await panel.getByRole('button', { name: '设置', exact: true }).click();
  await panel.getByLabel('应用成功后刷新目标页', { exact: false }).uncheck();
  await panel.waitForFunction(async () => !(await chrome.runtime.sendMessage({ action: 'state' })).data.settings.autoRefresh);
  await panel.getByRole('button', { name: '应用已复制项', exact: true }).click();
  await panel.getByText('Cookie 已应用。', { exact: true }).waitFor();
  assert.equal((await send('state')).lastOperation.refreshed, undefined);
  passed('auto-refresh preference is persisted and respected');

  await panel.goto(`chrome-extension://${id}/index.html?target=${destinationId}`);
  await panel.setViewportSize({ width: 320, height: 600 });
  assert.equal((await panel.locator('body').boundingBox()).width, 440);
  await panel.setViewportSize({ width: 440, height: 540 });
  await panel.getByText('demo_session', { exact: true }).first().waitFor();
  const popupBounds = await panel.locator('body').boundingBox();
  assert.equal(popupBounds.width, 440);
  assert.equal(popupBounds.height, 540);
  assert.equal((await panel.locator('.target-card').boundingBox()).height < 70, true);
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
  const toolbarBefore = await panel.locator('.batch-actions').boundingBox();
  assert.equal(toolbarBefore.y + toolbarBefore.height <= 540, true);
  await panel.locator('.cookie-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
  assert.equal(await panel.locator('.cookie-list').evaluate(list => list.scrollTop > 0), true);
  assert.equal((await panel.locator('.batch-actions').boundingBox()).y, toolbarBefore.y);
  await panel.locator('.target-details summary').focus();
  await panel.keyboard.press('Enter');
  assert.equal(await panel.locator('.target-details').getAttribute('open'), '');
  await panel.keyboard.press('Enter');
  await panel.locator('.cookie-list').evaluate(list => { list.scrollTop = 0; });
  passed('440×540 popup, compact target, independent list scroll and pinned batch actions');
  await panel.getByRole('heading', { name: 'Cookie Bridge', exact: true }).click();
  await panel.screenshot({ path: join(output, 'popup.png'), fullPage: true });
  const addButton = panel.getByRole('button', { name: '＋ 新增', exact: true });
  await addButton.focus();
  await panel.keyboard.press('Enter');
  await panel.getByRole('heading', { name: '新增 Cookie', exact: true }).waitFor();
  assert.equal(await panel.evaluate(() => Boolean(document.activeElement.closest('dialog'))), true);
  await panel.keyboard.press('Escape');
  assert.equal(await panel.locator('dialog').isVisible(), false);
  assert.equal(await panel.evaluate(() => document.activeElement.textContent.trim()), '＋ 新增');
  passed('popup layout and keyboard dialog open, escape and focus restoration');

  await panel.getByRole('button', { name: '导入', exact: true }).click();
  await panel.getByLabel('JSON 文件（最大 1 MB）').setInputFiles(resolve('examples/cookies.json'));
  await panel.getByRole('heading', { name: '已解析 1 项' }).waitFor();
  await panel.getByRole('button', { name: '保存为收藏', exact: true }).click();
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('收藏已保存。', { exact: true }).waitFor();
  assert.equal((await send('state')).favorites.some(item => item.name === '演示账号（虚构值）'), true);
  await panel.getByRole('button', { name: '清理网站 Cookie', exact: true }).click();
  await panel.getByRole('heading', { name: '清理当前网站 Cookie' }).waitFor();
  assert.equal((await send('read', { target: targetInfo })).cookies.length > 0, true);
  await panel.getByRole('button', { name: '确认操作', exact: true }).click();
  await panel.getByRole('heading', { name: '没有匹配的 Cookie' }).waitFor();
  assert.equal((await send('read', { target: targetInfo })).cookies.length, 0);
  assert.equal((await send('state')).favorites.length, 3);
  passed('JSON file import and confirmed site cleanup preserving favorites');

  await destination.goto(`http://localhost:${port}/changed/`);
  await assert.rejects(() => send('apply', { target: targetInfo, cookies: fixtureCookies, refresh: false }), /目标页面已经跳转/);
  passed('stale target navigation blocks writes');
  const state = await send('state');
  assert.equal(state.favorites[0].source.origin, `http://127.0.0.1:${port}`);
  assert.equal(state.favorites[0].cookies.find(cookie => cookie.name === 'demo_session').value, 'fixture-admin==');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'browser-results.json'), JSON.stringify({ passed: results, pageErrors: errors, scope: 'Isolated Chrome; synthetic data; fixture hosts pre-authorized. No real account was accessed.' }, null, 2));
  console.log(`Completed ${results.length} browser checks.`);
} catch (error) {
  if (panel && !panel.isClosed()) {
    await panel.screenshot({ path: join(output, 'failure.png'), fullPage: true });
    console.error('UI state:', (await panel.locator('body').innerText()).slice(0, 2400));
    console.error('Page errors:', errors);
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
