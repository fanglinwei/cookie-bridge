<script setup>
const props = defineProps({ cookie: { type: Object, required: true }, domain: Boolean });
const emit = defineEmits(['update:cookie']);
const set = (key, value) => emit('update:cookie', { ...props.cookie, [key]: value });
const dateValue = () => props.cookie.expirationDate ? new Date(props.cookie.expirationDate * 1000).toISOString().slice(0, 16) : '';
</script>

<template>
  <div class="editor-grid">
    <label>
      名称
      <input
        :value="cookie.name"
        required
        autocomplete="off"
        spellcheck="false"
        @input="set('name', $event.target.value)"
      />
    </label>
    <label>
      值
      <textarea
        :value="cookie.value"
        rows="2"
        autocomplete="off"
        spellcheck="false"
        @input="set('value', $event.target.value)"
      >
      </textarea>
    </label>
    <label>
      路径
      <input :value="cookie.path" required placeholder="/" @input="set('path', $event.target.value)" />
    </label>
    <label v-if="domain">
      域
      <input :value="cookie.domain" @input="set('domain', $event.target.value)" />
    </label>
    <label>
      SameSite
      <select :value="cookie.sameSite" @change="set('sameSite', $event.target.value)">
        <option value="unspecified">未指定</option>
        <option value="lax">Lax</option>
        <option value="strict">Strict</option>
        <option value="no_restriction">None（需要 Secure）</option>
      </select>
    </label>
    <label class="check">
      <input type="checkbox" :checked="cookie.secure" @change="set('secure', $event.target.checked)" />
      Secure
    </label>
    <label class="check">
      <input type="checkbox" :checked="cookie.httpOnly" @change="set('httpOnly', $event.target.checked)" />
      HttpOnly
    </label>
    <label v-if="domain" class="check">
      <input type="checkbox" :checked="cookie.hostOnly" @change="set('hostOnly', $event.target.checked)" />
      仅限当前主机
    </label>
    <label class="check">
      <input type="checkbox" :checked="cookie.session" @change="set('session', $event.target.checked)" />
      会话 Cookie
    </label>
    <label v-if="!cookie.session">
      到期时间（UTC）
      <input
        type="datetime-local"
        :value="dateValue()"
        required
        @input="set('expirationDate', $event.target.value ? Date.parse($event.target.value + 'Z') / 1000 : undefined)"
      />
    </label>
  </div>
</template>
