#!/usr/bin/env node
/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/* ==========================================================================
 * UI 自动化自检（零依赖、无浏览器）：在 Node 里用极简 DOM 模拟环境加载 app.js，
 * 对真实 mock 服务走通「连接配置 → 登录（人工滑块）→ 勾选作业 → 运行 →
 * 缺资料暂停 → 继续 → 人工验证暂停 → 继续 → 结果汇总 → 隐私清除」全链路。
 *
 * 背景：本开发沙箱禁止浏览器启动（Edge 无法创建 crashpad/mojo 命名管道），
 * 因此用 DOM 模拟 + 真实 HTTP/SSE 验证 UI 交互逻辑；真实浏览器人工走查步骤见 README。
 *
 * 前置：启动 mock（建议快速模式）：
 *   MOCK_SPEED=0.2 node _mock/mock-api.mjs
 *
 * 运行：node _mock/dom-harness.mjs
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..');
const BASE = process.env.MOCK_URL || 'http://127.0.0.1:8877';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ======================== 极简 DOM 实现 ======================== */

let uid = 0;

function splitClasses(v) {
  return String(v || '').split(/\s+/).filter(Boolean);
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.id = '';
    this._class = '';
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = Object.create(null);
    this.dataset = {};
    this.style = {};
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.indeterminate = false;
    this._listeners = Object.create(null);
    this._uid = ++uid;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get childElementCount() { return this.childNodes.filter((n) => n.nodeType === 1).length; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; }
    return node;
  }
  get className() { return this._class; }
  set className(v) { this._class = String(v || ''); this.attributes.class = this._class; }
  get classList() {
    const node = this;
    return {
      contains: (c) => splitClasses(node._class).includes(c),
      add: (...cs) => { const s = new Set(splitClasses(node._class)); cs.forEach((c) => s.add(c)); node.className = Array.from(s).join(' '); },
      remove: (...cs) => { const s = new Set(splitClasses(node._class)); cs.forEach((c) => s.delete(c)); node.className = Array.from(s).join(' '); },
      toggle: (c, force) => {
        const has = splitClasses(node._class).includes(c);
        const on = force === undefined ? !has : !!force;
        if (on) node.classList.add(c); else node.classList.remove(c);
        return on;
      },
    };
  }
  get textContent() {
    if (this.nodeType === 3) return this._text || '';
    let out = '';
    for (const child of this.childNodes) out += child.textContent;
    return out;
  }
  set textContent(v) {
    if (this.nodeType === 3) { this._text = String(v == null ? '' : v); return; }
    this.childNodes = [];
    if (v !== '' && v != null) {
      const t = new FakeText(String(v));
      t.parentNode = this;
      this.childNodes.push(t);
    }
  }
  setAttribute(name, value) {
    const v = String(value);
    this.attributes[name] = v;
    if (name === 'id') this.id = v;
    else if (name === 'class') this.className = v;
    else if (name === 'style') this._parseStyle(v);
    else if (name.indexOf('data-') === 0) {
      const key = name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      this.dataset[key] = v;
    }
  }
  getAttribute(name) {
    if (name === 'class') return this._class || null;
    if (name === 'id') return this.id || null;
    if (name in this.attributes) return this.attributes[name];
    if (name === 'value') return this.value;
    if (name === 'checked') return this.checked ? '' : null;
    return null;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this._focused = true; }
  scrollIntoView() { /* no-op */ }
  addEventListener(type, fn) {
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, extra) {
    const ev = Object.assign({
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    }, extra || {});
    const list = (this._listeners[type] || []).slice();
    for (const fn of list) fn.call(this, ev);
    return ev;
  }
  click() {
    if (this.tagName === 'INPUT' && (this.attributes.type === 'checkbox')) {
      this.checked = !this.checked;
      this.dispatch('click');
      this.dispatch('input');
      this.dispatch('change');
      return;
    }
    this.dispatch('click');
  }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  _parseStyle(text) {
    String(text).split(';').forEach((part) => {
      const idx = part.indexOf(':');
      if (idx > 0) this.style[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    });
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super('text');
    this.nodeType = 3;
    this._text = String(text);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get firstChild() { return null; }
  get childElementCount() { return 0; }
}

function matchPart(node, part) {
  if (!node || node.nodeType !== 1) return false;
  const m = /^([a-zA-Z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)(?:\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\])?$/.exec(part);
  if (!m) throw new Error('不支持的选择器片段：' + part);
  const tag = m[1];
  const id = m[2];
  const classes = m[3];
  const attr = m[4];
  const attrValue = m[5] !== undefined ? m[5] : (m[6] !== undefined ? m[6] : m[7]);
  if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (id && node.id !== id) return false;
  if (classes) {
    const list = splitClasses(node._class);
    for (const c of classes.split('.').filter(Boolean)) if (!list.includes(c)) return false;
  }
  if (attr) {
    const v = node.getAttribute(attr);
    if (v === null) return false;
    if (attrValue !== undefined && v !== attrValue) return false;
  }
  return true;
}

function queryAll(root, selector) {
  const parts = String(selector).trim().split(/\s+/);
  let ctx = [root];
  for (const part of parts) {
    const next = [];
    for (const base of ctx) {
      (function walk(node) {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (matchPart(child, part) && !next.includes(child)) next.push(child);
          walk(child);
        }
      })(base);
    }
    ctx = next;
  }
  return ctx;
}

