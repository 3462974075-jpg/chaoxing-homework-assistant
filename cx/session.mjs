/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * session.mjs — 学习通登录态（Cookie）读写与 HTTP 访问
 *
 * 与现有 `可复用的程序\学习通自动作业\state\session.json` 完全兼容：
 *   { savedAt: ISO 字符串, cookies: [{ name, value, domain, path, expires, secure, httpOnly }] }
 *
 * 约定：
 *   - session 固定存 `<dataDir>\session.json`，dataDir 由 app 传入（如 <root>\data\chaoxing）
 *   - 只落盘 chaoxing.com 域下的 Cookie；不打印 Cookie 值
 *   - 缺文件时 status()/load() 返回 null / { loggedIn:false }，不抛错
 */
import fs from 'node:fs';
import path from 'node:path';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';

export const HOME_URL = 'https://i.chaoxing.com/';
export const BASE_URL = 'https://i.chaoxing.com/base';
export const LOGIN_URL = 'https://passport2.chaoxing.com/login?refer=https%3A%2F%2Fi.chaoxing.com';

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 只保留学习通相关 Cookie（与旧工具一致） */
export function cxCookies(cookies) {
  return (cookies || []).filter((c) => {
    const d = String(c.domain || '').replace(/^\./, '');
    return /chaoxing\.com$/i.test(d) || /chaoxing/i.test(d);
  });
}

/** 从 Cookie 数组里找登录标志（_uid + _d） */
export function hasLogin(cookies) {
  const list = Array.isArray(cookies) ? cookies : cookies?.cookies || [];
  const map = new Map(cxCookies(list).map((c) => [c.name, c.value]));
  return Boolean(map.get('_uid') && map.get('_d'));
}

export function uidOf(cookies) {
  const list = Array.isArray(cookies) ? cookies : cookies?.cookies || [];
  return new Map(cxCookies(list).map((c) => [c.name, c.value])).get('_uid') || null;
}

