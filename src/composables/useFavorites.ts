import type { Ref } from 'vue';
import { validateCookies } from '../../core.js';
import { request } from '../extension.js';
import type { Favorite, Requests, Target } from '../types.js';

export function useFavorites(favorites: Ref<Favorite[]>) {
  async function reload() { favorites.value = (await request('state')).favorites; }

  async function save(input: Requests['saveFavorite']) {
    await request('saveFavorite', input);
    await reload();
  }

  async function remove(id: string) {
    await request('deleteFavorite', { id });
    await reload();
  }

  async function preview(item: Favorite, target: Target) {
    const result = await request('sourcePreview', { id: item.id, target });
    const changed = validateCookies(result.cookies).filter((cookie, index) => JSON.stringify(cookie) !== JSON.stringify(item.cookies[index])).length;
    return { ...item, cookies: result.cookies, summary: `共 ${result.cookies.length} 项，其中 ${changed} 项发生变化。确认后替换此收藏快照。` };
  }

  return { save, remove, preview };
}
