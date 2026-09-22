<script setup lang="ts">
import { computed } from 'vue';
import type { Favorite } from '../types.js';

const props = defineProps<{ favorites: Favorite[]; search: string; busy: boolean; canRefresh: boolean; authorized: boolean }>();
const emit = defineEmits<{
  apply: [favorite: Favorite];
  review: [favorite: Favorite];
  edit: [favorite: Favorite];
  refresh: [favorite: Favorite];
  delete: [favorite: Favorite];
}>();
const filtered = computed(() => props.favorites.filter(item => `${item.name} ${item.source.origin}`.toLowerCase().includes(props.search.toLowerCase())));
const when = (time: number) => new Date(time).toLocaleString();
</script>

<template>
  <section class="content-panel" aria-label="收藏列表">
    <div v-if="!filtered.length" class="empty">
      <span aria-hidden="true">☆</span>
      <h2>把常用账号放在这里</h2>
      <p>在当前网站勾选 Cookie 并收藏，下次一键应用。</p>
    </div>
    <ul v-else class="favorites-list">
      <li v-for="item in filtered" :key="item.id" class="favorite-card">
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
            @click="emit('apply', item)"
          >
            应用到当前站
          </button>
          <button type="button" :disabled="busy" @click="emit('review', item)">应用选项</button>
          <button type="button" :disabled="busy" @click="emit('edit', item)">编辑</button>
          <button
            type="button"
            :disabled="busy || !canRefresh"
            @click="emit('refresh', item)"
          >
            从来源更新
          </button>
          <button
            type="button"
            class="quiet danger"
            :disabled="busy"
            @click="emit('delete', item)"
          >
            删除
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
