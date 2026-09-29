<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, toRef, watch } from 'vue';
import { Toaster, toast } from 'vue-sonner';
import type { Cookie, Favorite, AppState, ApplyInput, Requests } from './types.js';
import { available, clone, request } from './extension.js';
import CookiesPanel from './components/CookiesPanel.vue';
import FavoritesPanel from './components/FavoritesPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import CookieDialog, { type DialogInput } from './components/CookieDialog.vue';
import { useFavorites } from './composables/useFavorites.js';
import { useSettings } from './composables/useSettings.js';
import { useTargetSite } from './composables/useTargetSite.js';
import { isOperation, prepareCookies, sourceInfo } from '../core.js';

const params = new URLSearchParams(location.search);
const manager = params.get('view') === 'manage';
document.documentElement.classList.toggle('manager', manager);
const { target, cookies, authorized, selectionResetKey, origin, targetPath, read, bindTarget, grantAccess, manage } = useTargetSite(manager, params.get('target'));
const search = ref('');
const section = ref('cookies');
const performing = ref(false);
const parsing = ref(false);
const busy = computed(() => performing.value || parsing.value);
const state = reactive<AppState>({ favorites: [], clipboard: null, settings: { autoRefresh: true }, permissions: [], lastOperation: null });
const favorites = useFavorites(toRef(state, 'favorites'));
const settings = useSettings(toRef(state, 'settings'), toRef(state, 'permissions'));
const modal = ref<DialogInput | null>(null);
const dialogError = ref('');
const feedback = (message: string, type: 'success' | 'warning' | 'error' = 'success') =>
  toast[type](message.replace(/。$/, ''), { id: 'feedback', duration: type === 'success' ? 3000 : 6000 });

const operationLabel = computed(() => state.lastOperation ? ({ success: '操作完成', partial: '部分完成，请检查结果', failed: '操作失败', running: '正在执行', interrupted: '操作中断，请核对' })[state.lastOperation.status] : '');
const when = (time: number) => new Date(time).toLocaleString();
const safeError = (issue: unknown) => issue instanceof Error && issue.message || '操作失败，请重试。';

async function run(action: () => unknown) {
  if (busy.value) return;
  performing.value = true;
  dialogError.value = '';
  try { await action(); }
  catch (issue) { feedback(safeError(issue), 'error'); }
  finally { performing.value = false; }
}

async function loadState() { Object.assign(state, await request('state')); }
function grant() {
  if (!target.value) return;
  run(async () => {
    await grantAccess();
    await loadState(); feedback('网站已授权。');
  });
}
function setParsing(active: boolean) {
  parsing.value = active;
}
function showDialogError(message: string) {
  dialogError.value = message;
}

function openModal(value: DialogInput) {
  modal.value = value;
  dialogError.value = '';
}
watch(section, () => { search.value = ''; });

function newCookie() {
  if (!target.value) return;
  openModal({ type: 'edit', title: '新增 Cookie', cookie: { name: '', value: '', domain: new URL(target.value.url).hostname, path: '/', session: true, secure: false, httpOnly: false, hostOnly: true, sameSite: 'unspecified' }, original: null });
}
function editCookie(cookie: Cookie) { openModal({ type: 'edit', title: '编辑 Cookie', cookie: clone(cookie), original: clone(cookie) }); }

function saveSelected(selected: Cookie[]) {
  if (!target.value) return;
  openModal({ type: 'favorite', title: '保存为收藏', name: '', source: sourceInfo({ origin: target.value.url }), cookies: clone(selected) });
}
function editFavorite(item: Favorite) { openModal({ ...clone(item), type: 'favorite', title: '编辑收藏' }); }

async function copySelected(selected: Cookie[]) {
  if (!target.value) return;
  await request('copy', { target: target.value, cookies: selected }); await loadState();
  feedback(`已复制 ${selected.length} 项，可切换到其他网站应用。`);
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); feedback('已复制到系统剪贴板。'); }
  catch { throw new Error('浏览器未允许写入剪贴板，请重试。'); }
}

function applyReview(item: ApplyInput | null) {
  if (!item) return;
  openModal({ type: 'apply', title: '应用 Cookie', cookies: clone(item.cookies).map(cookie => ({ ...cookie, path: '/' })), source: item.source, conflicts: [], conflictMode: '', original: null });
}

