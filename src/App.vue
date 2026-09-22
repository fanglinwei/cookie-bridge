<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import CookieEditor from './components/CookieEditor.vue';
import { hostPattern, identity, MAX_IMPORT_BYTES, parseImport, prepareCookies, sourceInfo, validateCookies } from '../core.mjs';

const params = new URLSearchParams(location.search);
const manager = params.get('view') === 'manage';
document.documentElement.classList.toggle('manager', manager);
const target = ref(null);
const cookies = ref([]);
const selected = ref([]);
const search = ref('');
const section = ref('cookies');
const revealed = ref(new Set());
const busy = ref(false);
const notice = ref('');
const error = ref('');
const authorized = ref(false);
const state = reactive({ favorites: [], clipboard: null, settings: { autoRefresh: true }, permissions: [], lastOperation: null });
const modal = ref(null);
const dialog = ref(null);
const dialogError = ref('');
const textInput = ref('');
const imported = ref(null);
const available = Boolean(globalThis.chrome?.runtime?.id);

const origin = computed(() => target.value ? new URL(target.value.url).origin : '尚未选择目标网站');
const targetPath = computed(() => target.value ? new URL(target.value.url).pathname : '请在目标网站点击 Chrome 工具栏中的插件图标。');
const filtered = computed(() => cookies.value.filter(cookie => `${cookie.name} ${cookie.domain} ${cookie.path}`.toLowerCase().includes(search.value.toLowerCase())));
const picked = computed(() => cookies.value.filter(cookie => selected.value.includes(identity(cookie))));
const favorites = computed(() => state.favorites.filter(item => `${item.name} ${item.source.origin}`.toLowerCase().includes(search.value.toLowerCase())));
const allChecked = computed(() => filtered.value.length > 0 && filtered.value.every(cookie => selected.value.includes(identity(cookie))));
const operationLabel = computed(() => ({ success: '操作完成', partial: '部分完成，请检查结果', failed: '操作失败', running: '正在执行', interrupted: '操作中断，请核对' })[state.lastOperation?.status]);
const clone = data => JSON.parse(JSON.stringify(data));
const expiry = cookie => cookie.session ? '会话' : new Date(cookie.expirationDate * 1000).toLocaleString();
const when = time => new Date(time).toLocaleString();
const safeError = issue => issue?.message || '操作失败，请重试。';

async function request(action, data = {}) {
  if (!available) throw new Error('请在 Chrome 中加载构建后的扩展，再从工具栏打开。');
  let response;
  try { response = await chrome.runtime.sendMessage({ action, ...clone(data) }); }
  catch { throw new Error('无法连接扩展后台，请重新打开插件或重新加载扩展。'); }
  if (!response?.ok) throw new Error(response?.error || '后台没有返回结果，请重新打开插件。');
  return response.data;
}

async function run(action) {
  if (busy.value) return;
  busy.value = true;
  error.value = ''; notice.value = ''; dialogError.value = '';
  try { await action(); }
  catch (issue) { if (modal.value) dialogError.value = safeError(issue); else error.value = safeError(issue); }
  finally { busy.value = false; }
}

async function loadState() { Object.assign(state, await request('state')); }
async function read() {
  if (!target.value) return;
  authorized.value = await chrome.permissions.contains({ origins: [hostPattern(target.value.url)] });
  if (!authorized.value) { cookies.value = []; selected.value = []; return; }
  cookies.value = (await request('read', { target: target.value })).cookies;
  selected.value = selected.value.filter(key => cookies.value.some(cookie => identity(cookie) === key));
}

async function bindTarget() {
  const pinned = params.get('target');
  if (manager && !pinned) return;
  const result = await request('target', pinned ? { tabId: Number(pinned) } : {});
  target.value = result.target;
  revealed.value.clear(); selected.value = [];
  await read();
}

function grant() {
  if (!target.value) return;
  // Request immediately in the click gesture; do not await background work first.
  const permission = chrome.permissions.request({ origins: [hostPattern(target.value.url)] });
  run(async () => {
    if (!await permission) throw new Error('未获得网站授权；你的选择和收藏仍然保留。');
    await read(); await loadState(); notice.value = '网站已授权。';
  });
}