/** 组装 Cookie 请求头（过滤已过期 Cookie；expires<=0 视为会话级 Cookie） */
export function cookieHeader(session) {
  const list = session?.cookies || [];
  const now = Date.now() / 1000;
  return cxCookies(list)
    .filter((c) => !c.expires || c.expires < 0 || c.expires > now)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** 登录态最晚有效期（取 _uid/_d 中较早的正数 expires；无则 null） */
export function expiresAtOf(session) {
  const list = session?.cookies || [];
  const now = Date.now() / 1000;
  const exps = cxCookies(list)
    .filter((c) => (c.name === '_uid' || c.name === '_d') && c.expires > now)
    .map((c) => c.expires);
  if (!exps.length) return null;
  return new Date(Math.min(...exps) * 1000).toISOString();
}

/**
 * 带 Cookie 的 HTTP 请求，**手动跟随跳转**。
 * 原因：Node 的 fetch 在跨域重定向时会剥掉 Cookie 头（安全策略），
 * 而学习通经常在 mooc1-1 / mooc2-ans / passport2 之间跨域跳转，会因此"丢登录态"。
 * 这里每一跳都重新带上 Cookie。
 * @returns {Promise<{status:number,url:string,text:string,headers:Headers}>}
 */
export async function fetchWithSession(session, url, opts = {}) {
  const cookieFn = typeof opts.cookieHeader === 'function' ? opts.cookieHeader : () => cookieHeader(session);
  const maxHops = opts.maxHops || 10;
  const timeoutMs = opts.timeoutMs || 30000;
  let cur = url;
  let res = null;
  let text = '';
  let lastErr = null;
  for (let hop = 0; hop < maxHops; hop++) {
    const headers = {
      ...DEFAULT_HEADERS,
      Referer: hop === 0 ? opts.referer || HOME_URL : cur,
      ...(opts.headers || {}),
    };
    const ch = cookieFn(cur);
    if (ch) headers.Cookie = ch;
    try {
      res = await fetch(cur, {
        method: hop === 0 ? opts.method || 'GET' : 'GET',
        headers,
        body: hop === 0 ? opts.body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = e;
      break;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      cur = new URL(loc, cur).toString();
      continue;
    }
    text = await res.text();
    break;
  }
  if (!res) {
    const e = lastErr || new Error('无响应');
    throw new Error(`请求失败（${url}）：${e.name === 'TimeoutError' ? '超时' : e.message}`);
  }
  return { status: res.status, url: cur, text, headers: res.headers };
}

/**
 * 带 Cookie 下载二进制（附件用），同样手动跟随跳转，每跳重带 Cookie。
 * @returns {Promise<{buffer:Buffer, contentType:string, url:string, status:number}>}
 */
export async function downloadWithSession(session, url, opts = {}) {
  const maxHops = opts.maxHops || 10;
  const timeoutMs = opts.timeoutMs || 120000;
  let cur = url;
  let res = null;
  let lastErr = null;
  for (let hop = 0; hop < maxHops; hop++) {
    const headers = {
      ...DEFAULT_HEADERS,
      Accept: '*/*',
      Referer: hop === 0 ? opts.referer || HOME_URL : cur,
      ...(opts.headers || {}),
    };
    const ch = cookieHeader(session);
    if (ch) headers.Cookie = ch;
    try {
      res = await fetch(cur, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      break;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      cur = new URL(loc, cur).toString();
      continue;
    }
    break;
  }
  if (!res) {
    const e = lastErr || new Error('无响应');
    throw new Error(`下载失败（${url}）：${e.name === 'TimeoutError' ? '超时' : e.message}`);
  }
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: res.headers.get('content-type') || '', url: cur, status: res.status };
}

// ---------------------------------------------------------------- 最小 Cookie Jar
/**
 * 纯 HTTP 登录需要保存服务端 Set-Cookie 再回发（Node fetch 不自带 jar）。
 * 只实现本项目需要的子集：domain/path/hostOnly/expires/Secure。
 */
export class CookieJar {
  constructor(cookies = []) {
    this.cookies = [];
    for (const c of cookies) this.set(c);
  }

  set(c) {
    const name = String(c.name || '');
    if (!name) return;
    const entry = {
      name,
      value: c.value == null ? '' : String(c.value),
      domain: String(c.domain || '').replace(/^\./, '').toLowerCase(),
      path: c.path || '/',
      expires: Number(c.expires || 0),
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      hostOnly: c.hostOnly !== false,
    };
    const i = this.cookies.findIndex(
      (x) => x.name === entry.name && x.domain === entry.domain && x.path === entry.path && x.hostOnly === entry.hostOnly
    );
    if (i >= 0) this.cookies[i] = entry;
    else this.cookies.push(entry);
  }

  /** 解析 Set-Cookie 头（Node >= 20 提供 getSetCookie；同时兼容单条 raw 头） */
  setFromResponse(url, response) {
    const host = new URL(url).hostname.toLowerCase();
    let lines = [];
    try {
      lines = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    } catch {
      lines = [];
    }
    if (!lines.length) {
      const raw = response.headers.get('set-cookie');
      if (raw) lines = [raw];
    }
    let n = 0;
    for (const line of lines) {
      const parts = String(line).split(';');
      const pair = parts[0] || '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const c = { name, value, domain: host, path: '/', expires: 0, secure: false, httpOnly: false, hostOnly: true };
      for (const a of parts.slice(1)) {
        const iv = a.trim();
        const m = iv.match(/^([^=]+)=?(.*)$/);
        if (!m) continue;
        const k = m[1].trim().toLowerCase();
        const v = (m[2] || '').trim();
        if (k === 'domain' && v) {
          c.domain = v.replace(/^\./, '').toLowerCase();
          c.hostOnly = false;
        } else if (k === 'path' && v) c.path = v;
        else if (k === 'expires') {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) c.expires = t / 1000;
        } else if (k === 'max-age') {
          const sec = Number(v);
          if (Number.isFinite(sec)) c.expires = Date.now() / 1000 + sec;
        } else if (k === 'secure') c.secure = true;
        else if (k === 'httponly') c.httpOnly = true;
      }
      this.set(c);
      n++;
    }
    return n;
  }

  match(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return [];
    }
    const host = u.hostname.toLowerCase();
    const now = Date.now() / 1000;
    return this.cookies.filter((c) => {
      if (c.expires && c.expires > 0 && c.expires <= now) return false;
      const domainOk = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain);
      if (!domainOk) return false;
      if (c.secure && u.protocol !== 'https:') return false;
      return u.pathname.startsWith(c.path === '/' ? '/' : c.path);
    });
  }

  headerFor(url) {
    return this.match(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /** 转成 session.json 的 cookies 数组格式 */
  toSessionCookies() {
    return this.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires > 0 ? c.expires : -1,
      secure: c.secure,
      httpOnly: c.httpOnly,
    }));
  }

  toSession(savedAt = new Date().toISOString()) {
    return { savedAt, cookies: this.toSessionCookies() };
  }
}

