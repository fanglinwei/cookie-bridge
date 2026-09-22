import { computed, ref } from 'vue';
import { hostPattern } from '../../core.js';
import { request } from '../extension.js';
import type { Cookie, Target } from '../types.js';

export function useTargetSite(manager: boolean, pinnedTabId: string | null) {
  const target = ref<Target | null>(null);
  const cookies = ref<Cookie[]>([]);
  const authorized = ref(false);
  const selectionResetKey = ref(0);
  const origin = computed(() => target.value ? new URL(target.value.url).origin : '尚未选择目标网站');
  const targetPath = computed(() => target.value ? new URL(target.value.url).pathname : '请在目标网站点击 Chrome 工具栏中的插件图标。');

  async function read() {
    if (!target.value) return;
    authorized.value = await chrome.permissions.contains({ origins: [hostPattern(target.value.url)] });
    if (!authorized.value) { cookies.value = []; return; }
    cookies.value = (await request('read', { target: target.value })).cookies;
  }

  async function bindTarget() {
    if (manager && !pinnedTabId) return;
    const result = await request('target', pinnedTabId ? { tabId: Number(pinnedTabId) } : {});
    target.value = result.target;
    selectionResetKey.value++;
    await read();
  }

  async function grantAccess() {
    if (!target.value) return;
    // Keep the permission request in the click gesture, before any awaited work.
    const permission = chrome.permissions.request({ origins: [hostPattern(target.value.url)] });
    if (!await permission) throw new Error('未获得网站授权；你的选择和收藏仍然保留。');
    await read();
  }

  async function manage() {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`index.html?view=manage${target.value ? `&target=${target.value.tabId}` : ''}`) });
  }

  return { target, cookies, authorized, selectionResetKey, origin, targetPath, read, bindTarget, grantAccess, manage };
}