function toggleAll() {
  const keys = new Set(selected.value);
  for (const cookie of filtered.value) allChecked.value ? keys.delete(identity(cookie)) : keys.add(identity(cookie));
  selected.value = [...keys];
}

function reveal(cookie) {
  const key = identity(cookie);
  if (revealed.value.has(key)) revealed.value.delete(key); else revealed.value.add(key);
}

function openModal(value) {
  modal.value = { ...value };
  if (value.cookies) modal.value.cookies = value.cookies.map(cookie => ({ ...cookie, editorId: cookie.editorId || crypto.randomUUID() }));
  dialogError.value = '';
}
function closeModal() { if (!busy.value) modal.value = null; }
watch(modal, async value => {
  await nextTick();
  if (value && !dialog.value.open) dialog.value.showModal();
  else if (!value && dialog.value.open) dialog.value.close();
});
watch(section, () => { search.value = ''; });

function newCookie() {
  openModal({ type: 'edit', title: '新增 Cookie', cookie: { name: '', value: '', domain: new URL(target.value.url).hostname, path: '/', session: true, secure: false, httpOnly: false, hostOnly: true, sameSite: 'unspecified' }, original: null });
}
function editCookie(cookie) { openModal({ type: 'edit', title: '编辑 Cookie', cookie: clone(cookie), original: clone(cookie) }); }

function saveSelected() {
  openModal({ type: 'favorite', title: '保存为收藏', name: '', source: sourceInfo({ origin: target.value.url }), cookies: clone(picked.value) });
}
function editFavorite(item) { openModal({ ...clone(item), type: 'favorite', title: '编辑收藏' }); }

async function copySelected() {
  await request('copy', { target: target.value, cookies: picked.value }); await loadState();
  notice.value = `已复制 ${picked.value.length} 项，可切换到其他网站应用。`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); notice.value = '已复制到系统剪贴板。'; }
  catch { throw new Error('浏览器未允许写入剪贴板，请重试。'); }
}

function applyReview(item) {
  openModal({ type: 'apply', title: '应用 Cookie', cookies: clone(item.cookies).map(cookie => ({ ...cookie, path: '/' })), source: item.source, conflicts: [], conflictMode: '', original: null });
}

async function apply(item, advanced = false) {
  if (!target.value || !authorized.value) throw new Error('请先在目标网站打开插件并授权。');
  const draft = advanced ? item : { cookies: clone(item.cookies).map(cookie => ({ ...cookie, path: '/' })), source: item.source, original: null };
  try { prepareCookies(draft.cookies, target.value, { preservePath: true, preserveDomain: Boolean(draft.original || draft.edit) }); }
  catch (issue) {
    openModal({ ...draft, type: 'apply', title: '检查 Cookie 属性', conflicts: [], conflictMode: '' });
    dialogError.value = safeError(issue); return;
  }
  const result = await request('apply', {
    target: target.value, cookies: draft.cookies, original: draft.original,
    edit: Boolean(draft.edit), refresh: !draft.edit && state.settings.autoRefresh,
    conflictMode: draft.conflictMode, conflictIds: draft.conflicts,
  });
  if (result.conflicts) {
    openModal({ ...draft, type: 'apply', title: '发现同名 Cookie 冲突', conflicts: result.conflicts, conflictMode: '' });
    if (result.changed) dialogError.value = '冲突项已发生变化，请重新检查。';
    return;
  }
  modal.value = null;
  await loadState();
  notice.value = result.operation.status === 'success' ? `Cookie 已${draft.edit ? '保存' : '应用'}${result.operation.refreshed ? '，目标页面已刷新' : ''}。` : '操作未全部完成，请查看逐项结果。';
  await read();
}

