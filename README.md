<p align="center">
  <img src="assets/logo/cookie-bridge-128.png" width="96" height="96" alt="Cookie Bridge logo">
</p>

# Cookie Bridge

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Chrome: 120+](https://img.shields.io/badge/Chrome-120%2B-4285F4.svg)](manifest.json)

Select, save, and apply cookies across websites. A local-first Chrome Manifest V3 extension for switching development accounts and reusing cookie snapshots, built with Vue 3, Vite, and CRXJS.

No backend or cloud sync. No fixed site pairs or hard-coded cookie names. The extension UI is currently in Chinese.

![Cookie Bridge manager with demo data](docs/screenshots/manager-desktop.png)

## Features

- Browse, select, edit, and delete cookies for an authorized website.
- Copy selected cookies to a temporary buffer, or save named favorites for later use.
- Apply a snapshot to another website while preserving cookie security attributes.
- Preview conflicts and choose how to handle cookies with overlapping names or paths.
- Update a favorite from its source website after reviewing a preview.
- Import a Cookie request-header value or versioned JSON.
- Manage site permissions and choose whether to refresh after a successful application.

## Install from source

Requires **Chrome 120+** and **Node.js 20.19+ (20.x) or 22.12+**. Node.js 24 is a suitable choice.

```sh
git clone https://github.com/fanglinwei/cookie-bridge.git
cd cookie-bridge
npm ci
npm run check
```

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the generated **`cookie-bridge/dist`** directory.
4. Pin Cookie Bridge to the browser toolbar.

The repository root is source code; load the built `dist` directory. When updating, rebuild and click **Reload** on the extension card.

## Usage

1. Open the source website, open Cookie Bridge, and click **授权当前网站** (authorize this website).
2. Select cookies and click **复制选中项** (copy selected), or **收藏选中项** (save selected as a favorite).
3. Open the target website and authorize it through the extension.
4. Click **应用已复制项** (apply copied cookies) or **应用到当前站** (apply a favorite to this website).
5. Review any conflicts or options. By default, the target tab refreshes only after every write passes read-back verification.

“Copy selected” uses the extension's temporary buffer. “Copy value” and “Copy text” use the system clipboard.

The manager stays bound to the tab from which it was opened. Closing that tab or changing its URL stops operations until you explicitly rebind it. A manager opened directly from extension settings can manage favorites and imports; open it from a website's popup to operate on that website.

### Import formats

Paste the value of a Cookie request header:

```text
demo_session=example==; theme=dark
```

For versioned JSON, see [examples/cookies.json](examples/cookies.json), which contains fictional values only. Imports without a source are labeled as external / unknown source. Parsing and previewing an import does not write cookies; explicitly apply it or save it as a favorite. Other extensions' private export formats are not guaranteed to work.

## Cookie behavior and limitations

- Cross-site application maps cookies to the target host and defaults to path `/`, preserving values and security attributes. The source domain is not carried over.
- Cookies with matching name, domain, and path are overwritten; unrelated cookies remain. Conflicts involving other paths or parent domains require a choice before continuing.
- Deletion lists the affected cookies and requires confirmation. Parent-domain cookies can affect other subdomains.
- Cookies are not isolated by port or tab. Localhost projects may share cookies with the same name and path.
- Batch writes are **not atomic**. A failure stops remaining writes, keeps per-item results, and prevents automatic refresh. There is no automatic rollback.
- Changing a cookie's name, domain, or path writes and verifies the new cookie before deleting the original. A deletion failure is reported as partial completion.
- Favorites are fixed snapshots. Updating from the source requires a preview; if any original cookie is missing, the old snapshot is retained.
- Only regular windows and unpartitioned cookies are supported. Incognito and partitioned cookies are outside the supported scope.
- Expired or incompatible cookies require attention. Extending a cookie's expiry cannot restore a server-invalidated token. Successful writes do not guarantee a successful login.
- Limits: 200 cookies per favorite/application, 200 favorites, 1 MB per import, and 4,096 bytes for a cookie name and value combined. Chrome may reject writes because of additional attribute or domain rules.

## Privacy and permissions

| Permission | Purpose |
| --- | --- |
| `cookies` | Read and manage cookies on websites you authorize. |
| `storage` | Store favorites, preferences, and the temporary copy buffer. |
| `activeTab` | Identify the active website when you invoke the extension. |
| Optional HTTP/HTTPS host access | Requested as needed for a website; review or remove grants in settings. |

Favorites and preferences use `chrome.storage.local`; the temporary buffer uses `chrome.storage.session`. Storage is restricted to trusted extension contexts. Favorites are stored locally **without encryption** and are deleted when the extension is uninstalled. Restarting Chrome, reloading, or updating the extension clears the temporary buffer.

Favorites preserve cookie values, attributes, and source-site information. Source URLs omit query strings and fragments. The extension does not inject page scripts, intercept network requests, or execute imported text. It does not upload favorites or sync them to a server.

Cookies may contain login credentials. Use the extension only with websites and accounts you are authorized to access. Never include real cookies, tokens, account details, or private URLs in issues, pull requests, or screenshots.

## Development

```sh
npm ci
npm run dev
```

Load `dist` while the development server is running. CRXJS uses `127.0.0.1:5174` and supports Vue hot updates. Reload the extension manually after manifest or permission changes. Before distributing a build, stop the development server and run `npm run build`.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the extension development server. |
| `npm test` | Run the Node.js core and background tests. |
| `npm run build` | Build the production extension into `dist`. |
| `npm run check` | Run tests and the production build. |

### Browser smoke tests

The optional browser suite uses an existing Playwright installation and a Chrome build supporting DevTools `Extensions.loadUnpacked`:

```sh
npm run build
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROME_PATH='/absolute/path/to/chrome' \
node tests/browser-smoke.mjs
```

The suite launches an isolated browser profile and temporary HTTP sites, using fictional cookie values. It preauthorizes localhost and 127.0.0.1 only in a test extension copy, leaves the production manifest unchanged, and writes artifacts to the ignored `test-results/` directory. It closes and cleans up the test environment when finished.

First-time native permission prompts and real application login acceptance still need manual verification. No separate lint or TypeScript check is configured; production builds validate Vue templates.

### Project structure

| Path | Responsibility |
| --- | --- |
| `manifest.json`, `vite.config.js` | MV3 permissions and Vue/CRXJS build configuration. |
| `src/App.vue`, `src/style.css` | Popup and manager UI, shared actions, and responsive layout. |
| `src/components/CookieEditor.vue` | Cookie attribute editor. |
| `src/background.js` | Chrome APIs, serialized writes, favorites, and persisted results. |
| `core.mjs` | Validation, imports, attribute mapping, conflicts, and batch execution. |
| `tests/` | Core, background, and browser smoke tests. |
| `assets/logo/`, `docs/design.md` | Icons and visual design documentation. |

## Contributing

Bug reports and focused pull requests are welcome. [Open an issue](https://github.com/fanglinwei/cookie-bridge/issues) with your Chrome/Node.js versions, reproduction steps, expected behavior, and sanitized examples.

1. Fork the repository and create a branch for your change.
2. Install dependencies and keep changes focused; add or update tests for behavior changes.
3. Run `npm run check`. For Chrome API or UI changes, run the browser suite and manually check first-time authorization.
4. Open a pull request describing the problem, change, and verification. Include screenshots for UI changes.

## License

[MIT](LICENSE) © 2026 Fun (fanglinwei). Third-party dependencies remain subject to their respective licenses.
