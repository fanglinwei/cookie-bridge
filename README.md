<p align="center">
  <img src="assets/logo/cookie-bridge-128.png" width="96" height="96" alt="Cookie Bridge logo">
</p>

# Cookie Bridge

English | [简体中文](README.zh-CN.md)

A Chrome Manifest V3 cookie manager built with Vue 3, TypeScript, Vite, and CRXJS. Select any cookies on website A, copy them temporarily or save them as a favorite, then apply them to website B. Useful for switching development accounts and reusing login snapshots. The UI is in Chinese. Data stays on your device, with no fixed site pairs, hard-coded cookie names, backend, or cloud sync.

![Cookie Bridge manager with demo data](docs/screenshots/manager-desktop.png)

See the [design document](docs/design.md) for visual guidelines and brand colors.

## Install

Requires **Chrome 120+** and **Node.js 20.19+ (20.x) or 22.12+**.

```sh
git clone https://github.com/fanglinwei/cookie-bridge.git
cd cookie-bridge
npm ci
npm run build
```

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select **`cookie-bridge/dist`** (not the source root).
3. Pin Cookie Bridge to the toolbar.

After updating the source, run `npm run build` again and click **Reload** on the extension card.

## Usage

### Copy to another website

1. Open the source website, click the extension icon, and choose **授权当前网站** (authorize this website) on first use.
2. Select cookies and click **复制选中项** (copy selected), or **收藏选中项** (save selected as a named favorite) for later use.
3. Open the target website, click the extension icon, and authorize it.
4. Click **应用已复制项** (apply copied cookies) or a favorite's **应用到当前站** (apply to this website). To apply only some cookies or adjust attributes and paths, first open **选项 / 应用选项** (options / application options) and select all or individual items. Unselected items remain in the buffer or favorite.
5. Review any conflicts and confirm. By default, the target tab refreshes after every write passes read-back verification; automatic refresh can be disabled in settings.

### View, edit, and save

- Cookie values are visible by default. Click a value to copy its full contents to the system clipboard; use the eye icon to hide or show it. **复制选中项** uses the extension's temporary buffer.
- The manager supports editing and deleting cookies, and toggling **HttpOnly / Secure** directly. Toggles update after write verification without refreshing the website.
- Favorites are fixed snapshots. Use **从来源更新** (update from source) on the source website, review the preview, and save to update one.
- The manager stays bound to its original tab. Use **重新绑定** (rebind) after its URL changes; if the tab closes, reopen the extension from the target website. A manager opened through extension settings can manage favorites and imports; enter through a website's popup to read or write its cookies.

### Import

Paste a Cookie request-header value, or use the format in the [JSON example](examples/cookies.json):

```text
demo_session=example==; theme=dark
```

Review the preview, then apply it or save it as a favorite. Parsing alone does not modify a website. Other extensions' private export formats are not guaranteed to work.

## Important notes

- **Secure cookies require an authorized HTTPS target.** HTTP targets, including localhost, are rejected before writing.
- Cross-site application defaults to the target host and path `/`, preserving values and security attributes. Matching names, domains, and paths are overwritten; conflicts with other paths or parent domains require confirmation. Cookies are not isolated by port or tab, and parent-domain cookies may affect subdomains.
- A batch failure stops remaining writes and prevents refresh; completed writes are not rolled back. Successful writes do not guarantee login, and extending expiry cannot restore server-invalidated credentials.
- Only regular windows and unpartitioned cookies are supported. Limits: 200 cookies per favorite/application, 200 favorites, and 1 MB per import.
- Website access is requested as needed and can be removed in settings. Favorites are stored locally **without encryption** and are deleted on uninstall. Restarting Chrome, reloading, or updating the extension clears the temporary buffer.
- Only use websites and accounts you are authorized to access. Remove real cookies, tokens, and private URLs before sharing screenshots, files, or feedback.

## Development

Built with Vue 3, TypeScript, Vite, and CRXJS. After installing dependencies:

```sh
npm run dev    # Dev server: 127.0.0.1:5174; load dist while running
```

Vue pages support hot updates. Reload the extension after manifest or permission changes. Stop the dev server and run `npm run build` before distributing the extension.

### Current architecture

