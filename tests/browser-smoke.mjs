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

async function checkImportReplacement(view) {
  const dialog = panel.locator('dialog');
  for (const failure of ['malformed', 'oversized', 'unreadable']) {
    await panel.getByLabel('Cookie 文本或 JSON').fill('old_preview=fixture-only');
    await panel.getByRole('button', { name: '解析并预览' }).click();
    await dialog.getByRole('heading', { name: '已解析 1 项' }).waitFor();
    if (failure === 'unreadable') await panel.evaluate(() => {
      window.originalFileText = File.prototype.text;
      File.prototype.text = () => new Promise((_, reject) => { window.rejectFileRead = () => reject(new Error('测试文件读取失败')); });
    });
    try {
      await panel.getByLabel('JSON 文件（最大 1 MB）').setInputFiles({
        name: `${failure}.json`, mimeType: 'application/json',
        buffer: failure === 'oversized' ? Buffer.alloc(1024 * 1024 + 1) : Buffer.from('{broken'),
      });
      if (failure === 'unreadable') {
        await panel.waitForFunction(() => Boolean(window.rejectFileRead));
        assert.equal(await dialog.locator('.import-preview').count(), 0, `${view}: replacement must clear the old preview before reading completes`);
        await panel.evaluate(() => window.rejectFileRead());
      }
      const message = failure === 'malformed' ? 'JSON 格式错误' : failure === 'oversized' ? '不得超过 1 MB' : '测试文件读取失败';
      await dialog.locator(view === 'manager' ? '.toast-error' : '.notice.error').filter({ hasText: message }).waitFor();
      assert.equal(await dialog.locator('.import-preview').count(), 0, `${view}: ${failure} must discard the previous preview`);
      assert.equal(await dialog.getByRole('button', { name: '应用到当前站', exact: true }).count(), 0);
      assert.equal(await dialog.getByRole('button', { name: '保存为收藏', exact: true }).count(), 0);
    } finally {
      if (failure === 'unreadable') await panel.evaluate(() => {
        window.rejectFileRead?.();
        File.prototype.text = window.originalFileText;
        delete window.originalFileText; delete window.rejectFileRead;
      });
    }
  }
  await panel.getByLabel('Cookie 文本或 JSON').fill('recovered_preview=fixture-only');
  await panel.getByRole('button', { name: '解析并预览' }).click();
  await dialog.getByRole('heading', { name: '已解析 1 项' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '保存为收藏', exact: true }).isEnabled(), true);
  passed(`${view} import replacement clears stale previews after invalid, oversized and unreadable files and allows retry`);
}