// ---------------------------------------------------------------- SessionStore
export class SessionStore {
  constructor(dataDir) {
    if (!dataDir) throw new Error('createCx 缺少 dataDir 参数');
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'session.json');
  }

  /** 读取 session.json；缺文件/坏文件返回 null（required=true 时抛中文错误） */
  load({ required = false } = {}) {
    if (!fs.existsSync(this.file)) {
      if (required) throw new Error('还没有保存登录态（缺少 session.json），请先登录学习通');
      return null;
    }
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.cookies)) throw new Error('格式不正确');
      return data;
    } catch (e) {
      if (required) throw new Error(`登录态文件损坏（${this.file}）：${e.message}，请重新登录`);
      return null;
    }
  }

  /** 保存 Cookie 数组（CDP Storage.getCookies 或 jar.toSessionCookies 结果都可） */
  save(cookies) {
    const list = cxCookies(cookies).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: Number(c.expires || -1),
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
    }));
    const data = { savedAt: new Date().toISOString(), cookies: list };
    ensureDir(this.dataDir);
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
    return data;
  }

  saveJar(jar) {
    return this.save(jar.toSessionCookies());
  }

  clear() {
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    } catch (e) {
      throw new Error(`删除登录态文件失败：${e.message}`);
    }
  }

  cookieHeader(session = this.load()) {
    return cookieHeader(session);
  }

  hasLogin(session = this.load()) {
    return Boolean(session && hasLogin(session));
  }

  uid(session = this.load()) {
    return session ? uidOf(session) : null;
  }

  /** 只读状态：不联网，读本地文件即可（缺文件返回 loggedIn:false） */
  status() {
    const s = this.load();
    if (!s) return { loggedIn: false, uid: null, savedAt: null, expiresAt: null };
    return {
      loggedIn: hasLogin(s),
      uid: uidOf(s),
      savedAt: s.savedAt || null,
      expiresAt: expiresAtOf(s),
      cookieCount: s.cookies.length,
    };
  }

  /** 带登录态发 HTTP 请求（手动跟随跨域跳转，每跳重带 Cookie），返回 { status, url, text, headers } */
  async fetch(url, opts = {}) {
    const session = opts.session || this.load();
    if (!session) throw new Error('还没有保存登录态（缺少 session.json），请先登录学习通');
    return fetchWithSession(session, url, opts);
  }

  /** 带登录态下载二进制（附件用，手动跟随跳转） */
  async download(url, opts = {}) {
    const session = opts.session || this.load();
    if (!session) throw new Error('还没有保存登录态（缺少 session.json），请先登录学习通');
    return downloadWithSession(session, url, opts);
  }

  /**
   * 联网校验登录态是否仍有效（GET i.chaoxing.com/base，看是否被踢回登录页）。
   * 返回 { loggedIn, status, finalUrl, uid }
   */
  async verifyOnline({ timeoutMs = 20000 } = {}) {
    const session = this.load();
    if (!session || !hasLogin(session)) return { loggedIn: false, status: 0, finalUrl: '', uid: null };
    try {
      const r = await this.fetch(BASE_URL, { session, referer: HOME_URL, timeoutMs });
      const finalUrl = r.url || '';
      const kicked = /passport2\.chaoxing\.com|\/login/i.test(finalUrl);
      const bodyInvalid = /请先登录|请登录后|登录超时|用户未登录/i.test(r.text.slice(0, 3000));
      return {
        loggedIn: !kicked && !bodyInvalid,
        status: r.status,
        finalUrl,
        uid: uidOf(session),
      };
    } catch (e) {
      return { loggedIn: false, status: 0, finalUrl: '', uid: uidOf(session), error: e.message };
    }
  }
}

export default SessionStore;

