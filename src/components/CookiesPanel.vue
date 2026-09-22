<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { identity } from '../../core.js';
import type { ApplyInput, Cookie, CookieIdentity } from '../types.js';

const props = defineProps<{ cookies: Cookie[]; search: string; busy: boolean; authorized: boolean; manager: boolean; resetKey: number }>();
const emit = defineEmits<{
  create: [];
  edit: [cookie: Cookie];
  copy: [cookies: Cookie[]];
  copyText: [text: string];
  save: [cookies: Cookie[]];
  delete: [cookies: Cookie[], clear: boolean];
  apply: [input: ApplyInput];
}>();
const selected = ref<string[]>([]);
const hidden = ref(new Set<string>());
const cookieFlags: { key: 'httpOnly' | 'secure'; label: string }[] = [{ key: 'httpOnly', label: 'HttpOnly' }, { key: 'secure', label: 'Secure' }];
const filtered = computed(() => props.cookies.filter(cookie => `${cookie.name} ${cookie.domain} ${cookie.path}`.toLowerCase().includes(props.search.toLowerCase())));
const picked = computed(() => props.cookies.filter(cookie => selected.value.includes(identity(cookie))));
const allChecked = computed(() => filtered.value.length > 0 && filtered.value.every(cookie => selected.value.includes(identity(cookie))));

watch(() => props.cookies, cookies => {
  selected.value = selected.value.filter(key => cookies.some(cookie => identity(cookie) === key));
});
watch(() => props.resetKey, () => { selected.value = []; hidden.value.clear(); });

function toggleAll() {
  const keys = new Set(selected.value);
  for (const cookie of filtered.value) allChecked.value ? keys.delete(identity(cookie)) : keys.add(identity(cookie));
  selected.value = [...keys];
}
function reveal(cookie: CookieIdentity) {
  const key = identity(cookie);
  if (hidden.value.has(key)) hidden.value.delete(key); else hidden.value.add(key);
}
</script>

<template>
  <section class="content-panel cookie-panel" aria-label="当前网站 Cookie 列表">
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
      <button type="button" class="quiet" :disabled="busy || !authorized" @click="emit('create')">＋ 新增</button>
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
            <button
              type="button"
              class="quiet cookie-value-copy"
              :aria-label="`复制 ${cookie.name} 的值`"
              title="点击复制完整值"
              :disabled="busy"
              @click="emit('copyText', cookie.value)"
            >{{ hidden.has(identity(cookie)) ? '••••••••••••••••' : cookie.value || '（空值）' }}</button>
            <button
              type="button"
              class="quiet cookie-visibility"
              :aria-label="`${hidden.has(identity(cookie)) ? '显示' : '隐藏'} ${cookie.name} 的值`"
              :title="hidden.has(identity(cookie)) ? '显示值' : '隐藏值'"
              :aria-pressed="hidden.has(identity(cookie))"
              @click="reveal(cookie)"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                <circle cx="12" cy="12" r="3" />
                <path v-if="hidden.has(identity(cookie))" d="m3 3 18 18" />
              </svg>
            </button>
          </div>
          <div class="cookie-controls">
            <div v-if="manager" class="cookie-flags" role="group" :aria-label="`${cookie.name} 的快捷属性`">
              <label
                v-for="flag in cookieFlags"
                :key="flag.key"
                class="check flag-checkbox"
              >
                <input
                  type="checkbox"
                  :aria-label="`${flag.label} · ${cookie.name} · ${cookie.domain}${cookie.path}`"
                  :checked="cookie[flag.key]"
                  :disabled="busy || !authorized"
                  @click.prevent="emit('apply', { cookies: [{ ...cookie, [flag.key]: !cookie[flag.key] }], original: { ...cookie }, edit: true })"
                />
                {{ flag.label }}
              </label>
            </div>
            <div class="row-actions">
              <span v-if="!manager && cookie.httpOnly" class="tag">HttpOnly</span>
              <span v-if="!manager && cookie.secure" class="tag">Secure</span>
              <button type="button" class="quiet" :disabled="busy" @click="emit('edit', cookie)">编辑</button>
              <button type="button" class="quiet danger" :disabled="busy" @click="emit('delete', [cookie], false)">删除</button>
            </div>
          </div>
        </div>
      </li>
    </ul>
    <div class="batch-actions">
      <button type="button" class="primary" :disabled="busy || !picked.length" @click="emit('copy', picked)">复制选中项</button>
      <button type="button" :disabled="busy || !picked.length" @click="emit('save', picked)">收藏选中项</button>
      <button
        type="button"
        :disabled="busy || !picked.length"
        @click="emit('copyText', picked.map(c => `${c.name}=${c.value}`).join('; '))"
      >
        复制文本
      </button>
      <button
        type="button"
        class="danger"
        :disabled="busy || !picked.length"
        @click="emit('delete', picked, false)"
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
        @click="emit('delete', cookies, true)"
      >
        清理网站 Cookie
      </button>
    </div>
  </section>
</template>
