export class UserError extends Error {}
const fail = message => { throw new UserError(message); };
export const MAX_COOKIES = 200;
export const MAX_IMPORT_BYTES = 1024 * 1024;
const sameSites = ['unspecified', 'lax', 'strict', 'no_restriction'];

export function webURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('请选择有效的 HTTP/HTTPS 网站。'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('当前页面不支持 Cookie 操作，请切换到 HTTP/HTTPS 网站。');
  if (url.username || url.password) fail('不支持带有用户凭据的 URL。');
  return url;
}

export function sourceInfo(value) {
  if (!value?.origin) return { origin: '', path: '/', label: '外部导入 / 来源未知' };
  const url = webURL(value.origin);
  return { origin: url.origin, path: new URL(value.path || url.pathname, url.origin).pathname };
}

export function hostPattern(url) {
  const parsed = webURL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function identity(cookie) {
  return JSON.stringify([cookie.storeId || '', cookie.domain || '', cookie.path || '/', cookie.name]);
}

export function validateCookies(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_COOKIES) fail(`请选择 1～${MAX_COOKIES} 条 Cookie。`);
  const seen = new Set();
  return input.map((item, index) => {
    const invalid = message => fail(`第 ${index + 1} 项：${message}`);
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Cookie 格式无效。');
    if (typeof item.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(item.name)) invalid('名称为空或包含非法字符。');
    if (typeof item.value !== 'string' || /[\x00-\x20";,\\\x7f-\uffff]/.test(item.value)) invalid('值必须是有效 Cookie 文本，不能包含空白、分号或控制字符。');
    if (new TextEncoder().encode(item.name + item.value).length > 4096) invalid('名称和值合计超过 4096 字节。');
    if (item.partitionKey || item.partitioned) invalid('首版不支持分区 Cookie。');
    for (const key of ['secure', 'httpOnly', 'hostOnly', 'session']) if (item[key] !== undefined && typeof item[key] !== 'boolean') invalid(`${key} 必须为布尔值。`);
    if (item.domain !== undefined && (typeof item.domain !== 'string' || !/^[.a-z0-9:[\]-]*$/i.test(item.domain))) invalid('域格式无效。');
    if (item.storeId !== undefined && typeof item.storeId !== 'string') invalid('存储区格式无效。');
    const path = item.path ?? '/';
    if (typeof path !== 'string' || !path.startsWith('/') || /[;\x00-\x1f\x7f]/.test(path)) invalid('路径必须以 / 开头，不能包含分号或控制字符。');
    if (item.expirationDate !== undefined && (typeof item.expirationDate !== 'number' || !Number.isFinite(new Date(item.expirationDate * 1000).getTime()))) invalid('到期时间无效。');
    const sameSite = item.sameSite ?? 'unspecified';
    if (!sameSites.includes(sameSite)) invalid('SameSite 属性无效。');
    const session = item.session ?? item.expirationDate === undefined;
    if (!session && item.expirationDate === undefined) invalid('持久 Cookie 必须提供到期时间。');
    const cookie = { name: item.name, value: item.value, domain: item.domain || '', path, secure: item.secure ?? false, httpOnly: item.httpOnly ?? false, hostOnly: item.hostOnly ?? true, sameSite, session };
    if (!session) cookie.expirationDate = item.expirationDate;
    if (item.storeId !== undefined) cookie.storeId = item.storeId;
    const key = identity(cookie);
    if (seen.has(key)) invalid('存在重复的名称、域和路径。');
    seen.add(key);
    return cookie;
  });
}

export function parseImport(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) fail('导入内容不得超过 1 MB。');
  const trimmed = text.trim();
  if (!trimmed) fail('请输入 Cookie 文本或选择 JSON 文件。');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data;
    try { data = JSON.parse(trimmed); } catch { fail('JSON 格式错误，请检查括号和引号。'); }
    if (data?.version !== 1) fail('仅支持 version 为 1 的 Cookie Bridge JSON 格式。');
    return { name: typeof data.name === 'string' ? data.name.slice(0, 80) : '', source: sourceInfo(data.source), cookies: validateCookies(data.cookies) };
  }
  if (/[\r\n]/.test(trimmed)) fail('Cookie 文本不能包含换行；请粘贴单行 Cookie 请求头的值。');
  const cookies = trimmed.split(';').filter(part => part.trim()).map(part => {
    const pair = part.trim();
    const split = pair.indexOf('=');
    if (split < 1) fail('每个 Cookie 必须采用 name=value 格式。');
    return { name: pair.slice(0, split), value: pair.slice(split + 1) };
  });
  return { name: '', source: sourceInfo(), cookies: validateCookies(cookies) };
}

