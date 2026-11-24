/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
﻿/**
 * login.mjs — 学习通账号密码登录
 *
 * 策略（从快到稳）：
 *   1) 本地 session.json 仍有效 → 直接复用（可 force 强制重新登录）
 *   2) 纯 HTTP 登录：passport2.chaoxing.com/fanyalogin（密码/账号用页面同款 AES-CBC 加密）
 *      成功后把 Cookie 存成 session.json，并注入受控浏览器
 *   3) HTTP 失败（需要验证码/滑块/二次验证，或站点改版）→ 打开**可见** Edge，
 *      自动填账号密码并点登录；遇到滑块/短信时调用 onNeedHuman({reason, screenshotPath})，
 *      用户在外面的 Edge 窗口完成后继续轮询 _uid/_d；默认最多等 300 秒。
 *
 * 安全：密码只在内存中传递，不写入任何文件、不打印到日志。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { CookieJar, BASE_URL, HOME_URL, LOGIN_URL, UA, hasLogin } from './session.mjs';
import { sleep } from './browser.mjs';

/** 与学习通登录页 login.js 一致的 AES 加密：AES-128-CBC，key=iv="u2oh6Vu^HWe4_AES"，PKCS7，Base64 */
export const TRANSFER_KEY = 'u2oh6Vu^HWe4_AES';

export function encryptByAES(message, key = TRANSFER_KEY) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(key, 'utf8'));
  return Buffer.concat([c.update(Buffer.from(String(message), 'utf8')), c.final()]).toString('base64');
}

export class LoginError extends Error {
  constructor(message, code = 'LOGIN_FAILED') {
    super(message);
    this.name = 'LoginError';
    this.code = code;
  }
}

const BROWSER_UA_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 手动跟随跳转的 GET（逐跳收集 Set-Cookie，否则 SSO 中间跳转的 Cookie 会丢） */
async function jarGet(jar, url, { referer = HOME_URL, maxHops = 10, timeoutMs = 25000 } = {}) {
  let current = url;
  let res = null;
  let text = '';
  for (let hop = 0; hop < maxHops; hop++) {
    const headers = { ...BROWSER_UA_HEADERS, Referer: referer, Cookie: jar.headerFor(current) };
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new Error(`访问 ${current} 失败：${e.name === 'TimeoutError' ? '超时' : e.message}`);
    }
    jar.setFromResponse(current, res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).toString();
      referer = current;
      continue;
    }
    text = await res.text();
    break;
  }
  return { status: res ? res.status : 0, url: current, text };
}

function classifyFail(msg) {
  const m = String(msg || '');
  if (/密码|账号|用户不存在|用户名/.test(m)) return 'bad-credentials';
  if (/验证|滑块|安全/.test(m)) return 'need-human';
  if (/冻结|锁定|限制/.test(m)) return 'locked';
  if (/弱密码|修改密码/.test(m)) return 'weak-password';
  return 'http-failed';
}

/**
 * 纯 HTTP 登录（不会打开浏览器）。
 * @returns {Promise<{ok:boolean, code?:string, msg?:string, jar?:CookieJar, targetUrl?:string, twoFactorUrl?:string}>}
 */