class FakeDocument {
  constructor() {
    this.readyState = 'complete';
    this.documentElement = new FakeNode('html');
    this.body = new FakeNode('body');
    this.documentElement.appendChild(this.body);
    this._listeners = Object.create(null);
  }
  createElement(tag) { return new FakeNode(tag); }
  createTextNode(text) { return new FakeText(String(text)); }
  getElementById(id) {
    let found = null;
    (function walk(node) {
      if (found) return;
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child.id === id) { found = child; return; }
        walk(child);
      }
    })(this.documentElement);
    return found;
  }
  querySelector(sel) { return queryAll(this.documentElement, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this.documentElement, sel); }
  addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); }
  removeEventListener(type, fn) {
    const list = this._listeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, ev) {
    (this._listeners[type] || []).forEach((fn) => fn(ev));
  }
}

/* ======================== Fake EventSource（真实 SSE） ======================== */

class FakeEventSource {
  constructor(url) {
    this.url = new URL(url, BASE).toString();
    this._listeners = Object.create(null);
    this.onmessage = null;
    this.onopen = null;
    this.onerror = null;
    this.closed = false;
    this._connect();
  }
  addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); }
  close() {
    this.closed = true;
    if (this._ctrl) { try { this._ctrl.abort(); } catch { /* ignore */ } }
  }
  _emit(type, data) {
    const handlers = type === 'message' ? [this.onmessage].filter(Boolean) : (this._listeners[type] || []).slice();
    const ev = { type, data: JSON.stringify(data) };
    handlers.forEach((fn) => {
      try { fn(ev); } catch (err) { harnessErrors.push('SSE 处理异常：' + (err && err.stack ? err.stack : err)); }
    });
  }
  async _connect() {
    this._ctrl = new AbortController();
    try {
      const res = await fetch(this.url, { headers: { Accept: 'text/event-stream' }, signal: this._ctrl.signal });
      if (!res.ok || !res.body) throw new Error('SSE HTTP ' + res.status);
      if (this.onopen) this.onopen({ type: 'open' });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = chunk.split('\n');
          let eventName = 'message';
          let dataText = '';
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataText += line.slice(5).trim();
          }
          if (!dataText) continue;
          let data;
          try { data = JSON.parse(dataText); } catch { continue; }
          this._emit(eventName, data);
        }
      }
    } catch (err) {
      if (this.closed || (err && err.name === 'AbortError')) return;
      if (this.onerror) this.onerror({ type: 'error', message: String(err) });
    }
  }
}

/* ======================== Harness 环境 ======================== */

const harnessErrors = [];

