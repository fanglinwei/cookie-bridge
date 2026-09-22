<script lang="ts">
import type { Cookie, Source, ApplyInput, ImportedCookies, Requests } from '../types.js';

export type DialogDraft =
  | { type: 'edit'; title: string; cookie: Cookie; original: Cookie | null }
  | { type: 'favorite'; title: string; id?: string; name: string; source: Source; cookies: Cookie[]; summary?: string }
  | (ApplyInput & { type: 'apply'; title: string; selectedIds: string[] })
  | { type: 'delete'; title: string; cookies: Cookie[] }
  | { type: 'deleteFavorite'; title: string; id: string; name: string }
  | { type: 'revoke'; title: string; origin: string }
  | { type: 'import'; title: string };
export type DialogInput = Exclude<DialogDraft, { type: 'apply' }> | (ApplyInput & { type: 'apply'; title: string });
</script>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { identity, MAX_IMPORT_BYTES, parseImport } from '../../core.js';
import { clone } from '../extension.js';
import CookieEditor from './CookieEditor.vue';

const props = defineProps<{
  modelValue: DialogInput | null;
  busy: boolean;
  manager: boolean;
  authorized: boolean;
  origin: string;
  error: string;
}>();
const emit = defineEmits<{
  close: [];
  open: [draft: DialogInput];
  saveFavorite: [favorite: Requests['saveFavorite']];
  apply: [input: ApplyInput, advanced: boolean];
  deleteCookies: [cookies: Cookie[]];
  deleteFavorite: [id: string];
  revoke: [origin: string];
  parsing: [active: boolean];
  error: [message: string];
  clearError: [];
}>();
const dialog = ref<HTMLDialogElement | null>(null);
const modal = ref<DialogDraft | null>(null);
const parsing = ref(false);
const locked = computed(() => props.busy || parsing.value);
const textInput = ref('');
const imported = ref<ImportedCookies | null>(null);
const applySelection = computed(() => {
  const draft = modal.value;
  return draft?.type === 'apply' ? draft.cookies.filter(cookie => draft.selectedIds.includes(cookie.editorId || '')) : [];
});
const expiry = (cookie: Cookie) => cookie.session || cookie.expirationDate === undefined ? '会话' : new Date(cookie.expirationDate * 1000).toLocaleString();

watch(() => props.modelValue, async value => {
  if (!value) modal.value = null;
  else {
    const draft = clone(value);
    if (draft.type === 'apply') {
      const cookies = draft.cookies.map(cookie => ({ ...cookie, editorId: cookie.editorId || crypto.randomUUID() }));
      modal.value = { ...draft, cookies, selectedIds: draft.selectedIds || cookies.map(cookie => cookie.editorId) };
    } else if ('cookies' in draft) {
      modal.value = { ...draft, cookies: draft.cookies.map(cookie => ({ ...cookie, editorId: cookie.editorId || crypto.randomUUID() })) };
    } else modal.value = draft;
    if (draft.type === 'import') { textInput.value = ''; imported.value = null; }
  }
  await nextTick();
  if (!dialog.value) return;
  if (modal.value && !dialog.value.open) dialog.value.showModal();
  else if (!modal.value && dialog.value.open) dialog.value.close();
});

function closeModal() { if (!locked.value) emit('close'); }
function changeApplySelection(ids: string[]) {
  if (modal.value?.type !== 'apply') return;
  modal.value.selectedIds = ids;
  modal.value.conflicts = []; modal.value.conflictMode = '';
  emit('clearError');
}
function toggleApplySelection(event: Event) {
  if (modal.value?.type !== 'apply' || !(event.target instanceof HTMLInputElement)) return;
  changeApplySelection(event.target.checked ? modal.value.cookies.map(cookie => cookie.editorId || '') : []);
}
async function parseInput(action: () => void | Promise<void>) {
  if (locked.value) return;
  imported.value = null;
  parsing.value = true;
  emit('parsing', true);
  emit('clearError');
  try { await action(); }
  catch (issue) { emit('error', issue instanceof Error ? issue.message : '导入失败，请检查文件后重试。'); }
  finally { parsing.value = false; emit('parsing', false); }
}
function parseText() {
  return parseInput(() => { imported.value = parseImport(textInput.value); });
}
async function readFile(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  const file = event.target.files?.[0];
  if (!file) return;
  await parseInput(async () => {
    textInput.value = '';
    if (file.size > MAX_IMPORT_BYTES) throw new Error('导入文件不得超过 1 MB。');
    textInput.value = await file.text();
    imported.value = parseImport(textInput.value);
  });
}
function importFavorite() {
  if (imported.value) emit('open', { type: 'favorite', title: '保存导入收藏', ...clone(imported.value) });
}

