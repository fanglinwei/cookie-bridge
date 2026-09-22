import type { Ref } from 'vue';
import { request } from '../extension.js';
import type { AppState } from '../types.js';

export function useSettings(settings: Ref<AppState['settings']>, permissions: Ref<string[]>) {
  async function save(autoRefresh: boolean) {
    await request('settings', { autoRefresh });
    settings.value = { autoRefresh };
  }

  async function revoke(origin: string) {
    if (!await chrome.permissions.remove({ origins: [origin] })) throw new Error('权限移除未完成。');
    permissions.value = (await chrome.permissions.getAll()).origins || [];
  }

  return { save, revoke };
}