function makeSkeleton(doc) {
  const node = (tag, props, ...kids) => {
    const n = new FakeNode(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k === 'class') n.className = v;
        else if (k === 'id') n.id = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k === 'style') n.setAttribute('style', v);
        else n.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined) continue;
      n.appendChild(kid);
    }
    return n;
  };

  const topbar = node('header', { class: 'topbar' },
    node('span', { id: 'badge-env', class: 'status-badge' }, node('span', { text: '环境检测中…' })),
    node('span', { id: 'badge-ai', class: 'status-badge', text: 'AI 引擎' }),
    node('span', { id: 'badge-cx', class: 'status-badge', text: '学习通' }),
    node('span', { id: 'badge-conn', class: 'status-badge', text: '连接中…' }),
    node('button', { id: 'refresh-state', class: 'btn btn-sm', text: '刷新状态' }),
    node('button', { class: 'quick-link', dataset: { anchor: 'sec-connect' }, text: '连接' }),
    node('button', { class: 'quick-link', dataset: { anchor: 'sec-works' }, text: '作业' }),
    node('button', { class: 'quick-link', dataset: { anchor: 'sec-run' }, text: '运行' }),
    node('button', { class: 'quick-link', dataset: { anchor: 'sec-settings' }, text: '设置与隐私' })
  );
  const banner = node('div', { id: 'global-banner', hidden: '' });
  const main = node('main', { class: 'main' },
    node('section', { id: 'sec-connect', class: 'section' }, node('div', { id: 'connect-body', class: 'connect-grid' })),
    node('section', { id: 'sec-works', class: 'section' },
      node('div', { id: 'works-toolbar' }),
      node('div', { id: 'works-groups' })
    ),
    node('section', { id: 'sec-run', class: 'section' },
      node('button', { id: 'btn-refresh-works', text: '刷新作业列表' }),
      node('div', { class: 'run-layout' },
        node('div', { class: 'run-main' },
          node('div', { id: 'run-status' }),
          node('div', { id: 'run-paused' }),
          node('div', { id: 'run-jobs' })
        ),
        node('aside', { id: 'run-log' })
      )
    ),
    node('section', { id: 'sec-settings', class: 'section' }, node('div', { id: 'settings-body' }))
  );
  const toastRoot = node('div', { id: 'toast-root' });
  const modalRoot = node('div', { id: 'modal-root', hidden: '' });
  doc.body.appendChild(topbar);
  doc.body.appendChild(banner);
  doc.body.appendChild(main);
  doc.body.appendChild(toastRoot);
  doc.body.appendChild(modalRoot);
}

function installGlobals(doc) {
  const location = { origin: BASE, hash: '', href: BASE + '/' };
  const windowObj = {
    addEventListener(type, fn) { (this._l || (this._l = {}))[type] = (this._l[type] || []).concat([fn]); },
    location,
  };
  const fetchWrapper = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('/')) return fetch(BASE + url, opts);
    return fetch(url, opts);
  };
  return { window: windowObj, location, fetch: fetchWrapper };
}

/* ---------------- 页面辅助 ---------------- */

let doc = null;

function $(sel) { return doc.querySelector(sel); }
function $$(sel) { return doc.querySelectorAll(sel); }

function text(sel) {
  const n = typeof sel === 'string' ? $(sel) : sel;
  return n ? n.textContent : '';
}

function clickButton(scopeSel, label) {
  const scope = scopeSel ? $(scopeSel) : doc.documentElement;
  if (!scope) throw new Error('找不到点击范围：' + scopeSel);
  const btn = scope.querySelectorAll('button').find((b) => !b.disabled && b.textContent.replace(/\s+/g, ' ').includes(label));
  if (!btn) throw new Error('找不到按钮：' + (scopeSel || 'document') + ' / ' + label);
  btn.click();
}

function setInput(id, value) {
  const input = doc.getElementById(id);
  if (!input) throw new Error('找不到输入框：' + id);
  input.value = value;
  input.dispatch('input');
  input.dispatch('change');
}

async function waitFor(fn, label, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    let value;
    try { value = fn(); } catch (err) { throw new Error('等待「' + label + '」时异常：' + err.message); }
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('等待超时：' + label);
    await sleep(120);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
}

