export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  sameSite: chrome.cookies.Cookie['sameSite'];
  session: boolean;
  expirationDate?: number;
  storeId?: string;
  editorId?: string;
}

export type CookieIdentity = Pick<Cookie, 'name'> & Partial<Pick<Cookie, 'domain' | 'path' | 'storeId'>>;
export type CookieWrite = chrome.cookies.SetDetails & { name: string; value: string; path: string };
export interface Target { tabId: number; url: string; storeId: string }
export interface Source { origin: string; path: string; label?: string }
export interface CookieSnapshot { cookies: Cookie[]; source: Source }
export interface ImportedCookies extends CookieSnapshot { name: string }
export interface Favorite extends ImportedCookies { id: string; createdAt: number; updatedAt: number }
export interface Clipboard extends CookieSnapshot { copiedAt: number }
export interface OperationRow { name: string; path: string; status: 'pending' | 'success' | 'failed'; message?: string }
export interface Operation {
  id: string;
  type: 'apply' | 'delete';
  source: Source;
  status: 'running' | 'interrupted' | 'success' | 'partial' | 'failed';
  startedAt: number;
  finishedAt?: number;
  rows: OperationRow[];
  message?: string;
  refreshed?: boolean;
}
export interface LocalData { favorites?: Favorite[]; settings?: { autoRefresh: boolean } }
export interface SessionData { clipboard?: Clipboard | null; lastOperation?: Operation | null }
export interface AppState {
  favorites: Favorite[];
  settings: { autoRefresh: boolean };
  clipboard: Clipboard | null;
  lastOperation: Operation | null;
  permissions: string[];
}
export interface ApplyInput {
  cookies: Cookie[];
  source?: Source;
  original?: Cookie | null;
  edit?: boolean;
  selectedIds?: string[];
  conflictMode?: '' | 'keep' | 'remove';
  conflicts?: CookieIdentity[];
}
export interface ApplyRequest {
  target: Target;
  cookies: Cookie[];
  original?: Cookie | null;
  edit?: boolean;
  refresh?: boolean;
  conflictMode?: '' | 'keep' | 'remove';
  conflictIds?: CookieIdentity[];
}
export type ApplyResult = { operation: Operation; conflicts?: never } | { conflicts: CookieIdentity[]; changed?: boolean; operation?: never };
export interface Requests {
  state: undefined;
  target: { tabId?: number };
  read: { target: Target };
  apply: ApplyRequest;
  delete: { target: Target; cookies: Cookie[] };
  copy: { target: Target; cookies: Cookie[] };
  clearClipboard: undefined;
  saveFavorite: { id?: string; name: string; source: Source; cookies: Cookie[] };
  deleteFavorite: { id: string };
  sourcePreview: { id: string; target: Target };
  settings: { autoRefresh: boolean };
}
export interface Responses {
  state: AppState;
  target: { target: Target };
  read: { cookies: Cookie[] };
  apply: ApplyResult;
  delete: { operation: Operation };
  copy: { clipboard: Clipboard };
  clearClipboard: Record<string, never>;
  saveFavorite: { favorite: Favorite };
  deleteFavorite: Record<string, never>;
  sourcePreview: { cookies: Cookie[] };
  settings: Record<string, never>;
}
export type Response<K extends keyof Requests> = { ok: true; data: Responses[K] } | { ok: false; error: string };