// ---------------------------------------------------------------- SessionManager（异步外观）
/**
 * 统一的登录态管理（createCx 用）。两种存储后端：
 *   1) 传 sessionStore（如 app 的 DPAPI 加密实现）：
 *        { load(): Promise<object|null>, save(obj): Promise<void>, clear(): Promise<void> }
 *      —— 一律走它，**不在磁盘写明文 session.json**；
 *   2) 不传：保持文件行为，session 固定存 <dataDir>\session.json（与旧工具兼容，便于测试）。
 *
 * 读操作走内存缓存（init 时从后端加载一次），写操作内存 + 后端一起更新。
 */
export class SessionManager {
  constructor({ dataDir, store = null, log } = {}) {
    if (!dataDir) throw new Error('SessionManager 需要 dataDir');
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'session.json');
    this.store = store || null;
    this.log = log || (() => {});
    this.cache = null;
    this._loaded = false;
  }

  /** 初始化：从注入的 store 或 session.json 读取（缺省返回 null，不抛错） */
  async init() {
    if (this._loaded) return this.cache;
    if (this.store) {
      let data = null;
      try {
        data = await this.store.load();
      } catch (e) {
        throw new Error(`读取加密登录态失败：${e.message}`);
      }
      this.cache = data && Array.isArray(data.cookies) && data.cookies.length ? data : null;
    } else {
      this.cache = this._loadFile();
    }
    this._loaded = true;
    return this.cache;
  }

  _loadFile() {
    if (!fs.existsSync(this.file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || !Array.isArray(data.cookies)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async load({ required = false } = {}) {
    await this.init();
    if (!this.cache) {
      if (required) throw new Error('还没有保存登录态，请先登录学习通');
      return null;
    }
    return this.cache;
  }

  /** 当前内存中的登录态（不触发加载） */
  current() {
    return this.cache;
  }

  async save(cookies) {
    const list = cxCookies(cookies).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: Number(c.expires || -1),
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
    }));
    const data = { savedAt: new Date().toISOString(), cookies: list };
    await this._persist(data);
    return data;
  }

  async saveJar(jar) {
    return this.save(jar.toSessionCookies());
  }

  async _persist(data) {
    this.cache = data;
    this._loaded = true;
    if (this.store) {
      try {
        await this.store.save(data);
      } catch (e) {
        throw new Error(`保存加密登录态失败：${e.message}`);
      }
    } else {
      ensureDir(this.dataDir);
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
    }
  }

  async clear() {
    this.cache = null;
    this._loaded = true;
    if (this.store) {
      try {
        await this.store.clear();
      } catch (e) {
        throw new Error(`清除加密登录态失败：${e.message}`);
      }
    } else {
      try {
        if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      } catch (e) {
        throw new Error(`删除登录态文件失败：${e.message}`);
      }
    }
  }

  hasLogin() {
    return Boolean(this.cache && hasLogin(this.cache));
  }

  uid() {
    return this.cache ? uidOf(this.cache) : null;
  }

  cookieHeader() {
    return cookieHeader(this.cache);
  }

  async status() {
    const s = await this.load();
    if (!s) return { loggedIn: false, uid: null, savedAt: null, expiresAt: null, cookieCount: 0, encrypted: Boolean(this.store) };
    return {
      loggedIn: hasLogin(s),
      uid: uidOf(s),
      savedAt: s.savedAt || null,
      expiresAt: expiresAtOf(s),
      cookieCount: s.cookies.length,
      encrypted: Boolean(this.store),
    };
  }

  async fetch(url, opts = {}) {
    const session = opts.session || (await this.load({ required: true }));
    return fetchWithSession(session, url, opts);
  }

  async download(url, opts = {}) {
    const session = opts.session || (await this.load({ required: true }));
    return downloadWithSession(session, url, opts);
  }

  async verifyOnline({ timeoutMs = 20000 } = {}) {
    const session = await this.load();
    if (!session || !hasLogin(session)) return { loggedIn: false, status: 0, finalUrl: '', uid: null };
    try {
      const r = await this.fetch(BASE_URL, { session, referer: HOME_URL, timeoutMs });
      const finalUrl = r.url || '';
      const kicked = /passport2\.chaoxing\.com|\/login/i.test(finalUrl);
      const bodyInvalid = /请先登录|请登录后|登录超时|用户未登录/i.test(r.text.slice(0, 3000));
      return { loggedIn: !kicked && !bodyInvalid, status: r.status, finalUrl, uid: uidOf(session) };
    } catch (e) {
      return { loggedIn: false, status: 0, finalUrl: '', uid: uidOf(session), error: e.message };
    }
  }
}