function statValue(label) {
  const card = $('.summary-card');
  if (!card) return null;
  const stat = card.querySelectorAll('.stat').find((s) => s.textContent.includes(label));
  if (!stat) return null;
  const b = stat.querySelector('b');
  return b ? b.textContent.trim() : null;
}

/* ---------------- 静态检查 ---------------- */

function staticChecks() {
  const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(UI_DIR, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8');
  const mock = fs.readFileSync(path.join(__dirname, 'mock-api.mjs'), 'utf8');

  assert(/<html lang="zh-CN"/.test(html), 'index.html 缺少 lang="zh-CN"');
  assert(/<meta charset="utf-8">/i.test(html), 'index.html 缺少 charset');
  assert(/href="\.\/style\.css"/.test(html), 'index.html 未通过相对路径引用 style.css');
  assert(/src="\.\/app\.js"/.test(html), 'index.html 未通过相对路径引用 app.js');
  assert(!/https?:\/\/(?!127\.0\.0\.1)/.test(html.replace(/data:image\/svg\+xml[^"]*/g, '')), 'index.html 含外部 URL（应无 CDN）');
  assert(!/@import|url\(\s*["']?https?:/i.test(css), 'style.css 引用外部资源');

  assert(!/\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/.test(js), 'app.js 使用 innerHTML / outerHTML / document.write（有 XSS 风险）');
  assert(!/\beval\s*\(/.test(js), 'app.js 使用 eval');
  assert(!/https?:\/\/cdn|unpkg|jsdelivr/i.test(js), 'app.js 引用 CDN');

  // 关键 DOM 锚点
  for (const id of ['sec-connect', 'connect-body', 'sec-works', 'works-toolbar', 'works-groups',
    'sec-run', 'run-status', 'run-paused', 'run-jobs', 'run-log', 'sec-settings', 'settings-body',
    'badge-env', 'badge-ai', 'badge-cx', 'badge-conn', 'global-banner', 'toast-root', 'modal-root',
    'refresh-state', 'btn-refresh-works']) {
    assert(html.includes('id="' + id + '"'), 'index.html 缺少锚点 #' + id);
  }

  // UI 使用的所有接口都应存在于 mock
  const uiApis = new Set();
  for (const m of js.matchAll(/'(\/api\/[^']+)'/g)) uiApis.add(m[1]);
  const requiredFromMock = [];
  for (const apiPath of uiApis) {
    if (apiPath.includes('${') || apiPath.includes('/api/jobs/')) continue;
    requiredFromMock.push(apiPath);
  }
  for (const apiPath of requiredFromMock) {
    assert(mock.includes("'" + apiPath + "'"), 'mock 缺少 UI 使用的接口：' + apiPath);
  }
  for (const endpoint of ['/api/privacy', '/api/privacy/clear', '/api/run/events',
    '/materials', '/api/open-folder', '/api/settings', '/api/run/pause', '/api/run/resume', '/api/run/stop']) {
    assert(mock.includes(endpoint), 'mock 缺少接口片段：' + endpoint);
  }
  assert(mock.includes('\\/api\\/jobs') || mock.includes('/api/jobs'), 'mock 缺少 /api/jobs 路由');
  assert(!js.includes('/api/setup/install'), 'UI 不应再依赖 /api/setup/install');
  assert(!js.includes('need-human-done'), 'UI 不应依赖 /api/login/human-done');

  // 密码 / Key 不回显：UI 只发送输入值，不读取已保存密钥
  assert(!/localStorage/.test(js) || !/apiKey/i.test(js.match(/localStorage[^;]*apiKey/i) || ''), '疑似把 API Key 存入 localStorage');
  console.log('[harness] 静态检查通过（无 CDN、无 innerHTML、接口对齐、锚点齐全）');
}

/* ======================== 主流程 ======================== */

async function resetMock() {
  const res = await fetch(BASE + '/api/mock/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error('mock 重置失败 HTTP ' + res.status);
}

async function main() {
  staticChecks();

  // 等待 mock 服务可用
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) break; } catch { /* retry */ }
    await sleep(300);
    if (i === 29) throw new Error('mock 服务不可用：' + BASE + '（请先运行 node _mock/mock-api.mjs）');
  }
  await resetMock();

  doc = new FakeDocument();
  makeSkeleton(doc);
  const env = installGlobals(doc);

  process.on('unhandledRejection', (err) => {
    harnessErrors.push('未处理的 Promise 异常：' + (err && err.stack ? err.stack : err));
  });

  const source = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  const factory = new Function('document', 'window', 'Node', 'EventSource', 'fetch', 'AbortController',
    'setTimeout', 'clearTimeout', 'location', 'console',
    source + '\n//# sourceURL=app.js');
  factory(doc, env.window, FakeNode, FakeEventSource, env.fetch, AbortController, setTimeout, clearTimeout, env.location, console);

  // 1. 页面初始化
  await waitFor(() => text('#connect-body').includes('DeepSeek API Key'), '连接区块渲染', 15000);
  await waitFor(() => /环境 ✓/.test(text('#badge-env')), '环境角标 ✓');
  assert(text('#global-banner').includes('DeepSeek API Key'), '未就绪提示应提示填写 API Key');
  assert(text('#badge-ai').includes('✗'), 'AI 角标初始应为 ✗');
  assert(text('#badge-cx').includes('✗'), '学习通角标初始应为 ✗');
  console.log('[harness] ① 连接区块初始化正常');

  // 2. 保存 API Key
  setInput('connect-api-key', 'sk-mock-1234567890');
  clickButton('#connect-body', '保存 API Key');
  await waitFor(() => /AI 引擎 ✓/.test(text('#badge-ai')), 'AI 引擎角标 ✓');
  assert(/API Key 已保存/.test(text('#connect-body')), '应显示 API Key 已保存');
  assert(!text('#connect-body').includes('sk-mock'), '界面不应回显 API Key 明文');
  console.log('[harness] ② API Key 保存正常（不回显）');

  // 3. 保存学习通账号并登录（人工滑块）
  setInput('connect-cx-username', 'demo-user');
  setInput('connect-cx-password', 'pass1234');
  clickButton('#connect-body', '保存账号密码');
  await waitFor(() => /账号密码已保存/.test(text('#connect-body')), '账号密码已保存');
  assert(!text('#connect-body').includes('pass1234'), '界面不应回显密码');
  clickButton('#connect-body', '登录学习通');
  await waitFor(() => /登录需要人工验证/.test(text('#connect-body')), '人工滑块提示卡片', 30000);
  clickButton('#connect-body', '我已完成验证，继续');
  await waitFor(() => /学习通 ✓ 已登录/.test(text('#badge-cx')), '登录成功角标', 30000);
  await waitFor(() => $$('.work-row').length >= 7, '作业列表加载', 60000);
  console.log('[harness] ③ 登录（含人工滑块）与作业列表加载正常');

  // 4. 勾选 3 项作业
  function checkWork(keyword) {
    const row = $$('.work-row').find((r) => {
      const name = r.querySelector('.work-name');
      return name && name.textContent.includes(keyword);
    });
    assert(row, '找不到作业：' + keyword);
    const cb = row.querySelector('input[type=checkbox]');
    assert(cb, '作业行缺少复选框：' + keyword);
    if (!cb.checked) cb.click();
  }
  checkWork('导数与微分');
  checkWork('实验报告：函数图像绘制');
  checkWork('专题二 思考题');
  await waitFor(() => /已选 3 项/.test(text('#works-toolbar')), '已选 3 项');
  assert(text('#works-toolbar').includes('已选'), '工具栏缺少已选计数');
  console.log('[harness] ④ 作业多选正常');

  // 5. 开始运行（确认弹窗）
  clickButton('#works-toolbar', '开始运行');
  await waitFor(() => !!$('#modal-root .modal'), '确认弹窗');
  assert(text('#modal-root .modal-body').includes('将自动处理'), '确认弹窗缺少作业清单说明');
  clickButton('#modal-root', '开始运行（3 项）');
  await waitFor(() => $$('#run-jobs .job-row').length === 3, '运行面板 3 项作业', 60000);
  await waitFor(() => !!$('#run-jobs .job-step.active'), '作业步骤推进');
  assert(/运行中|已暂停/.test(text('#run-status')), '运行状态条异常');
  console.log('[harness] ⑤ 启动运行正常');

  // 6. 两类暂停卡片
  await waitFor(() => $$('#run-paused .pause-card').length >= 2, '两类暂停卡片', 90000);
  const pausedText = text('#run-paused');
  assert(/缺少资料/.test(pausedText), '缺少「缺少资料」暂停卡片');
  assert(/需要人工验证/.test(pausedText), '缺少「需要人工验证」暂停卡片');
  assert(/data\\materials\\w1003/.test(pausedText), '缺资料路径提示应为 data\\materials\\<workId>，实际：' + pausedText.slice(0, 200));
  assert($$('#log-lines .log-line').length > 5, 'SSE 日志未滚动');
  console.log('[harness] ⑥ 暂停卡片（缺资料 / 人工验证）与 SSE 日志正常');

  // 7. 缺资料 → 继续
  const materialCard = $$('#run-paused .pause-card').find((c) => c.textContent.includes('缺少资料'));
  materialCard.querySelectorAll('button').find((b) => b.textContent.includes('已放入资料')).click();
  await waitFor(() => $$('#run-paused .pause-card').length === 1, '缺资料项继续');
  await waitFor(() => /w1003/.test(text('#run-jobs')) && /已完成/.test(text('#run-jobs')), 'w1003 完成后状态更新');
  console.log('[harness] ⑦ 缺资料项补充资料后继续并完成');

  // 8. 人工验证 → 继续
  const humanCard = $$('#run-paused .pause-card').find((c) => c.textContent.includes('需要人工验证'));
  humanCard.querySelectorAll('button').find((b) => b.textContent.includes('我已完成')).click();
  await waitFor(() => $$('#run-paused .pause-card').length === 0, '人工验证项继续', 60000);
  await waitFor(() => !!$('.summary-card'), '结果汇总', 90000);
  await waitFor(() => statValue('完成') === '3', '汇总完成 3 项');
  assert($$('#log-lines .log-line').length >= 15, 'SSE 日志条数过少');
  await waitFor(() => $$('.work-row').length === 4, '运行后作业列表刷新为 4 项', 60000);
  console.log('[harness] ⑧ 人工验证项继续、结果汇总、作业列表刷新正常');

  // 9. 设置与隐私
  await waitFor(() => /隐私说明/.test(text('#settings-body')), '设置区块渲染');
  assert(/不写注册表/.test(text('#settings-body')), '缺少「不写注册表」隐私说明');
  assert(/清除全部数据/.test(text('#settings-body')), '缺少清除本地数据入口');
  assert(/data\\|数据目录/.test(text('#settings-body')), '缺少数据目录展示');
  console.log('[harness] ⑨ 设置与隐私区块正常');

  // 10. 清除日志（隐私清除链路 + 二次确认）
  clickButton('#settings-body', '清除运行日志');
  await waitFor(() => !!$('#modal-root .modal'), '清除确认弹窗');
  assert(/不可恢复/.test(text('#modal-root .modal-body')), '清除弹窗缺少二次确认说明');
  clickButton('#modal-root', '确认清除');
  await waitFor(() => /已清除/.test(text('#toast-root')), '清除完成提示', 20000);
  console.log('[harness] ⑩ 隐私清除（二次确认）正常');

  // 11. 刷新状态
  clickButton('.topbar', '刷新状态');
  await waitFor(() => /状态已刷新/.test(text('#toast-root')), '刷新状态提示', 20000);
  console.log('[harness] ⑪ 顶部状态刷新正常');

  // 12. 错误检查
  if (harnessErrors.length) {
    console.error('[harness] 运行期异常：');
    harnessErrors.forEach((e) => console.error('  -', e));
    throw new Error('UI 运行期出现异常（' + harnessErrors.length + ' 条）');
  }
  console.log('[harness] 全流程通过 ✅（UI 逻辑 + mock 接口/SSE 联动）');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[harness] 失败：', err.message);
    if (harnessErrors.length) harnessErrors.forEach((e) => console.error('  -', e));
    process.exit(1);
  });