export async function httpLogin({ username, password, log = () => {} } = {}) {
  if (!username || !password) return { ok: false, code: 'missing-credentials', msg: '缺少账号或密码' };
  const jar = new CookieJar();
  let page;
  try {
    page = await jarGet(jar, LOGIN_URL, { referer: HOME_URL });
  } catch (e) {
    return { ok: false, code: 'network', msg: `无法访问学习通登录页：${e.message}` };
  }
  if (!page.text || page.status !== 200) {
    return { ok: false, code: 'network', msg: `学习通登录页返回异常（HTTP ${page.status}）` };
  }
  const html = page.text;
  const pick = (id) => {
    const m = html.match(new RegExp(`id=["']${id}["'][^>]*value=["']([^"']*)["']`, 'i'));
    return m ? m[1] : '';
  };
  const fid = pick('fid') || '-1';
  const refer = pick('refer') || 'https%3A%2F%2Fi.chaoxing.com';
  const t = pick('t') || 'true';
  const forbid = pick('forbidotherlogin') || '0';
  const dfl = pick('doubleFactorLogin') || '0';
  const independentId = pick('independentId') || '0';
  const independentNameId = pick('independentNameId') || '0';

  const body = new URLSearchParams({
    fid,
    uname: t === 'true' ? encryptByAES(username) : username,
    password: t === 'true' ? encryptByAES(password) : password,
    refer,
    t,
    forbidotherlogin: forbid,
    validate: '',
    doubleFactorLogin: dfl,
    independentId,
    independentNameId,
  });

  const apiUrl = 'https://passport2.chaoxing.com/fanyalogin';
  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        ...BROWSER_UA_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://passport2.chaoxing.com',
        Referer: LOGIN_URL,
        Cookie: jar.headerFor(apiUrl),
      },
      body: body.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return { ok: false, code: 'network', msg: `提交登录请求失败：${e.name === 'TimeoutError' ? '超时' : e.message}` };
  }
  jar.setFromResponse(apiUrl, res);
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'http-failed', msg: `登录接口返回非 JSON（HTTP ${res.status}），可能站点已改版`, raw: raw.slice(0, 300) };
  }

  if (!data.status) {
    if (data.weakpwd) {
      return { ok: false, code: 'weak-password', msg: '学习通要求先修改弱密码：请用网页/App 登录后修改密码，再回来重试' };
    }
    const msg = data.msg2 || data.msg || '登录失败';
    return { ok: false, code: classifyFail(msg), msg };
  }

  if (data.containTwoFactorLogin) {
    return {
      ok: false,
      code: 'two-factor',
      msg: '学习通要求二次验证（短信/设备验证），需要在浏览器里完成',
      twoFactorUrl: data.twoFactorLoginPCUrl || '',
    };
  }

  let targetUrl = '';
  try {
    targetUrl = decodeURIComponent(data.url || '');
  } catch {
    targetUrl = data.url || '';
  }
  if (!targetUrl) targetUrl = BASE_URL;
  log('HTTP 登录接口返回成功，正在完成会话跳转…');
  try {
    await jarGet(jar, targetUrl, { referer: LOGIN_URL });
    if (!hasLogin(jar.toSessionCookies())) {
      await jarGet(jar, BASE_URL, { referer: targetUrl });
    }
    if (!hasLogin(jar.toSessionCookies())) {
      await jarGet(jar, HOME_URL, { referer: BASE_URL });
    }
  } catch (e) {
    return { ok: false, code: 'http-failed', msg: `登录成功但获取 Cookie 失败：${e.message}` };
  }
  const cookies = jar.toSessionCookies();
  if (!hasLogin(cookies)) {
    return { ok: false, code: 'http-failed', msg: '登录接口返回成功，但没有拿到 _uid/_d Cookie，转浏览器登录' };
  }
  return { ok: true, jar, targetUrl };
}

// ---------------------------------------------------------------- 浏览器登录
const FILL_LOGIN_JS = (username, password) => `(() => {
  const setVal = (el, v) => {
    if (!el) return false;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    try { el.focus(); } catch (e) {}
    try {
      if (desc && desc.set) desc.set.call(el, v);
      else el.value = v;
    } catch (e) { el.value = v; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const phone = document.querySelector('#phone, input[name="uname"], input[name="username"], input[placeholder*="手机号"], input[placeholder*="学号"], input[placeholder*="超星号"]');
  const pwd = document.querySelector('#pwd, input[name="pwd"], input[name="password"], input[type="password"]');
  const okPhone = setVal(phone, ${JSON.stringify(username)});
  const okPwd = setVal(pwd, ${JSON.stringify(password)});
  let clicked = 'none';
  const btn = document.querySelector('#loginBtn, #login, .btn-big, button[type="submit"]');
  if (btn) { btn.click(); clicked = 'btn'; }
  else {
    const cand = [...document.querySelectorAll('a,button,div,span')]
      .find((e) => /^(登\\s*录|立即登录|登录)$/.test((e.innerText || '').trim()));
    if (cand) { cand.click(); clicked = 'text'; }
  }
  return JSON.stringify({ okPhone, okPwd, clicked });
})()`;

