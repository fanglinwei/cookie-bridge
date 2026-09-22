<script setup lang="ts">
import { isSameSite } from '../../core.js';
import type { Cookie } from '../types.js';

const props = defineProps<{ cookie: Cookie; domain?: boolean }>();
const emit = defineEmits<{ 'update:cookie': [cookie: Cookie] }>();
const set = <K extends keyof Cookie>(key: K, value: Cookie[K]) => emit('update:cookie', { ...props.cookie, [key]: value });
const dateValue = () => props.cookie.expirationDate ? new Date(props.cookie.expirationDate * 1000).toISOString().slice(0, 16) : '';
function setText(key: 'name' | 'value' | 'domain' | 'path', event: Event) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) set(key, event.target.value);
}
function setFlag(key: 'secure' | 'httpOnly' | 'hostOnly' | 'session', event: Event) {
  if (event.target instanceof HTMLInputElement) set(key, event.target.checked);
}
function setSameSite(event: Event) {
  if (event.target instanceof HTMLSelectElement && isSameSite(event.target.value)) set('sameSite', event.target.value);
}
function setExpiration(event: Event) {
  if (event.target instanceof HTMLInputElement) set('expirationDate', event.target.value ? Date.parse(event.target.value + 'Z') / 1000 : undefined);
}
</script>

<template>
  <div class="editor-grid">
    <label class="editor-wide">
      名称
      <input
        :value="cookie.name"
        required
        autocomplete="off"
        spellcheck="false"
        @input="setText('name', $event)"
      />
    </label>
    <label class="editor-wide">
      值
      <textarea
        :value="cookie.value"
        rows="2"
        autocomplete="off"
        spellcheck="false"
        @input="setText('value', $event)"
      >
      </textarea>
    </label>
    <label v-if="domain">
      域
      <input :value="cookie.domain" @input="setText('domain', $event)" />
    </label>
    <label :class="{ 'editor-wide': !domain }">
      路径
      <input :value="cookie.path" required placeholder="/" @input="setText('path', $event)" />
    </label>
    <label class="editor-wide">
      SameSite
      <select :value="cookie.sameSite" @change="setSameSite($event)">
        <option value="unspecified">未指定</option>
        <option value="lax">Lax</option>
        <option value="strict">Strict</option>
        <option value="no_restriction">None（需要 Secure）</option>
      </select>
    </label>
    <fieldset class="editor-group editor-wide">
      <legend>安全与作用范围</legend>
      <div class="editor-options">
        <label class="check">
          <input type="checkbox" :checked="cookie.httpOnly" @change="setFlag('httpOnly', $event)" />
          HttpOnly
        </label>
        <label class="check">
          <input type="checkbox" :checked="cookie.secure" @change="setFlag('secure', $event)" />
          Secure
        </label>
        <label v-if="domain" class="check">
          <input type="checkbox" :checked="cookie.hostOnly" @change="setFlag('hostOnly', $event)" />
          仅限当前主机
        </label>
      </div>
    </fieldset>
    <fieldset class="editor-group editor-wide">
      <legend>有效期</legend>
      <label class="check">
        <input type="checkbox" :checked="cookie.session" @change="setFlag('session', $event)" />
        会话 Cookie
      </label>
      <label v-if="!cookie.session" class="expiration-field">
        到期时间（UTC）
        <input
          type="datetime-local"
          :value="dateValue()"
          required
          @input="setExpiration($event)"
        />
      </label>
    </fieldset>
  </div>
</template>
