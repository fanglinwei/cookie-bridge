import type { Requests, Response } from './types.js';

export const available = Boolean(globalThis.chrome?.runtime?.id);

// Chrome messages and dialog drafts must be plain data, not Vue reactive proxies.
export const clone = <T,>(data: T): T => JSON.parse(JSON.stringify(data));

export async function request<K extends keyof Requests>(action: K, ...args: Requests[K] extends undefined ? [] : [data: Requests[K]]) {
  if (!available) throw new Error('请在 Chrome 中加载构建后的扩展，再从工具栏打开。');
  let response: Response<K> | undefined;
  try { response = await chrome.runtime.sendMessage({ action, ...clone(args[0] ?? {}) }); }
  catch { throw new Error('无法连接扩展后台，请重新打开插件或重新加载扩展。'); }
  if (!response?.ok) throw new Error(response?.error || '后台没有返回结果，请重新打开插件。');
  return response.data;
}
