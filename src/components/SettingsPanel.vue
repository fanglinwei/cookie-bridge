<script setup lang="ts">
import type { AppState } from '../types.js';

defineProps<{ settings: AppState['settings']; permissions: string[]; busy: boolean }>();
const emit = defineEmits<{ refresh: [enabled: boolean]; revoke: [origin: string] }>();
</script>

<template>
  <section class="content-panel settings-panel" aria-label="插件设置">
    <h2>应用行为</h2>
    <label class="check setting">
      <input
        type="checkbox"
        :checked="settings.autoRefresh"
        :disabled="busy"
        @click.prevent="emit('refresh', !settings.autoRefresh)"
      />
      <span>
        应用成功后刷新目标页
        <small>仅在所有 Cookie 写入并回读成功后刷新。</small>
      </span>
    </label>
    <h2>已授权网站</h2>
    <p class="muted">授权按主机生效，不按端口隔离。移除授权不会删除收藏或网站 Cookie。</p>
    <ul class="permissions-list">
      <li v-for="permission in permissions" :key="permission">
        <code>{{ permission }}</code>
        <button
          type="button"
          :disabled="busy"
          @click="emit('revoke', permission)"
        >
          移除
        </button>
      </li>
    </ul>
    <p v-if="!permissions.length" class="muted">尚未保存网站授权。</p>
    <h2>数据保存在本机</h2>
    <p class="muted">收藏持久保存；临时复制在浏览器重启或扩展重载后清除。没有云同步，也不是加密凭据保险库。</p>
  </section>
</template>