async function submitModal() {
  const draft = modal.value;
  if (draft.type === 'favorite') {
    await request('saveFavorite', { id: draft.id, name: draft.name, source: draft.source, cookies: draft.cookies });
    modal.value = null; await loadState(); notice.value = '收藏已保存。';
  } else if (draft.type === 'edit') {
    await apply({ cookies: [draft.cookie], original: draft.original, edit: true }, true);
  } else if (draft.type === 'apply') {
    if (draft.conflicts?.length && !draft.conflictMode) throw new Error('请选择冲突处理方式。');
    await apply(draft, true);
  } else if (draft.type === 'delete') {
    await request('delete', { target: target.value, cookies: draft.cookies });
    modal.value = null; await loadState(); await read();
  } else if (draft.type === 'deleteFavorite') {
    await request('deleteFavorite', { id: draft.id }); modal.value = null; await loadState(); notice.value = '收藏已删除。';
  } else if (draft.type === 'revoke') {
    if (!await chrome.permissions.remove({ origins: [draft.origin] })) throw new Error('权限移除未完成。');
    modal.value = null; await loadState(); await read(); notice.value = '已移除网站授权。';
  }
}

function confirmDelete(items, clear = false) {
  openModal({ type: 'delete', title: clear ? '清理当前网站 Cookie' : '删除选中的 Cookie', cookies: clone(items) });
}

function openImport() { textInput.value = ''; imported.value = null; openModal({ type: 'import', title: '导入 Cookie' }); }
function parseText() { imported.value = parseImport(textInput.value); }
async function readFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) throw new Error('导入文件不得超过 1 MB。');
  textInput.value = await file.text(); parseText();
}
function importFavorite() {
  openModal({ type: 'favorite', title: '保存导入收藏', ...clone(imported.value) });
}

async function refreshFavorite(item) {
  const result = await request('sourcePreview', { id: item.id, target: target.value });
  const changed = validateCookies(result.cookies).filter((cookie, index) => JSON.stringify(cookie) !== JSON.stringify(item.cookies[index])).length;
  openModal({ ...clone(item), type: 'favorite', title: '从来源更新收藏', cookies: result.cookies, summary: `共 ${result.cookies.length} 项，其中 ${changed} 项发生变化。确认后替换此收藏快照。` });
}

async function manage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`index.html?view=manage${target.value ? `&target=${target.value.tabId}` : ''}`) });
}
async function setRefresh(event) { await request('settings', { autoRefresh: event.target.checked }); await loadState(); }
function storageChanged(changes, area) {
  if (area === 'session' && changes.lastOperation) state.lastOperation = changes.lastOperation.newValue || null;
}

onMounted(() => run(async () => {
  await loadState();
  chrome.storage.onChanged.addListener(storageChanged);
  await bindTarget();
}));
onUnmounted(() => { if (available) chrome.storage.onChanged.removeListener(storageChanged); });
</script>

