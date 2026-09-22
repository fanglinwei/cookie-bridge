# Cookie Bridge

[English](README.md) | 简体中文

Vue 3 + TypeScript + Vite + CRXJS 构建的 Chrome Manifest V3 Cookie 管理插件。在 A 网站选取任意 Cookie，临时复制或保存为收藏，再应用到当前 B 网站，适合开发环境切换账号、复用登录配置。界面为中文，数据保存在本机，无站点配对、无固定 Cookie 名称、无后端、无云同步。

![Cookie Bridge 管理页](docs/screenshots/manager-desktop.png)

视觉规范与品牌配色见 [设计文档](docs/design.md)。

## 安装

需要 **Chrome 120+**，以及 **Node.js 20.19+（20.x）或 22.12+**。

```sh
git clone https://github.com/fanglinwei/cookie-bridge.git
cd cookie-bridge
npm ci
npm run build
```

1. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择 **`cookie-bridge/dist`**（不是源码根目录）。
3. 将 Cookie Bridge 固定到工具栏。

更新源码后，重新运行 `npm run build`，再在扩展管理页点击“重新加载”。

## 使用

### 复制到另一个网站

1. 打开来源网站，点击插件图标，首次使用点击“授权当前网站”。
2. 勾选 Cookie，点击“复制选中项”；需要长期保存时，点击“收藏选中项”并命名。
3. 打开目标网站，点击插件图标并授权。
4. 点击“应用已复制项”，或收藏的“应用到当前站”。需要仅应用部分项或调整属性、路径时，先打开“选项 / 应用选项”，全选或逐项勾选；未选项仍保留在临时区或收藏中。
5. 按提示处理冲突并确认。全部写入且回读验证通过后，默认刷新目标标签页，可在设置中关闭刷新。

### 查看、编辑与收藏

- Cookie 值默认显示，点击值可复制完整内容到系统剪贴板，眼睛图标可隐藏或显示值；“复制选中项”使用插件内部临时区。
- 管理页支持编辑、删除 Cookie，也可直接切换 **HttpOnly / Secure**；开关写入并验证后更新显示，不刷新网站。
- 收藏是固定快照。需要更新时，在来源网站使用“从来源更新”，检查预览后保存。
- 管理页绑定打开它的标签页。地址变化后需“重新绑定”；标签页关闭时，从目标网站重新打开插件。直接从扩展设置打开的管理页可管理收藏和导入，读写网站请从对应网站的插件弹窗进入。

### 导入

粘贴 Cookie 请求头的值，或使用 [JSON 示例](examples/cookies.json) 的格式：

```text
demo_session=example==; theme=dark
```

解析后检查预览，再选择应用或保存收藏；仅解析不会修改网站。不保证兼容其他插件的私有导出格式。

## 必要提示

- **Secure Cookie 必须写入已授权的 HTTPS 网站**；HTTP（包括 localhost）会在写入前被拒绝。
- 跨站应用默认使用目标主机和路径 `/`，保留值及安全属性；相同名称、域、路径的 Cookie 会被覆盖，其他路径或父域冲突需确认。Cookie 不按端口或标签页隔离，父域 Cookie 也可能影响子域。
- 批量写入失败会停止后续项、不刷新，已写入项不会自动回滚。写入成功不代表登录成功，延长到期时间不能恢复服务端已失效的凭据。
- 仅支持普通窗口、未分区 Cookie。每份收藏 / 每次应用最多 200 项，最多 200 份收藏，导入上限 1 MB。
- 网站权限按需申请，可在设置中移除。收藏仅保存在本机，**未加密**，卸载扩展会删除；浏览器重启、扩展重载或更新会清空临时复制区。
- 仅操作有权访问的网站和账号；分享截图、文件或反馈时，请移除真实 Cookie、token 和私有站点信息。

## 开发

基于 Vue 3、TypeScript、Vite 和 CRXJS；安装依赖后运行：

```sh
npm run dev    # 开发服务：127.0.0.1:5174，运行期间加载 dist
```

Vue 页面支持热更新；修改 Manifest 或权限后需手动重新加载扩展。分发前停止开发服务并运行 `npm run build`。

### 当前架构

最近的重构将 JavaScript 入口、后台、核心逻辑和 Vite 配置迁移到 TypeScript，并将原先集中在 `App.vue` 的界面与业务操作拆分如下。弹窗和管理页仍共用同一套组件，通过 URL 参数选择视图及绑定目标标签页。