export function inScope(cookie, url) {
  const hostname = webURL(url).hostname;
  const domain = cookie.domain.replace(/^\./, '');
  return hostname === domain || (!cookie.hostOnly && hostname.endsWith(`.${domain}`));
}

export function pathMatches(cookiePath, requestPath) {
  return cookiePath === requestPath || (requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));
}

export function prepareCookies(input, target, { preservePath = false, preserveDomain = false } = {}) {
  const url = webURL(target.url);
  const mapped = validateCookies(input).map((cookie, index) => {
    const path = preservePath ? cookie.path : '/';
    const error = message => fail(`第 ${index + 1} 项：${message}`);
    if (cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now() / 1000) error('Cookie 已过期，请更新来源或在高级选项中调整。');
    if (cookie.secure && url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') error('Secure Cookie 需要 HTTPS 目标；请在高级选项中明确调整。');
    if (cookie.sameSite === 'no_restriction' && !cookie.secure) error('SameSite=None 必须同时启用 Secure。');
    if (cookie.name.startsWith('__Secure-') && !cookie.secure) error('__Secure- 前缀必须启用 Secure。');
    if (cookie.name.startsWith('__Host-') && (!cookie.secure || path !== '/' || (preserveDomain && !cookie.hostOnly))) error('__Host- 前缀需要 Secure、路径 / 和仅限当前主机。');
    if ((cookie.name.startsWith('__Http-') || cookie.name.startsWith('__Host-Http-')) && (!cookie.secure || !cookie.httpOnly)) error('此 Cookie 前缀需要 Secure 和 HttpOnly。');
    const result = { url: target.url, name: cookie.name, value: cookie.value, path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, storeId: target.storeId };
    if (cookie.expirationDate !== undefined) result.expirationDate = cookie.expirationDate;
    if (preserveDomain && cookie.domain) {
      if (!inScope(cookie, target.url)) error('域不属于当前目标网站。');
      if (!cookie.hostOnly) result.domain = cookie.domain;
      else if (cookie.domain !== url.hostname) error('仅限主机 Cookie 的域必须等于当前主机。');
    }
    return result;
  });
  const identities = mapped.map(cookie => identity({ ...cookie, domain: cookie.domain || url.hostname }));
  if (new Set(identities).size !== identities.length) fail('多个同名 Cookie 映射到同一路径，请取消重复项或分别修改路径。');
  return mapped;
}

export function conflicts(mapped, existing, url) {
  const target = webURL(url);
  return existing.filter(old => mapped.some(next => old.name === next.name &&
    (old.domain !== (next.domain || target.hostname) || old.path !== next.path) &&
    (pathMatches(old.path, target.pathname) || pathMatches(old.path, next.path))) && inScope(old, url));
}

export async function applyBatch(cookies, { checkTarget, write, verify, progress }) {
  await checkTarget();
  const result = cookies.map(cookie => ({ name: cookie.name, path: cookie.path, status: 'pending' }));
  for (let index = 0; index < cookies.length; index++) {
    try {
      await checkTarget();
      await write(cookies[index]);
      if (!await verify(cookies[index])) throw new UserError('写入后回读不一致；请刷新列表检查网站是否覆盖了该值。');
      result[index].status = 'success';
    } catch (error) {
      result[index].status = 'failed';
      result[index].message = error instanceof UserError ? error.message : '浏览器拒绝写入或权限已变化，请检查属性及授权后重试。';
      await progress(result);
      break;
    }
    await progress(result);
  }
  return result;
}