The recent refactor migrates the JavaScript entry point, service worker, core logic, and Vite configuration to TypeScript, and splits the UI and business operations previously concentrated in `App.vue` into the modules below. The popup and manager still share components; URL parameters select the view and bind its target tab.

| Module | Responsibility |
| --- | --- |
| [App.vue](src/App.vue) | Page composition, coordination across modules, busy state, notifications, and operation results. |
| [Business panels](src/components/) | `CookiesPanel.vue` owns the list, selection, and value visibility; `FavoritesPanel.vue` displays favorites; `SettingsPanel.vue` displays settings and permissions. Props supply data and events submit actions. |
| [CookieDialog.vue](src/components/CookieDialog.vue) / [CookieEditor.vue](src/components/CookieEditor.vue) | The dialog owns independent drafts, import previews, and application selection; the editor provides cookie attribute fields. Events report parsing state and errors; a feedback slot renders notifications. Starting an import clears the previous preview, and parsing blocks submission. |
| [Composables](src/composables/) | `useTargetSite` handles target binding, authorization, and reads; `useFavorites` handles saving, deletion, and source previews; `useSettings` handles refresh preferences and permission removal. |
| [extension.ts](src/extension.ts) / [types.ts](src/types.ts) | Centralized message calls and error handling, with shared cookie, favorite, operation, and request/response types. Vue reactive data is converted to plain data before sending. |
| [background.ts](src/background.ts) / [core.ts](core.ts) | The service worker owns Chrome cookie APIs, target and permission checks, serialized operations, and storage. The core module provides runtime validation, import parsing, attribute mapping, conflict detection, and batch execution rules. |

Cookie reads and writes follow component events → `App.vue` / composables → `extension.ts` → service worker, with `core.ts` rules shared by the UI and worker. The worker verifies writes by reading them back and saves per-item results; the UI reloads state. Website authorization requests remain in the user-click call chain. Favorites and preferences use `chrome.storage.local`; the temporary buffer and latest operation use `chrome.storage.session`. The UI subscribes to stored operation changes.

The build entry point is `src/main.ts`, configuration is in `vite.config.ts`, and shared styles remain in `src/style.css`. `tsconfig.json` enables strict checking of Vue scripts/templates, the worker, and core modules. TypeScript is pinned to 5.9.3. `npm test` compiles through `tsconfig.test.json` into the ignored `.test-build/` directory before running core, background, and composable tests with Node's test runner; native Node TypeScript support is unnecessary. `npm run check` runs type checking, unit tests, and the production build in order.

## Validation

```sh
npm run check     # Type checking, unit tests, and production build
# Or run separately:
npm run typecheck
npm test
npm run build
```

The optional browser suite uses an existing Playwright installation and a Chrome build supporting DevTools `Extensions.loadUnpacked`:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROME_PATH='/absolute/path/to/chrome' \
node tests/browser-smoke.mjs
```

The suite launches an isolated browser profile and temporary HTTP sites, using fictional cookie values. It preauthorizes localhost and 127.0.0.1 only in a test extension copy, leaves the production manifest unchanged, and writes artifacts to the ignored `test-results/` directory. It closes and cleans up the test environment when finished.

Use test accounts you are authorized to access. Successful cookie writes do not guarantee that the application accepts the credentials or logs you in.

First-time native permission prompts and real application login acceptance still need manual verification. Strict TypeScript checking covers Vue scripts/templates, shared types, the service worker, core logic, and Vite configuration. No separate lint command is configured.

## Contributing and feedback

Bug reports and focused pull requests are welcome. [Open an issue](https://github.com/fanglinwei/cookie-bridge/issues) with your Chrome/Node.js versions, reproduction steps, expected behavior, and sanitized examples.

1. Fork the repository and create a branch for your change.
2. Install dependencies and keep changes focused; add or update tests for behavior changes.
3. Run `npm run check`. For Chrome API or UI changes, run the browser suite and manually check first-time authorization.
4. Open a pull request describing the problem, change, and verification. Include screenshots for UI changes.

Do not include real cookies, tokens, account details, or private URLs in issues, pull requests, screenshots, or examples. Cookies may contain login credentials, and favorites are stored without encryption. Only use websites and accounts you are authorized to access.

## License

[MIT License](LICENSE) © 2026 Fun (fanglinwei).