| 模块 | 职责 |
| --- | --- |
| [App.vue](src/App.vue) | 页面组装、跨模块操作协调、忙碌状态、通知和操作结果展示。 |
| [业务面板](src/components/) | `CookiesPanel.vue` 管理列表、选择和显隐；`FavoritesPanel.vue` 展示收藏；`SettingsPanel.vue` 展示设置与授权。通过 props 接收数据、事件提交操作。 |
| [CookieDialog.vue](src/components/CookieDialog.vue) / [CookieEditor.vue](src/components/CookieEditor.vue) | 对话框持有独立草稿、导入预览和应用选择；编辑器负责 Cookie 属性表单。解析状态和错误通过事件上报，通知通过反馈 slot 渲染。新导入开始时清空旧预览，解析期间禁止提交。 |
| [组合函数](src/composables/) | `useTargetSite` 管理目标绑定、授权与读取；`useFavorites` 处理收藏保存、删除和来源预览；`useSettings` 处理刷新偏好与撤销授权。 |
| [extension.ts](src/extension.ts) / [types.ts](src/types.ts) | 统一消息调用与错误处理，共享 Cookie、收藏、操作结果及请求/响应类型；发送前将 Vue 响应式数据转换为普通数据。 |
| [background.ts](src/background.ts) / [core.ts](core.ts) | 后台负责 Chrome Cookie API、目标与权限复核、串行操作和存储；核心模块提供运行时校验、导入解析、属性映射、冲突检测及批量执行规则。 |

Cookie 读写经由“组件事件 → `App.vue` / 组合函数 → `extension.ts` → 后台”执行，前台与后台共用 `core.ts` 规则。后台写入后回读验证并保存逐项结果，界面重新读取状态；网站授权请求保留在用户点击触发的调用链中。收藏和偏好存入 `chrome.storage.local`，临时复制与最近操作结果存入 `chrome.storage.session`，界面监听操作结果的存储变化。

构建入口为 `src/main.ts`，配置为 `vite.config.ts`，共用样式仍在 `src/style.css`。`tsconfig.json` 启用严格类型检查，覆盖 Vue 脚本与模板、后台及核心模块。TypeScript 固定为 5.9.3；`npm test` 先按 `tsconfig.test.json` 编译到已忽略的 `.test-build/`，再由 Node 测试运行器执行核心、后台和组合函数测试，无需 Node 原生支持 TypeScript。`npm run check` 依次执行类型检查、单元测试和生产构建。

## 校验

```sh
npm run check     # 类型检查、单元测试和生产构建
# 也可分别运行：
npm run typecheck
npm test
npm run build
```

浏览器测试复用已有 Playwright 安装，不属于生产依赖。需要支持 DevTools `Extensions.loadUnpacked` 的较新 Chrome：

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROME_PATH='/absolute/path/to/chrome' \
node tests/browser-smoke.mjs
```

测试启动隔离浏览器和生命周期内的临时 HTTP 站点，结束后关闭并清理。测试扩展副本仅预授权 localhost 与 127.0.0.1；生产 Manifest 的网站权限仍为可选。测试只使用虚构值，不读写用户的浏览器配置。截图及结果写入忽略版本控制的 `test-results/`。

真实业务验收时，请使用你有权访问的测试账号。插件成功提示只代表 Cookie 写入验证成功，不代表业务后台接受凭据或登录成功。

## 贡献与反馈

欢迎通过 [Issues](https://github.com/fanglinwei/cookie-bridge/issues) 报告问题或建议，通过 Pull Request 提交改进。

1. Fork 仓库，并为修改创建分支。
2. 安装依赖，保持修改范围集中；行为变更请添加或更新相应测试。
3. 执行 `npm run check`；涉及 Chrome API 或界面时，按上文运行浏览器测试，并手动验证首次授权。
4. 提交 PR，描述问题、修改及验证结果；界面修改请附截图。

报告问题时请提供 Chrome / Node.js 版本、复现步骤和预期行为。不要在 Issue、PR、截图或示例中提供真实 Cookie、token、账号或私有站点信息。Cookie 可能包含登录凭据，收藏以明文存储；仅对你有权访问的网站与账号操作。

## 许可证

[MIT License](LICENSE) © 2026 Fun (fanglinwei)。