async function apply(item: ApplyInput | null, advanced = false) {
  if (!item) return;
  if (!target.value || !authorized.value) throw new Error('请先在目标网站打开插件并授权。');
  const draft: ApplyInput = advanced ? item : { cookies: clone(item.cookies).map(cookie => ({ ...cookie, path: '/' })), source: item.source, original: null };
  const selectedIds = draft.selectedIds;
  const cookies = selectedIds ? draft.cookies.filter(cookie => selectedIds.includes(cookie.editorId || '')) : draft.cookies;
  if (!cookies.length) throw new Error('请至少选择一项 Cookie。');
  try { prepareCookies(cookies, target.value, { preservePath: true, preserveDomain: Boolean(draft.original || draft.edit) }); }
  catch (issue) {
    openModal({ ...draft, type: 'apply', title: '检查 Cookie 属性', conflicts: [], conflictMode: '' });
    dialogError.value = safeError(issue); return;
  }
  const result = await request('apply', {
    target: target.value, cookies, original: draft.original,
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
  feedback(result.operation.status === 'success' ? `Cookie 已${draft.edit ? '保存' : '应用'}${result.operation.refreshed ? '，目标页面已刷新' : ''}。` : '操作未全部完成，请查看逐项结果。',
    result.operation.status === 'success' ? 'success' : result.operation.status === 'failed' ? 'error' : 'warning');
  await read();
}

async function saveFavorite(input: Requests['saveFavorite']) {
  await favorites.save(input);
  modal.value = null; feedback('收藏已保存。');
}
async function deleteFavorite(id: string) {
  await favorites.remove(id);
  modal.value = null; feedback('收藏已删除。');
}
async function deleteCookies(items: Cookie[]) {
  if (!target.value) return;
  await request('delete', { target: target.value, cookies: items });
  modal.value = null; await loadState(); await read();
}
async function revoke(origin: string) {
  await settings.revoke(origin);
  modal.value = null; await read(); feedback('已移除网站授权。');
}

function confirmDelete(items: Cookie[], clear = false) {
  openModal({ type: 'delete', title: clear ? '清理当前网站 Cookie' : '删除选中的 Cookie', cookies: clone(items) });
}

function openImport() { openModal({ type: 'import', title: '导入 Cookie' }); }

async function refreshFavorite(item: Favorite) {
  if (!target.value) return;
  const preview = await favorites.preview(item, target.value);
  openModal({ ...preview, type: 'favorite', title: '从来源更新收藏' });
}

function storageChanged(changes: { [key: string]: chrome.storage.StorageChange }, area: string) {
  if (area === 'session' && changes.lastOperation) state.lastOperation = isOperation(changes.lastOperation.newValue) ? changes.lastOperation.newValue : null;
}

onMounted(() => run(async () => {
  await loadState();
  chrome.storage.onChanged.addListener(storageChanged);
  await bindTarget();
}));
onUnmounted(() => {
  if (available) chrome.storage.onChanged.removeListener(storageChanged);
});
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
    <template v-if="!manager">
      <div v-if="busy" class="working" role="status">正在处理，请稍候…</div>
    </template>
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
        v-for="tab in [{ id: 'cookies', text: '当前网站', count: cookies.length }, { id: 'favorites', text: '收藏', count: state.favorites.length }, { id: 'settings', text: '设置', count: undefined }]"
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
    <CookiesPanel
      v-show="section === 'cookies'"
      :cookies="cookies"
      :search="search"
      :busy="busy"
      :authorized="authorized"
      :manager="manager"
      :reset-key="selectionResetKey"
      @create="newCookie"
      @edit="editCookie"
      @copy="items => run(() => copySelected(items))"
      @copy-text="text => run(() => copyText(text))"
      @save="saveSelected"
      @delete="confirmDelete"
      @apply="input => run(() => apply(input, true))"
    />
    <FavoritesPanel
      v-if="section === 'favorites'"
      :favorites="state.favorites"
      :search="search"
      :busy="busy"
      :authorized="authorized"
      :can-refresh="Boolean(target && authorized)"
      @apply="item => run(() => apply(item))"
      @review="applyReview"
      @edit="editFavorite"
      @refresh="item => run(() => refreshFavorite(item))"
      @delete="item => openModal({ type: 'deleteFavorite', title: '删除收藏', id: item.id, name: item.name })"
    />
    <SettingsPanel
      v-if="section === 'settings'"
      :settings="state.settings"
      :permissions="state.permissions"
      :busy="busy"
      @refresh="enabled => run(() => settings.save(enabled))"
      @revoke="origin => openModal({ type: 'revoke', title: '移除网站授权', origin })"
    />
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
    <CookieDialog
      :model-value="modal"
      :busy="busy"
      :manager="manager"
      :authorized="authorized"
      :origin="origin"
      :error="dialogError"
      @close="modal = null"
      @open="openModal"
      @save-favorite="input => run(() => saveFavorite(input))"
      @delete-favorite="id => run(() => deleteFavorite(id))"
      @delete-cookies="items => run(() => deleteCookies(items))"
      @revoke="origin => run(() => revoke(origin))"
      @apply="(item, advanced) => run(() => apply(item, advanced))"
      @parsing="setParsing"
      @error="showDialogError"
      @clear-error="dialogError = ''"
    >
      <template #feedback>
        <Toaster :position="manager ? 'top-center' : 'bottom-right'" container-aria-label="通知" rich-colors />
      </template>
    </CookieDialog>
  </main>
</template>