const LOGIN_PAGE_ERROR_RE = /(密码错误|用户名或密码错误|账号或密码错误|账号不存在|用户不存在|密码不正确|账号已被冻结|已冻结|请输入验证码|验证码错误)/;
const NEED_HUMAN_RE = /(滑块|滑动验证|拖动滑块|安全验证|行为验证|图形验证码|短信验证|手机验证|二次验证|双因子|请完成验证|verify-mask|验证失败)/;

/** 从页面文本判断是否需要人工 */
function detectChallenge(text, pageHtml) {
  const hay = `${text || ''}\n${pageHtml || ''}`;
  if (!NEED_HUMAN_RE.test(hay)) return null;
  if (/滑块|滑动验证|拖动滑块|行为验证/.test(hay)) return '学习通要求完成滑块验证，请在打开的 Edge 窗口里拖动滑块完成验证';
  if (/短信|手机验证|二次验证|双因子/.test(hay)) return '学习通要求短信/二次验证，请在打开的 Edge 窗口里按提示完成验证';
  return '学习通出现安全验证，请在打开的 Edge 窗口里按提示完成';
}

/**
 * 打开可见 Edge 自动填表登录。
 * @returns {Promise<{ok:boolean, cookies:Array, url:string}>}
 */
export async function browserLogin({
  username,
  password,
  browser,
  onNeedHuman,
  timeoutMs = 300000,
  dataDir,
  log = () => {},
} = {}) {
  const page = await browser.ensureStarted({ headless: false });
  if (browser.headless) {
    log('警告：受控浏览器处于无头模式，登录遇到验证时无法人工处理');
  }
  let cookies = await browser.cookies();
  if (hasLogin(cookies)) {
    return { ok: true, cookies, url: await page.url() };
  }
  await page.navigate(LOGIN_URL, { settleMs: 1500 });
  await page.waitFor(`() => document.readyState === 'complete'`, { timeoutMs: 15000 }).catch(() => {});

  const fill = await page.evalJson(FILL_LOGIN_JS(username, password), { timeoutMs: 20000 });
  log('登录表单:', `账号框=${fill.okPhone ? '已填' : '未找到'}`, `密码框=${fill.okPwd ? '已填' : '未找到'}`, `登录按钮=${fill.clicked}`);
  if (!fill.okPhone || !fill.okPwd) {
    throw new LoginError(
      '没找到学习通登录表单（页面可能改版或被重定向），请在打开的 Edge 窗口里手动登录；或稍后重试',
      'form-not-found'
    );
  }

  const t0 = Date.now();
  let humanNotified = false;
  let lastNote = '';
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500);
    cookies = await browser.cookies();
    if (hasLogin(cookies)) {
      const url = await page.url();
      return { ok: true, cookies, url };
    }
    let text = '';
    let html = '';
    try {
      text = await page.bodyText(2500);
      html = await page.eval('(() => document.body ? document.body.innerHTML.slice(0, 6000) : "")()');
    } catch {
      /* 页面跳转中 */
    }
    const m = String(text).match(LOGIN_PAGE_ERROR_RE);
    if (m) {
      throw new LoginError(`学习通账号或密码错误：${m[1]}（请确认账号密码，连续输错可能冻结账号）`, 'bad-credentials');
    }
    const reason = detectChallenge(text, html);
    if (reason && !humanNotified) {
      humanNotified = true;
      let screenshotPath = '';
      try {
        screenshotPath = await page.screenshot(path.join(dataDir || process.cwd(), 'login-need-human.png'));
      } catch (e) {
        log('截图失败（不影响继续）:', e.message);
      }
      log('需要人工处理:', reason);
      if (typeof onNeedHuman === 'function') {
        try {
          await onNeedHuman({ reason, screenshotPath });
        } catch (e) {
          log('onNeedHuman 回调异常（继续等待）:', e.message);
        }
      } else {
        log('请在 Edge 窗口里完成验证，脚本会继续等待…');
      }
    }
    const note = `等待登录中… 已等待 ${Math.round((Date.now() - t0) / 1000)} 秒`;
    if (note !== lastNote && (Date.now() - t0) % 15000 < 1500) {
      log(humanNotified ? note + '（等待人工验证完成）' : note);
      lastNote = note;
    }
  }
  throw new LoginError(
    `等待登录超时（${Math.round(timeoutMs / 1000)} 秒）。请确认已完成滑块/短信验证，或网络是否正常`,
    'timeout'
  );
}