try {
  const extension = join(temporary, 'extension');
  await cp(resolve('dist'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // Pre-authorize only the two disposable test hosts; production permissions remain optional.
  manifest.host_permissions = ['http://localhost/*', 'https://localhost/*', 'http://127.0.0.1/*'];
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
    { name: 'demo_access', value: 'fixture-access-'.repeat(30), path: '/', sameSite: 'lax' },
  ];
  await panel.evaluate(async ({ sourceInfo, targetInfo, fixtureCookies }) => {
    for (const cookie of fixtureCookies) await chrome.cookies.set({ ...cookie, url: sourceInfo.url });
    await chrome.cookies.set({ url: targetInfo.url, name: 'unrelated', value: 'keep', path: '/' });
  }, { sourceInfo, targetInfo, fixtureCookies });
  await panel.goto(`chrome-extension://${id}/index.html?view=manage&target=${sourceId}`);
  await panel.getByText('demo_session', { exact: true }).waitFor();
  assert.equal(await panel.locator('.cookie-row').count(), 2);
  const valueButton = panel.getByRole('button', { name: '复制 demo_access 的值', exact: true });
  assert.equal(await valueButton.textContent(), fixtureCookies[1].value);
  assert.equal(await valueButton.evaluate(element => getComputedStyle(element).textOverflow === 'ellipsis' && getComputedStyle(element).whiteSpace === 'nowrap' && element.scrollWidth > element.clientWidth), true);
  assert.equal(await panel.getByRole('button', { name: '复制值', exact: true }).count(), 0);
  const nameBounds = await panel.getByText('demo_access', { exact: true }).boundingBox();
  const valueBounds = await valueButton.boundingBox();
  assert.ok(valueBounds.width <= 240);
  assert.equal(await panel.locator('.cookie-row .cookie-meta').count(), 0);
  assert.ok(valueBounds.x > nameBounds.x + nameBounds.width && Math.abs(valueBounds.y - nameBounds.y) < 10);
  // Observe the clipboard boundary without touching the user's system clipboard.
  await panel.evaluate(() => {
    window.originalWriteText = navigator.clipboard.writeText;
    window.copiedValues = [];
    navigator.clipboard.writeText = async text => { window.copiedValues.push(text); };
  });
  await valueButton.click();
  await panel.getByText('已复制到系统剪贴板', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '隐藏 demo_access 的值', exact: true }).click();
  assert.equal(await valueButton.textContent(), '••••••••••••••••');
  await valueButton.focus();
  await panel.keyboard.press('Enter');
  await panel.waitForFunction(() => window.copiedValues.length === 2);
  assert.deepEqual(await panel.evaluate(() => window.copiedValues), [fixtureCookies[1].value, fixtureCookies[1].value]);
  const visibilityButton = panel.getByRole('button', { name: '显示 demo_access 的值', exact: true });
  await visibilityButton.focus();
  await panel.keyboard.press('Space');
  assert.equal(await valueButton.textContent(), fixtureCookies[1].value);
  assert.equal(await panel.evaluate(() => window.copiedValues.length), 2);
  await panel.evaluate(() => { navigator.clipboard.writeText = window.originalWriteText; });
  await panel.screenshot({ path: join(output, 'cookie-inline-value.png'), fullPage: true });
  await panel.setViewportSize({ width: 375, height: 812 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await valueButton.evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');
  await panel.screenshot({ path: join(output, 'cookie-inline-value-mobile.png'), fullPage: true });
  await panel.setViewportSize({ width: 1100, height: 850 });
  passed('inline plaintext values truncate, copy complete values while masked, and toggle with keyboard');
  const selectedAccess = panel.getByRole('checkbox', { name: /^选择 demo_access，/ });
  await selectedAccess.check();
  await panel.getByRole('button', { name: '隐藏 demo_access 的值', exact: true }).click();
  for (const tab of [/^收藏 \d/, /^设置$/]) {
    await panel.getByRole('button', { name: tab }).click();
    await panel.getByRole('button', { name: /^当前网站 \d/ }).click();
    assert.equal(await selectedAccess.isChecked(), true);
    assert.equal(await valueButton.textContent(), '••••••••••••••••');
  }
  await panel.getByRole('button', { name: '重新绑定', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('.shell').getAttribute('aria-busy') === 'false');
  assert.equal(await selectedAccess.isChecked(), false);
  assert.equal(await valueButton.textContent(), fixtureCookies[1].value);
  passed('Cookie selection and hidden values survive tab changes and reset after target rebind');
  await panel.getByLabel('全选可见项').check();
  await panel.getByRole('button', { name: '复制选中项', exact: true }).click();
  await panel.getByText('已复制 2 项', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '收藏选中项' }).click();
  await panel.getByLabel('收藏名称').fill('测试管理员');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('收藏已保存', { exact: true }).waitFor();
  assert.equal(await panel.locator('.toast').evaluate(element => getComputedStyle(element).position), 'fixed');
  assert.equal(await panel.locator('.toast').evaluate(element => getComputedStyle(element).color), 'rgb(103, 194, 58)');
  assert.equal(await panel.locator('.shell > .notice').count(), 0);
  await panel.waitForFunction(() => {
    const toast = document.querySelector('.toast');
    return toast && getComputedStyle(toast).opacity === '1' && !toast.classList.contains('toast-slide-enter-active');
  });
  await panel.screenshot({ path: join(output, 'manager-toast.png') });
  await panel.getByText('收藏已保存', { exact: true }).waitFor({ state: 'hidden', timeout: 4500 });
  // Delay one read to check that a pending operation produces no loading toast.
  await panel.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      if (message.action === 'read') {
        chrome.runtime.sendMessage = send;
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      return send(message);
    };
  });
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: '刷新', exact: true }).isDisabled(), true);
  assert.equal(await panel.locator('.toast').count(), 0);
  await panel.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === '刷新').disabled);
  // Simulate a partial result without changing cookies to exercise warning feedback.
  await panel.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      if (message.action === 'apply') {
        chrome.runtime.sendMessage = send;
        return { ok: true, data: { operation: { status: 'partial' } } };
      }
      return send(message);
    };
  });
  await panel.getByRole('button', { name: '应用已复制项', exact: true }).click();
  await panel.locator('.toast-warning').waitFor();
  assert.equal(await panel.locator('.toast-warning').evaluate(element => getComputedStyle(element).color), 'rgb(230, 162, 60)');
  assert.equal(await panel.locator('.toast button').count(), 0);
  await panel.waitForFunction(() => document.querySelector('.toast-slide-leave-active'), null, { polling: 'raf', timeout: 8000 });
  assert.equal(await panel.locator('.toast').evaluate(element => getComputedStyle(element).transitionDuration), '0.3s, 0.3s');
  await panel.locator('.toast').waitFor({ state: 'detached' });
  passed('manager feedback uses non-blocking toast with automatic dismissal');
  passed('source selection, HttpOnly read, temporary copy and named favorite');

  const savedFavorite = (await send('state')).favorites.find(item => item.name === '测试管理员');
  await panel.getByRole('button', { name: /^收藏 \d/ }).click();
  const adminFavorite = panel.locator('.favorite-card').filter({ has: panel.getByRole('heading', { name: savedFavorite.name, exact: true }) });
  await adminFavorite.getByRole('button', { name: '编辑', exact: true }).click();
  await panel.getByLabel('收藏名称', { exact: true }).fill('未保存的名称');
  const favoriteCookieEditor = panel.locator('dialog .editor-item').first();
  await favoriteCookieEditor.locator('summary').click();
  await favoriteCookieEditor.getByLabel('值', { exact: true }).fill('unsaved-cookie-value');
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual((await send('state')).favorites.find(item => item.id === savedFavorite.id), savedFavorite);
  await adminFavorite.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await panel.getByLabel('收藏名称', { exact: true }).inputValue(), savedFavorite.name);
  await favoriteCookieEditor.locator('summary').click();
  assert.equal(await favoriteCookieEditor.getByLabel('值', { exact: true }).inputValue(), savedFavorite.cookies[0].value);
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await panel.getByRole('button', { name: /^当前网站 \d/ }).click();
  passed('cancelling favorite edits preserves both the saved snapshot and the next editing draft');

  for (const view of ['manage', 'popup']) {
    await panel.goto(`chrome-extension://${id}/index.html?${view === 'manage' ? 'view=manage&' : ''}target=${destinationId}`);
    await panel.setViewportSize({ width: view === 'manage' ? 1100 : 440, height: view === 'manage' ? 850 : 540 });
    const searchInput = panel.getByRole('searchbox');
    await searchInput.click();
    assert.equal(await searchInput.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
    await panel.keyboard.press('Tab');
    await panel.keyboard.press('Shift+Tab');
    assert.deepEqual(await searchInput.evaluate(element => ({ focused: document.activeElement === element, outline: getComputedStyle(element).outlineStyle, border: getComputedStyle(element).borderColor, background: getComputedStyle(element).backgroundColor })), { focused: true, outline: 'none', border: 'rgb(199, 208, 227)', background: 'rgb(242, 245, 255)' });
    await panel.evaluate(async info => {
      await chrome.cookies.set({ url: info.url, name: 'demo_session', value: 'preserve-conflict', path: '/app', sameSite: 'lax' });
      await chrome.cookies.set({ url: info.url, name: 'demo_access', value: 'replace-me', path: '/' });
    }, targetInfo);
    await panel.getByRole('button', { name: '选项', exact: true }).click();
    const all = panel.getByRole('checkbox', { name: '全选 Cookie' });
    const confirm = panel.getByRole('button', { name: '确认应用', exact: true });
    assert.equal(await all.isChecked(), true);
    await all.uncheck();
    assert.equal(await confirm.isDisabled(), true);
    await all.check();
    const sessionItem = panel.locator('dialog .editor-item').filter({ hasText: 'demo_session' });
    await sessionItem.locator('summary').click();
    await sessionItem.getByLabel('路径', { exact: true }).fill('invalid-path');
    await sessionItem.getByRole('checkbox', { name: /^应用 demo_session/ }).uncheck();
    assert.equal(await sessionItem.getAttribute('open'), '');
    assert.equal(await all.evaluate(element => element.indeterminate), true);
    assert.equal(await confirm.isEnabled(), true);
    await panel.screenshot({ path: join(output, `apply-selection-${view}.png`) });
    await confirm.click();
    await panel.getByText('Cookie 已应用，目标页面已刷新', { exact: true }).waitFor();
    const applied = (await send('read', { target: targetInfo })).cookies;
    assert.equal(applied.find(cookie => cookie.name === 'demo_access').value, fixtureCookies[1].value);
    assert.equal(applied.find(cookie => cookie.name === 'demo_session').value, 'preserve-conflict');
    assert.equal((await send('state')).clipboard.cookies.length, 2);
    assert.equal((await send('state')).clipboard.cookies[0].path, '/');
    await panel.getByRole('button', { name: '选项', exact: true }).click();
    assert.equal(await all.isChecked(), true);
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await panel.evaluate(async info => chrome.cookies.remove({ url: info.url, name: 'demo_session' }), targetInfo);
  }
  await panel.setViewportSize({ width: 1100, height: 850 });
  passed('manager and popup apply selection: defaults, partial state, empty guard, subset validation/writes and unchanged clipboard');

  await panel.goto(`chrome-extension://${id}/index.html?view=manage&target=${destinationId}`);
  await panel.getByRole('button', { name: '应用已复制项', exact: true }).click();
  await panel.getByText('Cookie 已应用，目标页面已刷新', { exact: true }).waitFor();
  const destinationCookies = (await send('read', { target: targetInfo })).cookies;
  assert.equal(destinationCookies.find(cookie => cookie.name === 'demo_session').value, 'fixture-admin==');
  assert.equal(destinationCookies.find(cookie => cookie.name === 'demo_session').httpOnly, true);
  assert.equal(destinationCookies.find(cookie => cookie.name === 'unrelated').value, 'keep');
  passed('cross-host application, readback, refresh and unrelated-cookie preservation');

  await panel.getByRole('button', { name: '导入', exact: true }).click();
  await checkImportReplacement('manager');
  await panel.getByLabel('Cookie 文本或 JSON').fill('a=one; a=two');
  await panel.getByRole('button', { name: '解析并预览' }).click();
  await panel.getByRole('alert').filter({ hasText: '重复' }).waitFor();
  assert.equal(await panel.locator('dialog .toast[role="alert"]').count(), 1);
  assert.equal(await panel.locator('.toast-error').evaluate(element => getComputedStyle(element).color), 'rgb(245, 108, 108)');
  await panel.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await panel.locator('.toast button').count(), 0);
  await panel.locator('.toast').waitFor({ state: 'detached' });
  await panel.emulateMedia({ reducedMotion: 'no-preference' });
  await panel.getByLabel('Cookie 文本或 JSON').fill('imported=fixture==; empty=');
  await panel.getByRole('button', { name: '解析并预览' }).click();
  await panel.getByRole('heading', { name: '已解析 2 项' }).waitFor();
  await panel.getByRole('button', { name: '应用到当前站', exact: true }).click();
  await panel.getByText('Cookie 已应用，目标页面已刷新', { exact: true }).waitFor();
  assert.equal((await send('read', { target: targetInfo })).cookies.find(cookie => cookie.name === 'imported').value, 'fixture==');
  passed('import validation, text parser and actual Chrome writes');

  await panel.evaluate(async target => chrome.cookies.set({ url: target.url, name: 'demo_session', value: 'old-fixture', path: '/app', sameSite: 'lax' }), targetInfo);
  await panel.getByRole('button', { name: '应用已复制项', exact: true }).click();
  await panel.getByRole('heading', { name: '发现同名 Cookie 冲突' }).waitFor();
  await panel.getByLabel('删除上列冲突项后写入').check();
  await panel.getByRole('button', { name: '确认应用', exact: true }).click();
  await panel.getByText('Cookie 已应用，目标页面已刷新', { exact: true }).waitFor();
  assert.equal((await send('read', { target: targetInfo })).cookies.filter(cookie => cookie.name === 'demo_session').length, 1);
  passed('path conflict confirmation and exact deletion');

  await panel.getByRole('button', { name: '＋ 新增', exact: true }).click();
  await panel.getByLabel('名称', { exact: true }).fill('created');
  await panel.getByLabel('值', { exact: true }).fill('new-fixture');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('Cookie 已保存', { exact: true }).waitFor();
  const createdRow = panel.locator('.cookie-row').filter({ has: panel.getByText('created', { exact: true }) });
  await createdRow.getByRole('button', { name: '编辑', exact: true }).click();
  await panel.getByLabel('名称', { exact: true }).fill('renamed');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('renamed', { exact: true }).first().waitFor();
  assert.equal((await send('read', { target: targetInfo })).cookies.some(cookie => cookie.name === 'created'), false);
  passed('create and identity-changing edit');

  const renamedRow = panel.locator('.cookie-row').filter({ has: panel.getByText('renamed', { exact: true }) });
  const httpOnlyCheckbox = renamedRow.getByRole('checkbox', { name: /^HttpOnly/ });
  const secureCheckbox = renamedRow.getByRole('checkbox', { name: /^Secure/ });
  await httpOnlyCheckbox.click();
  await panel.waitForFunction(() => document.querySelector('.shell').getAttribute('aria-busy') === 'false');
  assert.equal(await httpOnlyCheckbox.isChecked(), true);
  assert.equal((await send('read', { target: targetInfo })).cookies.find(c => c.name === 'renamed').httpOnly, true);
  assert.equal((await send('state')).lastOperation.refreshed, undefined);
  await httpOnlyCheckbox.focus();
  await panel.keyboard.press('Space');
  await panel.waitForFunction(() => document.querySelector('.shell').getAttribute('aria-busy') === 'false');
  assert.equal(await httpOnlyCheckbox.isChecked(), false);
  await secureCheckbox.click();
  await panel.getByRole('heading', { name: '检查 Cookie 属性', exact: true }).waitFor();
  assert.equal(await secureCheckbox.isChecked(), false);
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await defaultContext.route('https://localhost/flags/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>HTTPS fixture</title><h1>Synthetic HTTPS page</h1>' }));
  await destination.goto('https://localhost/flags/');
  const secureTarget = (await send('target', { tabId: destinationId })).target;
  await panel.goto(`chrome-extension://${id}/index.html?view=manage&target=${destinationId}`);
  await secureCheckbox.click();
  await panel.waitForFunction(() => document.querySelector('.shell').getAttribute('aria-busy') === 'false');
  assert.equal(await secureCheckbox.isChecked(), true);
  await panel.evaluate(async target => chrome.cookies.set({ url: target.url, name: 'renamed', value: 'new-fixture', path: '/', secure: true, sameSite: 'no_restriction' }), secureTarget);
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('.shell').getAttribute('aria-busy') === 'false');
  await secureCheckbox.click();
  await panel.getByRole('heading', { name: '检查 Cookie 属性', exact: true }).waitFor();
  assert.equal(await secureCheckbox.isChecked(), true);
  assert.equal((await send('read', { target: secureTarget })).cookies.find(c => c.name === 'renamed').secure, true);
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await panel.evaluate(async target => chrome.cookies.set({ url: target.url, name: 'renamed', value: 'new-fixture', path: '/', secure: true, sameSite: 'lax' }), secureTarget);
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await secureCheckbox.click();
  await panel.waitForFunction(() => document.querySelector('.shell').getAttribute('aria-busy') === 'false');
  assert.equal(await secureCheckbox.isChecked(), false);
  passed('inline flags save and verify without reload, support keyboard and preserve state on invalid combinations');

  await renamedRow.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = panel.locator('dialog .editor-grid');
  assert.equal(await panel.getByRole('group', { name: '安全与作用范围', exact: true }).count(), 1);
  await panel.getByLabel('会话 Cookie', { exact: true }).uncheck();
  await panel.getByLabel('到期时间（UTC）').fill('2030-01-01T00:00');
  const nameBox = await panel.getByLabel('名称', { exact: true }).boundingBox();
  const valueBox = await panel.getByLabel('值', { exact: true }).boundingBox();
  assert.equal(Math.round(nameBox.width), Math.round(valueBox.width));
  await panel.screenshot({ path: join(output, 'cookie-editor-desktop.png'), fullPage: true });
  await panel.setViewportSize({ width: 440, height: 540 });
  assert.equal(await editor.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await panel.getByLabel('会话 Cookie', { exact: true }).check();
  assert.equal(await panel.getByLabel('到期时间（UTC）').count(), 0);
  await panel.screenshot({ path: join(output, 'cookie-editor-narrow.png'), fullPage: true });
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  passed('grouped editor uses full-width fields, responsive layout and conditional expiration');
  await destination.goto(targetInfo.url);
  await panel.goto(`chrome-extension://${id}/index.html?view=manage&target=${destinationId}`);

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
  await panel.getByText('收藏已保存', { exact: true }).waitFor();
  await panel.evaluate(async info => chrome.cookies.set({ url: info.url, name: 'demo_session', value: 'fixture-user-updated', path: '/', httpOnly: true, sameSite: 'lax' }), sourceInfo);
  await panel.getByRole('button', { name: /^收藏 \d/ }).click();
  const userFavorite = panel.locator('.favorite-card').filter({ has: panel.getByRole('heading', { name: '测试普通用户' }) });
  await userFavorite.getByRole('button', { name: '从来源更新' }).click();
  await panel.getByRole('heading', { name: '从来源更新收藏' }).waitFor();
  assert.equal((await send('state')).favorites.find(item => item.name === '测试普通用户').cookies.find(cookie => cookie.name === 'demo_session').value, 'fixture-user');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('收藏已保存', { exact: true }).waitFor();
  await panel.goto(`chrome-extension://${id}/index.html?view=manage&target=${destinationId}`);
  await panel.getByRole('button', { name: /^收藏 \d/ }).click();
  for (const [name, value] of [['测试普通用户', 'fixture-user-updated'], ['测试管理员', 'fixture-admin==']]) {
    const card = panel.locator('.favorite-card').filter({ has: panel.getByRole('heading', { name }) });
    await card.getByRole('button', { name: '应用到当前站', exact: true }).click();
    await panel.getByText('Cookie 已应用，目标页面已刷新', { exact: true }).waitFor();
    assert.equal((await send('read', { target: targetInfo })).cookies.find(cookie => cookie.name === 'demo_session').value, value);
  }
  passed('two-account switching and explicitly confirmed source refresh');

  await panel.getByRole('button', { name: '设置', exact: true }).click();
  await panel.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      if (message.action === 'settings') {
        chrome.runtime.sendMessage = send;
        return { ok: false, error: '测试设置保存失败' };
      }
      return send(message);
    };
  });
  await panel.getByLabel('应用成功后刷新目标页', { exact: false }).click();
  await panel.getByRole('alert').filter({ hasText: '测试设置保存失败' }).waitFor();
  assert.equal(await panel.getByLabel('应用成功后刷新目标页', { exact: false }).isChecked(), true);
  assert.equal((await send('state')).settings.autoRefresh, true);
  await panel.getByLabel('应用成功后刷新目标页', { exact: false }).click();
  await panel.waitForFunction(async () => !(await chrome.runtime.sendMessage({ action: 'state' })).data.settings.autoRefresh);
  await panel.waitForFunction(() => document.querySelector('.shell').getAttribute('aria-busy') === 'false');
  assert.equal(await panel.getByLabel('应用成功后刷新目标页', { exact: false }).isChecked(), false);
  await panel.getByRole('button', { name: '应用已复制项', exact: true }).click();
  await panel.getByText('Cookie 已应用', { exact: true }).waitFor();
  assert.equal((await send('state')).lastOperation.refreshed, undefined);
  passed('auto-refresh preference rolls back failed saves, retries, persists and is respected');

  await panel.goto(`chrome-extension://${id}/index.html?target=${destinationId}`);
  assert.equal(await panel.locator('.cookie-flags input').count(), 0);
  await panel.setViewportSize({ width: 320, height: 600 });
  assert.equal((await panel.locator('body').boundingBox()).width, 440);
  await panel.setViewportSize({ width: 440, height: 540 });
  await panel.getByText('demo_session', { exact: true }).first().waitFor();
  const popupValue = panel.getByRole('button', { name: '复制 demo_access 的值', exact: true });
  assert.equal(await popupValue.textContent(), fixtureCookies[1].value);
  assert.ok((await popupValue.boundingBox()).width <= 240);
  assert.equal(await panel.locator('.cookie-row .cookie-meta').count(), 0);
  assert.equal(await panel.getByRole('button', { name: '复制值', exact: true }).count(), 0);
  await panel.evaluate(() => {
    window.originalWriteText = navigator.clipboard.writeText;
    window.copiedValues = [];
    navigator.clipboard.writeText = async text => { window.copiedValues.push(text); };
  });
  const listBeforeCopy = await panel.locator('.cookie-list').boundingBox();
  await popupValue.click();
  await panel.getByText('已复制到系统剪贴板', { exact: true }).waitFor();
  assert.equal(await panel.locator('.shell > .notice').count(), 0);
  assert.deepEqual(await panel.locator('.cookie-list').boundingBox(), listBeforeCopy);
  assert.deepEqual(await panel.locator('.toast-success').evaluate(element => {
    const style = getComputedStyle(element);
    return [style.position, style.right, style.bottom];
  }), ['fixed', '12px', '12px']);
  await panel.waitForFunction(() => !document.querySelector('.toast-slide-enter-active'));
  await panel.screenshot({ path: join(output, 'popup-success-toast.png') });
  await panel.locator('.toast').waitFor({ state: 'detached', timeout: 4500 });
  await panel.getByRole('button', { name: '隐藏 demo_access 的值', exact: true }).click();
  assert.equal(await popupValue.textContent(), '••••••••••••••••');
  await popupValue.focus();
  await panel.keyboard.press('Enter');
  await panel.waitForFunction(() => window.copiedValues.length === 2);
  assert.deepEqual(await panel.evaluate(() => window.copiedValues), [fixtureCookies[1].value, fixtureCookies[1].value]);
  await panel.getByRole('button', { name: '显示 demo_access 的值', exact: true }).click();
  await panel.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('Synthetic clipboard failure'); }; });
  await popupValue.click();
  await panel.locator('.notice.error').filter({ hasText: '浏览器未允许写入剪贴板' }).waitFor();
  await panel.locator('.toast').waitFor({ state: 'detached' });
  await panel.evaluate(() => {
    navigator.clipboard.writeText = window.originalWriteText;
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      if (message.action === 'apply') {
        chrome.runtime.sendMessage = send;
        return { ok: true, data: { operation: { status: 'partial' } } };
      }
      return send(message);
    };
  });
  await panel.getByRole('button', { name: '应用已复制项', exact: true }).click();
  await panel.locator('.notice').filter({ hasText: '操作未全部完成' }).waitFor();
  assert.equal(await panel.locator('.toast').count(), 0);
  passed('popup success toast stays bottom-right without reflow; errors and warnings remain inline');
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('.shell').getAttribute('aria-busy') === 'false');
  passed('popup inline values support full-value copy and visibility toggle without metadata or copy buttons');
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
  await checkImportReplacement('popup');
  await panel.getByLabel('JSON 文件（最大 1 MB）').setInputFiles(resolve('examples/cookies.json'));
  await panel.getByRole('heading', { name: '已解析 1 项' }).waitFor();
  await panel.getByRole('button', { name: '保存为收藏', exact: true }).click();
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByText('收藏已保存', { exact: true }).waitFor();
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