function submit() {
  const draft = modal.value;
  if (!draft || locked.value) return;
  switch (draft.type) {
    case 'favorite': emit('saveFavorite', { id: draft.id, name: draft.name, source: draft.source, cookies: draft.cookies }); break;
    case 'edit': emit('apply', { cookies: [draft.cookie], original: draft.original, edit: true }, true); break;
    case 'apply':
      if (draft.conflicts?.length && !draft.conflictMode) {
        emit('error', '请选择冲突处理方式。');
        return;
      }
      emit('apply', draft, true); break;
    case 'delete': emit('deleteCookies', draft.cookies); break;
    case 'deleteFavorite': emit('deleteFavorite', draft.id); break;
    case 'revoke': emit('revoke', draft.origin); break;
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    aria-labelledby="dialog-title"
    @cancel="locked ? $event.preventDefault() : closeModal()"
    @close="emit('close')"
  >
    <form v-if="modal" @submit.prevent="submit">
      <div class="dialog-header">
        <h2 id="dialog-title">{{ modal.title }}</h2>
        <button type="button" class="quiet" :disabled="locked" aria-label="关闭对话框" @click="closeModal">✕</button>
      </div>
      <div v-if="error && !manager" class="notice error" role="alert">{{ error }}</div>
      <fieldset :disabled="locked" class="dialog-content">
        <template v-if="modal.type === 'edit'">
          <p class="muted">目标：{{ origin }}。保存后不自动刷新。</p>
          <CookieEditor v-model:cookie="modal.cookie" domain />
        </template>
        <template v-else-if="modal.type === 'favorite'">
          <p v-if="modal.summary" :class="manager ? 'muted' : 'notice'">{{ modal.summary }}</p>
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
          <label class="check apply-selection">
            <input
              type="checkbox"
              :checked="applySelection.length === modal.cookies.length"
              :indeterminate="applySelection.length > 0 && applySelection.length < modal.cookies.length"
              @change="toggleApplySelection"
            />
            全选 Cookie
            <span class="muted">已选 {{ applySelection.length }} / 共 {{ modal.cookies.length }} 项</span>
          </label>
          <details v-for="(cookie, index) in modal.cookies" :key="cookie.editorId" class="editor-item">
            <summary>
              <span class="apply-cookie-label">
                <input
                  v-model="modal.selectedIds"
                  type="checkbox"
                  :value="cookie.editorId"
                  :aria-label="`应用 ${cookie.name}，${cookie.path}`"
                  @click.stop
                  @change="changeApplySelection(modal.selectedIds)"
                />
                {{ cookie.name }} · {{ cookie.path }}
              </span>
            </summary>
            <CookieEditor v-if="modal.selectedIds.includes(cookie.editorId || '')" v-model:cookie="modal.cookies[index]" :domain="Boolean(modal.edit)" />
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
              @change="readFile"
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
          <button type="button" @click="parseText">解析并预览</button>
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
                @click="imported && emit('apply', imported, false)"
              >
                应用到当前站
              </button>
              <button type="button" @click="importFavorite">保存为收藏</button>
            </div>
          </div>
        </template>
      </fieldset>
      <div class="dialog-footer">
        <button type="button" :disabled="locked" @click="closeModal">{{ modal.type === 'import' ? '关闭' : '取消' }}</button>
        <button
          v-if="modal.type !== 'import'"
          type="submit"
          :disabled="locked || (modal.type === 'apply' && (!authorized || !applySelection.length))"
          :class="['primary', { destructive: ['delete', 'deleteFavorite', 'revoke'].includes(modal.type) }]"
        >
          {{ locked ? '处理中…' : modal.type === 'apply' ? '确认应用' : ['delete', 'deleteFavorite', 'revoke'].includes(modal.type) ? '确认操作' : '保存' }}
        </button>
      </div>
    </form>
  </dialog>
  <Teleport :to="modal && dialog ? dialog : 'body'">
    <slot name="feedback" />
  </Teleport>
</template>