/** 把登录态 Cookie 注入受控浏览器并验证（data = { cookies:[...] }） */
export async function syncBrowserSession(browser, data, { log = () => {} } = {}) {
  const page = await browser.ensureStarted();
  const cookies = (data && data.cookies) || [];
  if (!cookies.length) throw new Error('登录态里没有 Cookie，无法注入浏览器');
  let existing = [];
  try {
    existing = await browser.cookies();
  } catch {
    existing = [];
  }
  if (!hasLogin(existing)) {
    const n = await page.setCookies(cookies);
    log(`已把 ${n} 个登录 Cookie 注入受控浏览器`);
    await page.navigate(BASE_URL, { settleMs: 1200 });
  }
  return page;
}

/**
 * 统一登录入口。
 * @param {object} p
 * @param {string} p.username
 * @param {string} p.password
 * @param {import('./session.mjs').SessionStore} p.session
 * @param {import('./browser.mjs').Browser} p.browser
 * @param {Function} [p.onNeedHuman] ({reason, screenshotPath}) => Promise
 * @param {number} [p.timeoutMs] 人工处理最长等待，默认 300000
 * @param {boolean} [p.force] 忽略本地已有登录态，强制重新登录
 */
export async function login({
  username,
  password,
  session,
  browser,
  onNeedHuman,
  timeoutMs = 300000,
  dataDir,
  log = () => {},
  force = false,
} = {}) {
  if (!session) throw new LoginError('login 缺少 session（SessionStore）', 'internal');
  if (!username || !password) {
    throw new LoginError('请输入学习通账号和密码', 'missing-credentials');
  }

  // 1) 本地登录态仍有效则复用
  if (!force) {
    const st = await session.status();
    if (st.loggedIn) {
      const v = await session.verifyOnline({ timeoutMs: 15000 });
      if (v.loggedIn) {
        log('已存在有效登录态，直接复用（uid=' + (st.uid || '') + '）');
        return { ok: true, uid: st.uid, reused: true, via: 'session' };
      }
      log('本地登录态已失效，重新登录…');
    }
  }

  // 2) 纯 HTTP 登录（快）
  const http = await httpLogin({ username, password, log });
  if (http.ok) {
    const data = await session.saveJar(http.jar);
    const uid = new Map(data.cookies.map((c) => [c.name, c.value])).get('_uid') || null;
    log('HTTP 登录成功，已保存登录态（' + data.cookies.length + ' 个 Cookie）');
    if (browser) {
      try {
        await syncBrowserSession(browser, data, { log });
      } catch (e) {
        log('把 Cookie 注入浏览器失败（可稍后重试）:', e.message);
      }
    }
    return { ok: true, uid, reused: false, via: 'http' };
  }
  if (http.code === 'bad-credentials' || http.code === 'locked' || http.code === 'weak-password') {
    // 账号/密码问题：快速失败，不再开浏览器傻等
    throw new LoginError(`学习通登录失败：${http.msg}`, http.code);
  }
  log(`HTTP 登录未完成（${http.code || 'unknown'}：${http.msg || ''}），改用浏览器登录`);

  // 3) 可见浏览器登录
  if (!browser) throw new LoginError('需要浏览器登录但未创建 Browser 实例', 'internal');
  let twoFactorUrl = http.twoFactorUrl || '';
  if (twoFactorUrl) {
    try {
      const page = await browser.ensureStarted({ headless: false });
      await page.navigate(twoFactorUrl, { settleMs: 1500 });
    } catch (e) {
      log('打开二次验证页失败:', e.message);
    }
  }
  const res = await browserLogin({ username, password, browser, onNeedHuman, timeoutMs, dataDir, log });
  const data = await session.save(res.cookies);
  const uid = new Map(data.cookies.map((c) => [c.name, c.value])).get('_uid') || null;
  log('浏览器登录成功，已保存登录态（' + data.cookies.length + ' 个 Cookie）');
  return { ok: true, uid, reused: false, via: 'browser' };
}

export default login;