<template>
  <main class="shell" :aria-busy="busy">
    <header class="app-header">
      <div class="brand">
        <img class="brand-mark" src="../assets/logo/cookie-bridge.svg" alt="" width="42" height="42" />
        <div>
          <h1>Cookie Bridge</h1>
          <p>选取 · 收藏 · 随处应用</p>
        </div>
      </div>
      <button
        v-if="!manager"
        type="button"
        class="icon-button"
        :disabled="busy || !available"
        @click="run(manage)"
      >
        管理页 ↗
      </button>
      <span v-else class="local-badge">仅本机保存</span>
    </header>
    <section
      class="target-card"
      :class="{ 'target-card--compact': !manager && target && authorized }"
      aria-label="当前操作目标"
    >
      <template v-if="!manager && target && authorized">
        <div class="target-compact-line">
          <span class="status-dot ready" role="img" aria-label="网站已授权"></span>
          <strong :title="origin">{{ origin }}</strong>
          <button type="button" class="quiet" :disabled="busy" @click="run(bindTarget)">重新绑定</button>
        </div>
        <details class="target-details">
          <summary>详情</summary>
          <p>{{ origin }}{{ targetPath }}</p>
          <p class="scope-note">Cookie 按域与路径共享，不按标签页或端口隔离。</p>
        </details>
      </template>
      <template v-else>
        <div class="eyebrow">
          {{ manager ? '已绑定目标网站' : '当前目标网站' }}
          <span class="status-dot" :class="{ ready: authorized }"></span>
        </div>
        <div class="target-line">
          <strong>{{ origin }}</strong>
          <button v-if="target" type="button" class="quiet" :disabled="busy" @click="run(bindTarget)">重新绑定</button>
        </div>
        <p>{{ targetPath }}</p>
        <p class="scope-note">Cookie 按域与路径共享，不按标签页或端口隔离。</p>
        <button v-if="target && !authorized" type="button" class="primary" :disabled="busy" @click="grant">授权当前网站</button>
      </template>
    </section>
    <div v-if="error" class="notice error" role="alert">{{ error }}</div>
    <div v-if="notice" class="notice" role="status">{{ notice }}</div>
    <div v-if="busy" class="working" role="status">正在处理，请稍候…</div>
    <section v-if="state.clipboard" class="clipboard-card" aria-label="临时复制">
      <div>
        <strong>已复制 {{ state.clipboard.cookies.length }} 项</strong>
        <p>来自 {{ state.clipboard.source.origin }}</p>
      </div>
      <div class="actions">
        <button
          type="button"
          class="primary"
          :disabled="busy || !authorized"
          @click="run(() => apply(state.clipboard))"
        >
          应用已复制项
        </button>
        <button type="button" :disabled="busy" @click="applyReview(state.clipboard)">选项</button>
        <button
          type="button"
          class="quiet"
          :disabled="busy"
          @click="run(async () => { await request('clearClipboard'); await loadState(); })"
        >
          清空
        </button>
      </div>
    </section>
    <nav class="tabs" aria-label="管理内容">
      <button
        v-for="tab in [{ id: 'cookies', text: '当前网站', count: cookies.length }, { id: 'favorites', text: '收藏', count: state.favorites.length }, { id: 'settings', text: '设置' }]"
        :key="tab.id"
        type="button"
        :aria-current="section === tab.id ? 'page' : undefined"
        :class="{ active: section === tab.id }"
        @click="section = tab.id"
      >
        {{ tab.text }}
        <span v-if="tab.count !== undefined">{{ tab.count }}</span>
      </button>
    </nav>
    <template v-if="section !== 'settings'">
      <div class="search-row">
        <label class="search">
          <span class="sr-only">{{ section === 'cookies' ? '搜索 Cookie 名称、域或路径' : '搜索收藏名称或来源' }}</span>
          <input
            v-model="search"
            type="search"
            :placeholder="section === 'cookies' ? '搜索名称、域或路径…' : '搜索收藏名称或来源…'"
          />
        </label>
        <button type="button" :disabled="busy" @click="run(async () => { await loadState(); await read(); })">刷新</button>
        <button type="button" :disabled="busy" @click="openImport">导入</button>
      </div>
    </template>
    <section v-if="section === 'cookies'" class="content-panel cookie-panel" aria-label="当前网站 Cookie 列表">
      <div class="selection-bar">
        <label class="check">
          <input
            type="checkbox"
            :checked="allChecked"
            :disabled="busy || !filtered.length"
            @change="toggleAll"
          />
          全选可见项
        </label>
        <span>已选 {{ picked.length }} 项</span>
        <button type="button" class="quiet" :disabled="busy || !authorized" @click="newCookie">＋ 新增</button>
      </div>
      <div v-if="!filtered.length" class="empty">
        <span aria-hidden="true">◌</span>
        <h2>{{ !authorized ? '从一个网站开始' : '没有匹配的 Cookie' }}</h2>
        <p>{{ !authorized ? '授权当前网站后，选择你需要的 Cookie。' : '试试其他搜索词，或新增、导入 Cookie。' }}</p>
      </div>
      <ul v-else class="cookie-list">
        <li v-for="cookie in filtered" :key="identity(cookie)" class="cookie-row">
          <input
            v-model="selected"
            type="checkbox"
            :value="identity(cookie)"
            :aria-label="`选择 ${cookie.name}，${cookie.domain}${cookie.path}`"
            :disabled="busy"
          />
          <div class="cookie-main">
            <div class="cookie-title">
              <strong>{{ cookie.name }}</strong>
              <span v-if="cookie.httpOnly" class="tag">HttpOnly</span>
              <span v-if="cookie.secure" class="tag">Secure</span>
            </div>
            <code class="cookie-value">
              {{ revealed.has(identity(cookie)) ? cookie.value || '（空值）' : '••••••••••••••••' }}
            </code>
            <p class="cookie-meta">{{ cookie.domain }} · {{ cookie.path }} · {{ expiry(cookie) }}</p>
            <div class="row-actions">
              <button
                type="button"
                class="quiet"
                :aria-label="`${revealed.has(identity(cookie)) ? '隐藏' : '显示'} ${cookie.name} 的值`"
                @click="reveal(cookie)"
              >
                {{ revealed.has(identity(cookie)) ? '隐藏' : '显示' }}
              </button>
              <button type="button" class="quiet" :disabled="busy" @click="run(() => copyText(cookie.value))">复制值</button>
              <button type="button" class="quiet" :disabled="busy" @click="editCookie(cookie)">编辑</button>
              <button type="button" class="quiet danger" :disabled="busy" @click="confirmDelete([cookie])">删除</button>
            </div>
          </div>
        </li>
      </ul>
      <div class="batch-actions">
        <button type="button" class="primary" :disabled="busy || !picked.length" @click="run(copySelected)">复制选中项</button>
        <button type="button" :disabled="busy || !picked.length" @click="saveSelected">收藏选中项</button>
        <button
          type="button"
          :disabled="busy || !picked.length"
          @click="run(() => copyText(picked.map(c => `${c.name}=${c.value}`).join('; ')))"
        >
          复制文本
        </button>
        <button
          type="button"
          class="danger"
          :disabled="busy || !picked.length"
          @click="confirmDelete(picked)"
        >
          删除选中项
        </button>
      </div>
      <div class="list-footer">
        <span>显示当前主机可用域下的全部路径</span>
        <button
          type="button"
          class="quiet danger"
          :disabled="busy || !cookies.length"
          @click="confirmDelete(cookies, true)"
        >
          清理网站 Cookie
        </button>
      </div>
    </section>
    <section v-else-if="section === 'favorites'" class="content-panel" aria-label="收藏列表">
      <div v-if="!favorites.length" class="empty">
        <span aria-hidden="true">☆</span>
        <h2>把常用账号放在这里</h2>
        <p>在当前网站勾选 Cookie 并收藏，下次一键应用。</p>
      </div>
      <ul v-else class="favorites-list">
        <li v-for="item in favorites" :key="item.id" class="favorite-card">
          <div class="favorite-top">
            <div>
              <h2>{{ item.name }}</h2>
              <p>{{ item.source.origin || '外部导入 / 来源未知' }}{{ item.source.origin ? item.source.path : '' }}</p>
            </div>
            <span class="count">{{ item.cookies.length }} 项</span>
          </div>
          <p class="cookie-names">{{ item.cookies.map(c => c.name).join(' · ') }}</p>
          <p class="cookie-meta">更新于 {{ when(item.updatedAt) }}</p>
          <div class="actions">
            <button
              type="button"
              class="primary"
              :disabled="busy || !authorized"
              @click="run(() => apply(item))"
            >
              应用到当前站
            </button>
            <button type="button" :disabled="busy" @click="applyReview(item)">应用选项</button>
            <button type="button" :disabled="busy" @click="editFavorite(item)">编辑</button>
            <button
              type="button"
              :disabled="busy || !target || !authorized"
              @click="run(() => refreshFavorite(item))"
            >
              从来源更新
            </button>
            <button
              type="button"
              class="quiet danger"
              :disabled="busy"
              @click="openModal({ type: 'deleteFavorite', title: '删除收藏', id: item.id, name: item.name })"
            >
              删除
            </button>
          </div>
        </li>
      </ul>
    </section>
    <section v-else class="content-panel settings-panel" aria-label="插件设置">
      <h2>应用行为</h2>
      <label class="check setting">
        <input
          type="checkbox"
          :checked="state.settings.autoRefresh"
          :disabled="busy"
          @change="run(() => setRefresh($event))"
        />
        <span>
          应用成功后刷新目标页
          <small>仅在所有 Cookie 写入并回读成功后刷新。</small>
        </span>
      </label>
      <h2>已授权网站</h2>
      <p class="muted">授权按主机生效，不按端口隔离。移除授权不会删除收藏或网站 Cookie。</p>
      <ul class="permissions-list">
        <li v-for="permission in state.permissions" :key="permission">
          <code>{{ permission }}</code>
          <button
            type="button"
            :disabled="busy"
            @click="openModal({ type: 'revoke', title: '移除网站授权', origin: permission })"
          >
            移除
          </button>
        </li>
      </ul>
      <p v-if="!state.permissions.length" class="muted">尚未保存网站授权。</p>
      <h2>数据保存在本机</h2>
      <p class="muted">收藏持久保存；临时复制在浏览器重启或扩展重载后清除。没有云同步，也不是加密凭据保险库。</p>
    </section>
    <details v-if="state.lastOperation" class="operation" :open="state.lastOperation.status !== 'success'">
      <summary>
        {{ operationLabel }} · {{ state.lastOperation.rows?.filter(row => row.status === 'success').length || 0 }}/{{ state.lastOperation.rows?.length || 0 }}
      </summary>
      <p class="cookie-meta">{{ state.lastOperation.source.origin }} · {{ when(state.lastOperation.startedAt) }}</p>
      <p v-if="state.lastOperation.message">{{ state.lastOperation.message }}</p>
      <ul>
        <li v-for="row in state.lastOperation.rows" :key="`${row.name}:${row.path}`">
          <strong>{{ row.name }}</strong>
          <span>{{ row.path }} — {{ { success: '成功', failed: '失败', pending: '未执行 / 未确认' }[row.status] }}</span>
          <p v-if="row.message">{{ row.message }}</p>
        </li>
      </ul>
    </details>
    <footer class="app-footer">
      <span>Cookie Bridge</span>
      <span>本机存储 · 无云同步</span>
    </footer>
    <dialog
      ref="dialog"
      aria-labelledby="dialog-title"
      @cancel="busy ? $event.preventDefault() : closeModal()"
      @close="modal = null"
    >
      <form v-if="modal" @submit.prevent="run(submitModal)">
        <div class="dialog-header">
          <h2 id="dialog-title">{{ modal.title }}</h2>
          <button type="button" class="quiet" :disabled="busy" aria-label="关闭对话框" @click="closeModal">✕</button>
        </div>
        <div v-if="dialogError" class="notice error" role="alert">{{ dialogError }}</div>
        <fieldset :disabled="busy" class="dialog-content">
          <template v-if="modal.type === 'edit'">
            <p class="muted">目标：{{ origin }}。保存后不自动刷新。</p>
            <CookieEditor v-model:cookie="modal.cookie" domain />
          </template>
          <template v-else-if="modal.type === 'favorite'">
            <p v-if="modal.summary" class="notice">{{ modal.summary }}</p>
            <label>
              收藏名称
              <input v-model="modal.name" required maxlength="80" placeholder="例如：测试环境 · 管理员" />
            </label>
            <p class="muted">
              来源：{{ modal.source.origin || '外部导入 / 来源未知' }}{{ modal.source.origin ? modal.source.path : '' }}
            </p>
            <details v-for="(cookie, index) in modal.cookies" :key="cookie.editorId" class="editor-item">
              <summary>{{ cookie.name }} · {{ cookie.path }}</summary>
              <CookieEditor v-model:cookie="modal.cookies[index]" domain />
              <button
                type="button"
                class="quiet danger"
                :disabled="modal.cookies.length === 1"
                @click="modal.cookies.splice(index, 1)"
              >
                移除此项
              </button>
            </details>
          </template>
          <template v-else-if="modal.type === 'apply'">
            <p class="muted">目标：{{ origin }} · 默认仅限当前主机</p>
            <p class="muted">保留值和安全属性；跨站路径默认 /。修改到期时间不会延长 token 本身的有效期。</p>
            <details v-for="(cookie, index) in modal.cookies" :key="cookie.editorId" class="editor-item">
              <summary>{{ cookie.name }} · {{ cookie.path }}</summary>
              <CookieEditor v-model:cookie="modal.cookies[index]" :domain="Boolean(modal.edit)" />
              <button
                type="button"
                class="quiet danger"
                :disabled="modal.cookies.length === 1"
                @click="modal.cookies.splice(index, 1)"
              >
                取消此项
              </button>
            </details>
            <div v-if="modal.conflicts?.length" class="conflicts">
              <h3>目标站的同名项</h3>
              <ul>
                <li v-for="item in modal.conflicts" :key="identity(item)">
                  {{ item.name }} · {{ item.domain }} · {{ item.path }}
                </li>
              </ul>
              <label class="check">
                <input v-model="modal.conflictMode" type="radio" value="keep" name="conflict" />
                保留冲突项并继续（页面可能读取旧值）
              </label>
              <label class="check">
                <input v-model="modal.conflictMode" type="radio" value="remove" name="conflict" />
                删除上列冲突项后写入
              </label>
              <p class="muted">选择删除会影响共享这些域和路径的页面，失败时不自动回滚。</p>
            </div>
          </template>
          <template v-else-if="modal.type === 'delete'">
            <p>将删除 {{ origin }} 下明确列出的 {{ modal.cookies.length }} 条 Cookie，可能使相关页面退出登录。</p>
            <ul class="delete-list">
              <li v-for="cookie in modal.cookies" :key="identity(cookie)">
                {{ cookie.name }} · {{ cookie.domain }} · {{ cookie.path }}
              </li>
            </ul>
            <p class="muted">包含父域 Cookie 时也可能影响其他子域。此操作不会删除收藏。</p>
          </template>
          <template v-else-if="modal.type === 'deleteFavorite'">
            <p>删除收藏“{{ modal.name }}”？网站 Cookie 不受影响。</p>
          </template>
          <template v-else-if="modal.type === 'revoke'">
            <p>移除 {{ modal.origin }} 的访问权限？</p>
          </template>
          <template v-else-if="modal.type === 'import'">
            <label>
              JSON 文件（最大 1 MB）
              <input
                type="file"
                accept=".json,application/json,text/plain"
                @change="run(() => readFile($event))"
              />
            </label>
            <label>
              Cookie 文本或 JSON
              <textarea
                v-model="textInput"
                rows="6"
                spellcheck="false"
                placeholder="demo_session=example; theme=dark"
                @input="imported = null"
              >
              </textarea>
            </label>
            <button type="button" @click="run(parseText)">解析并预览</button>
            <div v-if="imported" class="import-preview">
              <h3>已解析 {{ imported.cookies.length }} 项</h3>
              <p class="muted">来源：{{ imported.source.origin || '外部导入 / 来源未知' }} · 值已隐藏</p>
              <ul>
                <li v-for="cookie in imported.cookies" :key="identity(cookie)">
                  {{ cookie.name }} · {{ cookie.path }} · {{ expiry(cookie) }}
                </li>
              </ul>
              <div class="actions">
                <button
                  type="button"
                  class="primary"
                  :disabled="!authorized"
                  @click="run(() => apply(imported))"
                >
                  应用到当前站
                </button>
                <button type="button" @click="importFavorite">保存为收藏</button>
              </div>
            </div>
          </template>
        </fieldset>
        <div class="dialog-footer">
          <button type="button" :disabled="busy" @click="closeModal">{{ modal.type === 'import' ? '关闭' : '取消' }}</button>
          <button
            v-if="modal.type !== 'import'"
            type="submit"
            :disabled="busy || (modal.type === 'apply' && !authorized)"
            :class="['primary', { destructive: ['delete', 'deleteFavorite', 'revoke'].includes(modal.type) }]"
          >
            {{ busy ? '处理中…' : modal.type === 'apply' ? '确认应用' : ['delete', 'deleteFavorite', 'revoke'].includes(modal.type) ? '确认操作' : '保存' }}
          </button>
        </div>
      </form>
    </dialog>
  </main>
</template>
