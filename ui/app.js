/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/* ==========================================================================
 * 学习通作业助手 · 本地 Web UI（免安装绿色版 / 单页四区块）
 * 纯原生 JavaScript：零依赖、零构建、无 CDN。
 *
 * 设计要点：
 *  - 单页纵向 4 区块：① 连接 ② 作业列表 ③ 运行 ④ 设置与隐私。
 *  - 所有动态内容一律 textContent / createTextNode 渲染，绝不拼 innerHTML（防 XSS）。
 *  - 所有失败路径都有可读中文提示（toast / 行内 callout）。
 *  - SSE（/api/run/events）断线自动重连 + 重连后重新拉取 /api/state 兜底。
 *  - 界面不回显密码 / API Key，只显示「已保存 / 未设置」。
 * ========================================================================== */
(function () {
  'use strict';

  /* ======================== 常量 ======================== */

  var STEP_ORDER = ['fetch', 'solve', 'fill', 'submit'];
  var STEP_LABEL = { fetch: '取题', solve: '求解', fill: '填写', submit: '提交' };
  var STEP_PROGRESS = { fetch: 20, solve: 55, fill: 80, submit: 95 };

  var KIND_LABEL = { quiz: '客观题', attach: '附件题', mixed: '混合题', unknown: '未知类型' };
  var KIND_CLASS = { quiz: 'chip-blue', attach: 'chip-purple', mixed: 'chip-cyan', unknown: 'chip-gray' };

  var STATUS_LABEL = {
    queued: '排队中', running: '进行中', done: '已完成', ready: '待提交', paused: '已暂停', failed: '失败', skipped: '已跳过', unknown: '未知'
  };
  var STATUS_CLASS = {
    queued: 'chip-gray', running: 'chip-blue', done: 'chip-green', ready: 'chip-orange', paused: 'chip-orange',
    failed: 'chip-red', skipped: 'chip-gray', unknown: 'chip-gray'
  };

  // 步骤名称（真实服务端 phases + 常见别名）→ 展示文案
  var STEP_DISPLAY = {
    fetch: '取题', open: '打开作业 / 取题', attachments: '下载附件', solve: 'AI 求解',
    short: '撰写简答', doc: '生成作业文件', fill: '填写答案', upload: '上传附件', save: '暂存答案',
    submit: '提交', paused: '暂停', done: '完成'
  };

  var DEFAULTS = { autoSubmit: true, targetAccuracy: 0.99, reviewBeforeSubmit: true, model: 'deepseek-chat', port: 8765, concurrency: 1, timeoutMin: 10 };

  var CLEAR_FALLBACK = [
    { scope: 'session', label: '登录 Cookie', desc: '清除后需要重新登录学习通。' },
    { scope: 'secrets', label: '账密与 API Key', desc: '清除后需要重新填写学习通账密和 DeepSeek API Key。' },
    { scope: 'logs', label: '运行日志', desc: '删除 logs 目录中的日志文件。' },
    { scope: 'all', label: '全部本地数据', desc: '删除配置、密钥、Cookie、日志与作业产物（不可恢复）。' }
  ];

  /* ======================== 全局状态 ======================== */

  var S = {
    state: null,
    stateAt: 0,
    stateError: '',
    booted: false,

    // 连接区
    loginBusy: false,
    human: null,

    // 作业区
    courses: [],
    works: [],
    worksLoaded: false,
    worksLoading: false,
    worksError: '',
    worksErrorStatus: 0,
    worksAt: 0,
    selected: new Set(),

    // 运行区
    run: {
      jobs: new Map(),
      paused: new Map(),
      summary: null,
      active: false,
      queuePaused: false,
      stopped: false,
      startedAt: 0,
      adopted: false
    },
    pauseNotes: {},
    logs: [],
    logAutoScroll: true,

    // 设置与隐私
    settings: null,
    settingsLoaded: false,
    settingsLoading: false,
    privacy: null,
    privacyError: '',
    privacyLoaded: false,

    // SSE
    sse: { es: null, connected: false, retry: 0, retryTimer: null, lastMsg: 0, watchTimer: null }
  };

  /* ======================== 基础工具 ======================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clearNode(node) { if (!node) return; while (node.firstChild) node.removeChild(node.firstChild); }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, num(n))); }

  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var val = props[key];
        if (val === null || val === undefined || val === false) return;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = String(val);
        else if (key === 'value') node.value = val;
        else if (key === 'checked') node.checked = !!val;
        else if (key === 'disabled') node.disabled = !!val;
        else if (key === 'hidden') node.hidden = !!val;
        else if (key === 'dataset') Object.assign(node.dataset, val);
        else if (key === 'aria') {
          Object.keys(val).forEach(function (a) { node.setAttribute('aria-' + a, String(val[a])); });
        } else if (key.indexOf('on') === 0 && typeof val === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else {
          node.setAttribute(key, String(val));
        }
      });
    }
    appendKids(node, Array.prototype.slice.call(arguments, 2));
    return node;
  }

  function appendKids(node, kids) {
    kids.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) { appendKids(node, child); return; }
      if (child instanceof Node) node.appendChild(child);
      else node.appendChild(document.createTextNode(String(child)));
    });
  }

  function fmtTime(ts) {
    var d = ts ? new Date(ts) : new Date();
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }
  function errMsg(err) { return err && err.message ? err.message : String(err || '未知错误'); }
  function chip(label, cls) { return el('span', { class: 'chip ' + (cls || 'chip-gray') }, label); }
  function kindChip(kind) { return chip(KIND_LABEL[kind] || kind || '未知类型', KIND_CLASS[kind] || 'chip-gray'); }
  function statusChip(status) { return chip(STATUS_LABEL[status] || status || '未知', STATUS_CLASS[status] || 'chip-gray'); }
  function leftClass(left) { return left && /分钟|小时/.test(left) ? 'left-urgent' : ''; }

  function toast(msg, type, ms) {
    type = type || 'info';
    var root = $('#toast-root');
    if (!root) return;
    var node = el('div', { class: 'toast ' + type, role: 'status' }, msg);
    root.appendChild(node);
    var life = ms || (type === 'error' ? 7000 : 3800);
    setTimeout(function () {
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      node.style.transition = 'opacity .2s, transform .2s';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 240);
    }, life);
  }

  function setBtnBusy(btn, on) {
    if (!btn) return;
    if (on) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
      if (btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
    }
  }

  function valOf(id) {
    var node = document.getElementById(id);
    return node && typeof node.value === 'string' ? node.value : '';
  }

  /* ======================== API 访问 ======================== */

  function ApiError(message, status, data) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status || 0;
    this.data = data;
  }
  ApiError.prototype = Object.create(Error.prototype);

  async function api(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var timeout = opts.timeout || 30000;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout);
    var init = { method: method, signal: controller.signal, headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    try {
      var res = await fetch(path, init);
      var ct = res.headers.get('content-type') || '';
      var data = null;
      if (ct.indexOf('application/json') >= 0) data = await res.json().catch(function () { return null; });
      else data = await res.text().catch(function () { return null; });
      if (!res.ok) {
        var msg = (data && (data.error || data.message)) || ('请求失败（HTTP ' + res.status + '）');
        throw new ApiError(String(msg), res.status, data);
      }
      if (data && typeof data === 'object' && data.ok === false) {
        throw new ApiError(String(data.error || '操作失败'), res.status, data);
      }
      return data;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err && err.name === 'AbortError') throw new ApiError('请求超时，本地服务可能未响应', 0);
      throw new ApiError('网络错误：无法连接本地服务（' + errMsg(err) + '）', 0);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ======================== 弹窗 ======================== */

  function openModal(opts) {
    opts = opts || {};
    var root = $('#modal-root');
    if (!root) return null;
    clearNode(root);

    var titleEl = el('div', { class: 'modal-title' }, opts.title || '');
    var bodyEl = el('div', { class: 'modal-body' });
    if (opts.body) appendKids(bodyEl, [opts.body]);
    var footEl = el('div', { class: 'modal-foot' });
    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      root.hidden = true;
      clearNode(root);
      root.onclick = null;
      document.removeEventListener('keydown', onKey);
      if (typeof opts.onClose === 'function') opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    var modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'modal-head' },
        titleEl,
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: close }, '关闭')
      ),
      bodyEl,
      opts.footer ? footEl : null
    );
    if (opts.footer) appendKids(footEl, [opts.footer]);
    root.appendChild(modal);
    root.hidden = false;
    root.onclick = function (e) { if (e.target === root) close(); };
    document.addEventListener('keydown', onKey);

    return {
      close: close,
      setTitle: function (t) { titleEl.textContent = t; },
      setBody: function (b) { clearNode(bodyEl); appendKids(bodyEl, [b]); }
    };
  }

  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done(val) {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(val);
      }
      var cancelBtn = el('button', { class: 'btn', type: 'button', onclick: function () { done(false); } }, opts.cancelText || '取消');
      var okBtn = el('button', {
        class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
        type: 'button',
        onclick: function () { done(true); }
      }, opts.okText || '确认');
      var modal = openModal({
        title: opts.title || '请确认',
        body: opts.body,
        footer: [cancelBtn, okBtn],
        onClose: function () { if (!settled) { settled = true; resolve(false); } }
      });
    });
  }

  /* ======================== 日志 ======================== */

  function addLog(level, msg, workId) {
    var entry = { ts: Date.now(), level: level || 'info', msg: String(msg == null ? '' : msg), workId: workId || null };
    S.logs.push(entry);
    if (S.logs.length > 3000) S.logs.splice(0, S.logs.length - 3000);
    appendLogLine(entry);
  }

  function logLineEl(entry) {
    return el('div', { class: 'log-line ' + (entry.level || 'info') },
      el('span', { class: 't' }, fmtTime(entry.ts)),
      entry.workId ? el('span', { class: 'who' }, '[' + entry.workId + ']') : null,
      el('span', { class: 'msg' }, entry.msg)
    );
  }

  function appendLogLine(entry) {
    var box = $('#log-lines');
    if (!box) return;
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.appendChild(logLineEl(entry));
    while (box.childElementCount > 1500) box.removeChild(box.firstChild);
    var countEl = $('#log-count');
    if (countEl) countEl.textContent = S.logs.length + ' 条';
    if (S.logAutoScroll && nearBottom) box.scrollTop = box.scrollHeight;
  }

  function clearLogs() {
    S.logs = [];
    var box = $('#log-lines');
    if (box) clearNode(box);
    var countEl = $('#log-count');
    if (countEl) countEl.textContent = '0 条';
    toast('界面日志已清空（磁盘日志不删除）', 'info');
  }

  function ensureLogPanel() {
    var host = $('#run-log');
    if (!host) return;
    if (host.childElementCount > 0) return;
    var auto = el('input', { type: 'checkbox', checked: S.logAutoScroll, id: 'log-autoscroll' });
    auto.addEventListener('change', function () { S.logAutoScroll = auto.checked; });
    var box = el('div', { class: 'log-lines', id: 'log-lines' });
    S.logs.slice(-1000).forEach(function (entry) { box.appendChild(logLineEl(entry)); });
    host.appendChild(el('div', { class: 'panel log-panel' },
      el('div', { class: 'log-head' },
        el('span', { class: 'log-title' }, '实时日志'),
        el('span', { class: 'small faint', id: 'log-count' }, S.logs.length + ' 条'),
        el('div', { class: 'spacer' }),
        el('label', { class: 'row', style: 'gap:5px;cursor:pointer' }, auto, el('span', { class: 'small muted' }, '自动滚动')),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: clearLogs }, '清空')
      ),
      box
    ));
  }

  /* ======================== SSE 事件连接 ======================== */

  function setConnBadge(connected, text) {
    var badge = $('#badge-conn');
    if (!badge) return;
    badge.className = 'status-badge ' + (connected ? 'ok' : 'off');
    badge.textContent = text || (connected ? '实时连接 ✓' : '连接断开，重连中…');
  }

  function connectSSE() {
    if (S.sse.retryTimer) { clearTimeout(S.sse.retryTimer); S.sse.retryTimer = null; }
    if (S.sse.es) {
      try { S.sse.es.close(); } catch (e) { /* ignore */ }
      S.sse.es = null;
    }
    var es;
    try {
      es = new EventSource('/api/run/events');
    } catch (e) {
      scheduleReconnect();
      return;
    }
    S.sse.es = es;

    function onMessage(ev) {
      S.sse.lastMsg = Date.now();
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (!data || typeof data !== 'object') return;
      if (!data.type && ev.type && ev.type !== 'message') data.type = ev.type;
      handleEvent(data);
    }

    es.onopen = function () {
      S.sse.connected = true;
      S.sse.retry = 0;
      S.sse.lastMsg = Date.now();
      setConnBadge(true);
      resyncAfterReconnect();
    };
    es.onmessage = onMessage;
    es.onerror = function () {
      if (S.sse.es !== es) return;
      try { es.close(); } catch (e) { /* ignore */ }
      S.sse.es = null;
      S.sse.connected = false;
      setConnBadge(false);
      scheduleReconnect();
    };

    ['job-start', 'step', 'job-done', 'job-paused', 'job-resumed', 'run-start', 'run-done',
      'run-paused', 'run-resumed', 'run-stopped', 'log', 'need-human', 'login-done',
      'privacy-cleared', 'install-progress', 'install-done'].forEach(function (name) {
      es.addEventListener(name, function (ev) {
        S.sse.lastMsg = Date.now();
        var data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (!data || typeof data !== 'object') data = {};
        if (!data.type) data.type = name;
        handleEvent(data);
      });
    });
  }

  function scheduleReconnect() {
    if (S.sse.retryTimer) return;
    S.sse.retry = Math.min(S.sse.retry + 1, 8);
    var delay = Math.min(30000, 800 * Math.pow(1.7, S.sse.retry));
    setConnBadge(false, '连接断开，' + Math.ceil(delay / 1000) + ' 秒后重连…');
    S.sse.retryTimer = setTimeout(function () {
      S.sse.retryTimer = null;
      connectSSE();
    }, delay);
  }

  async function resyncAfterReconnect() {
    try {
      await refreshState({ silent: true });
      if (S.worksLoaded && !S.worksLoading) loadWorks(true);
    } catch (e) { /* ignore */ }
  }

  function startHeartbeat() {
    if (S.sse.watchTimer) clearInterval(S.sse.watchTimer);
    S.sse.watchTimer = setInterval(function () {
      if (!S.sse.connected) return;
      if (Date.now() - S.sse.lastMsg > 300000) {
        try { if (S.sse.es) S.sse.es.close(); } catch (e) { /* ignore */ }
        S.sse.es = null;
        S.sse.connected = false;
        scheduleReconnect();
      }
    }, 20000);
  }

  /* ======================== SSE 事件分发 ======================== */

  function handleEvent(ev) {
    switch (String(ev.type || '')) {
      case 'log': onLogEvent(ev); break;
      case 'job-start': onJobStart(ev); break;
      case 'step': onJobStep(ev); break;
      case 'job-done': onJobDone(ev); break;
      case 'job-paused': onJobPaused(ev); break;
      case 'job-resumed': onJobResumed(ev); break;
      case 'run-start': onRunStart(ev); break;
      case 'run-paused': onRunPaused(ev, true); break;
      case 'run-resumed': onRunPaused(ev, false); break;
      case 'run-stopped': onRunStopped(ev); break;
      case 'run-done': onRunDone(ev); break;
      case 'need-human': onNeedHuman(ev); break;
      case 'login-done': onLoginDone(ev); break;
      case 'privacy-cleared': onPrivacyCleared(ev); break;
      default: break; // 未知事件静默忽略
    }
  }

  function onLogEvent(ev) {
    var msg = ev.message != null ? ev.message : (ev.msg != null ? ev.msg : ev.text);
    if (msg == null) return;
    addLog(ev.level || 'info', msg, ev.workId || null);
  }

  function lookupWork(id) {
    for (var i = 0; i < S.works.length; i++) if (S.works[i].workId === id) return S.works[i];
    return null;
  }

  function ensureJob(id, ev) {
    ev = ev || {};
    var job = S.run.jobs.get(id);
    if (!job) {
      job = { workId: id, name: '', courseName: '', status: 'queued', steps: {}, progress: 0, result: null };
      S.run.jobs.set(id, job);
    }
    var w = lookupWork(id);
    if (!job.name) job.name = ev.name || (w && w.name) || '';
    if (!job.courseName) job.courseName = ev.courseName || (w && w.courseName) || '';
    if (!job.steps) job.steps = {};
    return job;
  }

  function stepKeyOf(raw) {
    var s = String(raw == null ? '' : raw).toLowerCase();
    if (!s) return '';
    if (/fetch|open|取题|打开|进入|attachments|附件/.test(s)) return 'fetch';
    if (/solve|short|engine|求解|检索|推理|简答/.test(s)) return 'solve';
    if (/doc|fill|填写|作答|上传|生成|撰写/.test(s)) return 'fill';
    if (/submit|提交/.test(s)) return 'submit';
    if (STEP_LABEL[s]) return s;
    return '';
  }

  function onJobStart(ev) {
    if (!ev.workId) return;
    var job = ensureJob(ev.workId, ev);
    job.status = 'running';
    job.startedAt = ev.ts || Date.now();
    job.progress = num(ev.progress) || 0;
    job.step = stepKeyOf(ev.step) || 'fetch';
    S.run.active = true;
    S.run.stopped = false;
    addLog('step', '开始处理：' + (job.name || ev.workId), ev.workId);
    renderRun();
  }

  function onJobStep(ev) {
    if (!ev.workId) return;
    var job = ensureJob(ev.workId, ev);
    job.status = 'running';
    var key = stepKeyOf(ev.step != null ? ev.step : ev.name);
    var status = ev.status === 'done' ? 'done' : (ev.status === 'fail' ? 'fail' : 'running');
    if (key) {
      job.steps[key] = status;
      if (status === 'running') job.step = key;
      if (status === 'done' && STEP_PROGRESS[key]) job.progress = Math.max(num(job.progress), STEP_PROGRESS[key]);
    }
    if (ev.progress != null) job.progress = clamp(ev.progress, 0, 100);
    if (ev.message) job.lastMessage = String(ev.message);
    renderRun();
  }

  function onJobDone(ev) {
    if (!ev.workId) return;
    var job = ensureJob(ev.workId, ev);
    // 真实服务端失败时只带 error 字段（没有 ok:false），这里兜底判定
    var ok = ev.ok !== false && !ev.error;
    var result = ev.result || ev.data || job.result || null;
    var isReady = ev.status === 'ready' || Boolean(result && result.saved && !result.submitted);
    job.status = !ok ? 'failed' : (isReady ? 'ready' : 'done');
    job.progress = 100;
    job.result = result;
    if (ev.errorCode) job.errorCode = ev.errorCode;
    if (ev.errorHint) job.errorHint = ev.errorHint;
    if (ev.errorRaw) job.errorRaw = ev.errorRaw;
    job.endedAt = Date.now();
    S.run.paused.delete(ev.workId);
    var note = '';
    if (!ok && ev.error) note = '，' + String(ev.error).slice(0, 300);
    else if (isReady) note = '，已暂存待手动提交';
    else if (job.result && typeof job.result === 'object') {
      if (job.result.score != null) note = '，得分 ' + job.result.score;
      else if (job.result.message) note = '，' + job.result.message;
      else if (job.result.note) note = '，' + job.result.note;
    }
    addLog(!ok ? 'error' : (isReady ? 'warn' : 'ok'), '作业' + (!ok ? '失败' : (isReady ? '待提交' : '完成')) + '：' + (job.name || ev.workId) + note, ev.workId);
    renderRun();
  }

  function onJobPaused(ev) {
    if (!ev.workId) return;
    var job = ensureJob(ev.workId, ev);
    job.status = 'paused';
    var p = normalizePaused({
      workId: ev.workId,
      name: ev.name || job.name,
      courseName: ev.courseName || job.courseName,
      kind: ev.kind,
      reason: ev.reason || ev.message || ev.detail,
      detail: ev.detail,
      missingQuestions: ev.missingQuestions,
      reviewQuestions: ev.reviewQuestions,
      createdAt: ev.ts || Date.now()
    });
    S.run.paused.set(ev.workId, p);
    addLog('warn', '已暂停：' + (job.name || ev.workId) + '（' + p.reason + '）', ev.workId);
    renderRun();
  }

  function onJobResumed(ev) {
    if (!ev.workId) return;
    S.run.paused.delete(ev.workId);
    var job = S.run.jobs.get(ev.workId);
    if (job) job.status = 'running';
    addLog('step', '继续处理：' + ((job && job.name) || ev.workId), ev.workId);
    renderRun();
  }

  function onRunStart(ev) {
    S.run.active = true;
    S.run.stopped = false;
    S.run.summary = null;
    S.run.queuePaused = false;
    if (Array.isArray(ev.workIds)) ev.workIds.forEach(function (id) { ensureJob(id, {}); });
    addLog('step', '开始运行，共 ' + (num(ev.total) || (ev.workIds ? ev.workIds.length : '?') ) + ' 项作业');
    renderRun();
  }

  function onRunPaused(ev, paused) {
    S.run.queuePaused = !!paused;
    addLog(paused ? 'warn' : 'step', paused ? '队列已暂停' : '队列已继续');
    renderRun();
    toast(paused ? '队列已暂停' : '队列已继续', paused ? 'warn' : 'ok');
  }

  function onRunStopped() {
    S.run.active = false;
    S.run.queuePaused = false;
    S.run.stopped = true;
    addLog('warn', '运行已停止');
    renderRun();
  }

  function onRunDone(ev) {
    S.run.active = false;
    S.run.queuePaused = false;
    if (ev.summary) {
      // 继续暂停项时服务端可能只发单项 summary（无 results），保留上一轮的逐项结果列表
      var prevResults = S.run.summary && Array.isArray(S.run.summary.results) ? S.run.summary.results : null;
      S.run.summary = ev.summary;
      if (!Array.isArray(S.run.summary.results) && prevResults) S.run.summary.results = prevResults;
    } else if (ev.result) S.run.summary = ev.result;
    // 用 summary.results 校正逐项状态（真实服务端结果项用 outcome 字段）
    var results = S.run.summary && Array.isArray(S.run.summary.results) ? S.run.summary.results : null;
    if (results) {
      results.forEach(function (r) {
        if (!r || !r.workId) return;
        var job = S.run.jobs.get(String(r.workId));
        if (!job) return;
        var st = mapOutcome(r);
        if (st && st !== 'unknown') job.status = st;
        if (r.result && !job.result) job.result = r.result;
        if (r.error) job.error = String(r.error);
      });
    }
    if (ev.stopped) {
      S.run.stopped = true;
      addLog('warn', '运行结束（已停止）');
    } else {
      var sum = computeSummary();
      addLog('ok', '运行结束：共 ' + sum.total + ' 项，提交 ' + sum.done + '，待提交 ' + sum.ready + '，暂停 ' + sum.paused + '，失败 ' + sum.failed);
      toast('运行结束，已生成结果汇总', 'ok');
    }
    renderRun();
    // 作业状态可能已变化，下次进入作业区时重新拉取
    S.worksLoaded = false;
    S.worksAt = 0;
    if (isLoggedIn()) loadWorks(true);
  }

  function onNeedHuman(ev) {
    S.human = ev;
    // 需要的滑动验证已弹出：结束登录 busy 态，让「我已完成验证，继续」立即可点
    S.loginBusy = false;
    var reason = ev.reason || '需要人工完成验证';
    addLog('warn', '需要人工验证：' + reason, ev.workId || null);
    toast('需要人工验证：' + reason, 'warn', 8000);
    if (ev.scene === 'work' && ev.workId) {
      var job = ensureJob(ev.workId, ev);
      job.status = 'paused';
      S.run.paused.set(ev.workId, normalizePaused({
        workId: ev.workId,
        name: job.name,
        courseName: job.courseName,
        kind: 'human',
        reason: reason,
        detail: ev.screenshotPath ? { screenshotPath: ev.screenshotPath } : null,
        createdAt: Date.now()
      }));
      renderRun();
    }
    renderConnect();
    scrollToSection('sec-connect');
  }

  function onLoginDone(ev) {
    S.loginBusy = false;
    S.human = null;
    if (ev.ok === false) {
      addLog('error', '学习通登录未成功' + (ev.uid ? '' : '（未取得登录态）'));
      toast('登录未成功，请在浏览器窗口完成验证后重试', 'warn', 8000);
      refreshState({ silent: true });
      renderConnect();
      return;
    }
    if (S.state && S.state.setup && S.state.setup.chaoxing) {
      S.state.setup.chaoxing.loggedIn = true;
      if (ev.uid) S.state.setup.chaoxing.uid = ev.uid;
    }
    addLog('ok', '学习通登录成功' + (ev.uid ? '（uid: ' + ev.uid + '）' : ''));
    toast('学习通登录成功', 'ok');
    refreshState({ silent: true }).then(function () { loadWorks(true); });
  }

  function onPrivacyCleared(ev) {
    toast('本地数据已清除' + (ev && ev.scope ? '（' + ev.scope + '）' : ''), 'ok');
    loadPrivacy();
    refreshState({ silent: true });
  }

  /* ======================== 状态同步 / 顶栏 ======================== */

  function setupInfo() {
    var st = (S.state && S.state.setup) || {};
    var dsh = st.dsh || {};
    var ai = st.ai || {};
    var cx = st.chaoxing || {};
    var sess = (S.state && S.state.session) || {};
    return {
      installed: !!(dsh.installed || dsh.version),
      dshVersion: dsh.version || '',
      aiConfigured: !!ai.configured,
      cxConfigured: !!cx.configured,
      loggedIn: !!(cx.loggedIn || sess.loggedIn),
      uid: cx.uid || sess.uid || ''
    };
  }
  function isLoggedIn() { return setupInfo().loggedIn; }

  async function refreshState(opts) {
    opts = opts || {};
    try {
      var st = await api('/api/state', { timeout: 12000 });
      S.state = st || null;
      S.stateAt = Date.now();
      S.stateError = '';
      if (S.sse.connected) S.sse.lastMsg = Date.now(); // HTTP 正常也视为链路存活（服务端 SSE 心跳为注释行，JS 不可见）
      if (st && st.config && !S.settingsLoaded) S.settings = normalizeSettings({ config: st.config });
      if (st && st.settings && !S.settings) S.settings = normalizeSettings(st.settings);
      var hasRun = st && (st.running === true || st.phase === 'running' ||
        (Array.isArray(st.jobs) && st.jobs.length > 0) ||
        (Array.isArray(st.paused) && st.paused.length > 0));
      if (!S.run.adopted && hasRun) { syncRunFromState(true); S.run.adopted = true; }
      else if (S.run.adopted) syncRunFromState(false);
      renderStatusBadges();
      renderBanner();
      renderConnect();
      renderRun();
      return st;
    } catch (err) {
      S.stateError = errMsg(err);
      renderStatusBadges();
      renderBanner();
      if (!opts.silent) toast('无法连接本地服务：' + S.stateError, 'error', 8000);
      return null;
    }
  }

  function syncRunFromState(reset) {
    if (!S.state) return;
    if (reset) {
      S.run.jobs = new Map();
      S.run.paused = new Map();
    }
    var jobs = Array.isArray(S.state.jobs) ? S.state.jobs : [];
    jobs.forEach(function (j) {
      if (!j || !j.workId) return;
      var norm = normalizeJob(j);
      var cur = S.run.jobs.get(norm.workId);
      if (cur && !reset) {
        var merged = Object.assign({}, norm, cur);
        merged.steps = Object.assign({}, norm.steps, cur.steps);
        merged.progress = Math.max(num(norm.progress), num(cur.progress));
        merged.status = preferStatus(cur.status, norm.status);
        S.run.jobs.set(norm.workId, merged);
      } else {
        S.run.jobs.set(norm.workId, norm);
      }
    });
    (Array.isArray(S.state.paused) ? S.state.paused : []).forEach(function (p) {
      if (!p || !p.workId) return;
      if (!S.run.paused.has(p.workId)) S.run.paused.set(p.workId, normalizePaused(p));
    });
    if (reset) S.run.active = !!(S.state.running || S.state.phase === 'running');
  }

  function preferStatus(a, b) {
    var rank = { done: 5, failed: 5, paused: 4, running: 3, queued: 2, unknown: 1 };
    return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
  }

  function normalizeJob(j) {
    return {
      workId: String(j.workId),
      name: j.name || '',
      courseName: j.courseName || '',
      status: mapJobStatus(j.status != null ? j.status : j.phase),
      steps: stepsFromArray(j.steps),
      progress: clamp(num(j.progress), 0, 100),
      result: j.result || null,
      step: stepKeyOf(j.step || j.currentStep) || null,
      updatedAt: j.updatedAt || null
    };
  }

  function mapJobStatus(raw) {
    var s = String(raw == null ? '' : raw).toLowerCase();
    if (!s) return 'queued';
    if (s === 'done' || s === 'success' || s === 'completed' || s === 'finished') return 'done';
    if (s === 'ready' || s === 'awaiting_submit' || s === 'saved') return 'ready';
    if (s === 'failed' || s === 'error' || s === 'fail') return 'failed';
    if (s === 'paused' || s === 'pause') return 'paused';
    if (s === 'running' || s === 'active' || s === 'doing') return 'running';
    if (s === 'queued' || s === 'pending' || s === 'waiting') return 'queued';
    if (s === 'skipped') return 'skipped';
    if (/完成|成功/.test(s)) return 'done';
    if (/待提交|已暂存/.test(s)) return 'ready';
    if (/失败|错误/.test(s)) return 'failed';
    if (/暂停/.test(s)) return 'paused';
    if (/跳过/.test(s)) return 'skipped';
    if (/运行|进行/.test(s)) return 'running';
    return 'unknown';
  }

  /** 兼容真实服务端 summary.results[].outcome 与 mock 的 [].status */
  function mapOutcome(item) {
    if (!item) return '';
    var raw = item.outcome != null ? item.outcome : item.status;
    if (raw === 'done') return 'done';
    if (raw === 'ready') return 'ready';
    if (raw === 'paused') return 'paused';
    if (raw === 'failed') return 'failed';
    if (raw === 'skipped') return 'skipped';
    return mapJobStatus(raw);
  }

  function stepsFromArray(list) {
    var out = {};
    if (!Array.isArray(list)) return out;
    list.forEach(function (s) {
      if (!s) return;
      var key = stepKeyOf(s.key || s.step || s.name);
      if (!key) return;
      var st = String(s.status || '').toLowerCase();
      out[key] = st === 'done' || st === 'success' ? 'done' : (st === 'fail' || st === 'error' ? 'fail' : 'running');
    });
    return out;
  }

  function normalizePaused(p) {
    var reason = p.reason || p.message || p.pauseReason || p.detail || '需要人工处理';
    if (typeof reason !== 'string') reason = String(reason);
    var kind = p.kind;
    if (kind !== 'materials' && kind !== 'human' && kind !== 'review') {
      if (/资料|素材|附件|模板|数据|文件/.test(reason)) kind = 'materials';
      else kind = 'human';
    }
    return {
      workId: String(p.workId || ''),
      name: p.name || '',
      courseName: p.courseName || '',
      kind: kind,
      reason: reason,
      detail: p.detail || null,
      missingQuestions: Array.isArray(p.missingQuestions) ? p.missingQuestions : [],
      reviewQuestions: Array.isArray(p.reviewQuestions) ? p.reviewQuestions : [],
      createdAt: p.createdAt || p.ts || Date.now()
    };
  }

  function computeSummary() {
    var jobs = Array.from(S.run.jobs.values());
    var out = { total: jobs.length, done: 0, ready: 0, failed: 0, paused: 0, running: 0, queued: 0 };
    jobs.forEach(function (j) {
      if (j.status === 'done') out.done++;
      else if (j.status === 'ready') out.ready++;
      else if (j.status === 'failed') out.failed++;
      else if (j.status === 'running') out.running++;
      else if (j.status === 'paused') out.paused++;
      else out.queued++;
    });
    var pausedMap = S.run.paused.size;
    out.paused = Math.max(out.paused, pausedMap);
    return out;
  }

  function renderStatusBadges() {
    var info = setupInfo();
    var env = $('#badge-env');
    if (env) {
      if (S.stateError) { env.className = 'status-badge bad'; env.textContent = '服务未连接'; }
      else if (info.installed) { env.className = 'status-badge ok'; env.textContent = '环境 ✓' + (info.dshVersion ? ' v' + info.dshVersion : ''); }
      else { env.className = 'status-badge warn'; env.textContent = '环境未就绪'; }
    }
    var ai = $('#badge-ai');
    if (ai) {
      ai.className = 'status-badge ' + (info.aiConfigured ? 'ok' : 'warn');
      ai.textContent = info.aiConfigured ? 'AI 引擎 ✓' : 'AI 引擎 ✗';
    }
    var cx = $('#badge-cx');
    if (cx) {
      cx.className = 'status-badge ' + (info.loggedIn ? 'ok' : 'warn');
      cx.textContent = info.loggedIn ? '学习通 ✓ 已登录' : '学习通 ✗ 未登录';
    }
    var conn = $('#badge-conn');
    if (conn && !S.sse.connected) setConnBadge(false);
  }

  function renderBanner() {
    var banner = $('#global-banner');
    if (!banner) return;
    var info = setupInfo();
    var text = '';
    var kind = 'warn';
    if (S.stateError) { text = '无法连接本地服务：' + S.stateError + '。请确认程序已启动，然后点右上角「刷新状态」。'; kind = 'bad'; }
    else if (!S.state) { text = '正在连接本地服务…'; kind = 'warn'; }
    else if (!info.installed) { text = '运行环境未就绪：请先运行「环境准备.cmd」完成 Node.js 与 DeepSeek Harness 准备（本程序为免安装绿色版）。'; }
    else if (!info.aiConfigured) { text = '请填写 DeepSeek API Key（下方「连接」区块 ①），用于 AI 解题与写作。'; }
    else if (!info.loggedIn) { text = '请填写学习通账号密码并点击「登录学习通」（下方「连接」区块 ①）。'; }
    if (!text) { banner.hidden = true; clearNode(banner); return; }
    banner.hidden = false;
    banner.className = 'global-banner' + (kind === 'bad' ? ' bad' : '');
    clearNode(banner);
    banner.appendChild(el('span', {}, (kind === 'bad' ? '⚠ ' : '提示：') + text));
  }

  /* ======================== 连接区块 ======================== */

  function renderConnect() {
    var host = $('#connect-body');
    if (!host) return;

    var draft = {
      apiKey: valOf('connect-api-key'),
      username: valOf('connect-cx-username'),
      password: valOf('connect-cx-password')
    };
    var info = setupInfo();
    var envReady = info.installed;
    clearNode(host);

    /* --- DeepSeek API Key --- */
    var keyCard = el('div', { class: 'panel' },
      el('div', { class: 'card-head' },
        el('span', { class: 'card-title' }, 'DeepSeek API Key'),
        info.aiConfigured ? chip('已保存', 'chip-green') : chip('未设置', 'chip-orange')
      ),
      el('div', { class: 'card-body' },
        info.aiConfigured ? el('div', { class: 'secret-line' }, '✓ API Key 已保存（DPAPI 加密，界面不回显）') : null,
        el('div', { class: 'field' },
          el('label', { for: 'connect-api-key' }, info.aiConfigured ? '更换 API Key（可选）' : 'DeepSeek API Key'),
          el('input', {
            class: 'input', id: 'connect-api-key', type: 'password', autocomplete: 'off', spellcheck: 'false',
            placeholder: info.aiConfigured ? '已保存，留空则不修改' : 'sk-…（仅保存在本机，不会上传）',
            value: draft.apiKey
          }),
          el('div', { class: 'hint' }, 'AI 解题与写作使用 DeepSeek 模型；Key 使用 Windows DPAPI 加密保存在程序目录。')
        )
      ),
      el('div', { class: 'card-foot' },
        el('span', { class: 'small faint' }, '接口：api.deepseek.com'),
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: function (e) { saveAiKey(e.currentTarget); }
        }, '保存 API Key')
      )
    );
    host.appendChild(keyCard);

    /* --- 学习通账号 + 登录 --- */
    var cxCard = el('div', { class: 'panel' },
      el('div', { class: 'card-head' },
        el('span', { class: 'card-title' }, '学习通账号'),
        info.cxConfigured ? chip('已保存', 'chip-green') : chip('未设置', 'chip-orange'),
        info.loggedIn ? chip('已登录', 'chip-green') : chip('未登录', 'chip-gray')
      ),
      el('div', { class: 'card-body' },
        info.cxConfigured ? el('div', { class: 'secret-line' }, '✓ 账号密码已保存（DPAPI 加密，界面不回显）') : null,
        el('div', { class: 'form-grid' },
          el('div', { class: 'field' },
            el('label', { for: 'connect-cx-username' }, info.cxConfigured ? '更换账号（可选）' : '学习通账号 / 手机号'),
            el('input', {
              class: 'input', id: 'connect-cx-username', type: 'text', autocomplete: 'off', spellcheck: 'false',
              placeholder: info.cxConfigured ? '已保存，留空则不修改' : '请输入学习通账号或手机号',
              value: draft.username
            })
          ),
          el('div', { class: 'field' },
            el('label', { for: 'connect-cx-password' }, info.cxConfigured ? '更换密码（可选）' : '学习通密码'),
            el('input', {
              class: 'input', id: 'connect-cx-password', type: 'password', autocomplete: 'off', spellcheck: 'false',
              placeholder: info.cxConfigured ? '已保存，留空则不修改' : '请输入学习通密码',
              value: draft.password
            })
          )
        ),
        el('div', { class: 'divider' }),
        renderLoginRow(info)
      ),
      el('div', { class: 'card-foot' },
        el('span', { class: 'small faint' }, '账密仅用于本机自动登录学习通'),
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn', type: 'button',
          onclick: function (e) { saveChaoxing(e.currentTarget); }
        }, '保存账号密码')
      )
    );
    host.appendChild(cxCard);

    /* --- 人工验证提示卡片 --- */
    if (S.human && (!S.human.scene || S.human.scene === 'login')) {
      host.appendChild(el('div', { class: 'span-2' },
        el('div', { class: 'callout callout-warn' },
          el('div', { class: 'callout-icon' }, '!'),
          el('div', { class: 'callout-body' },
            el('div', { style: 'font-weight:700' }, '登录需要人工验证'),
            el('div', {}, S.human.reason || '请在自动打开的浏览器窗口中完成滑块 / 短信验证，然后点击下方按钮继续。'),
            S.human.screenshotPath ? el('div', { class: 'small mono muted' }, '截图：' + S.human.screenshotPath) : null,
            el('div', { class: 'row', style: 'margin-top:8px' },
              el('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: function (e) { setBtnBusy(e.currentTarget, true); startLoginNow(true); }
              }, '我已完成验证，继续'),
              el('button', {
                class: 'btn btn-sm', type: 'button',
                onclick: function () { S.human = null; renderConnect(); }
              }, '稍后再说')
            )
          )
        )
      ));
    }

    /* --- 环境未就绪提示 --- */
    if (!envReady) {
      host.appendChild(el('div', { class: 'span-2' },
        el('div', { class: 'callout callout-warn' },
          el('div', { class: 'callout-icon' }, '!'),
          el('div', { class: 'callout-body' },
            el('div', {}, '运行环境未就绪：请先运行「环境准备.cmd」。'),
            el('div', { class: 'small muted' }, '该脚本会在程序目录内准备便携 Node.js 与 DeepSeek Harness，无需管理员权限、不写注册表。完成后点右上角「刷新状态」。')
          )
        )
      ));
    }
  }

  function renderLoginRow(info) {
    if (info.loggedIn) {
      return el('div', { class: 'login-state' },
        el('span', { class: 'secret-line' }, '✓ 已登录学习通' + (info.uid ? '（uid: ' + info.uid + '）' : '')),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: logout }, '退出登录')
      );
    }
    var btn = el('button', {
      class: 'btn btn-primary btn-lg', type: 'button',
      disabled: S.loginBusy || !info.cxConfigured || !info.installed,
      onclick: function (e) { startLoginNow(false, e.currentTarget); }
    }, S.loginBusy ? '登录中…' : '登录学习通');
    if (S.loginBusy) { btn.classList.add('loading'); btn.disabled = true; }
    return el('div', { class: 'login-state' },
      btn,
      el('span', { class: 'small muted' }, '点击后自动打开浏览器完成登录；遇到滑块 / 短信验证会在此提示。')
    );
  }

  async function saveAiKey(btn) {
    var input = $('#connect-api-key');
    var apiKey = input ? input.value.trim() : '';
    var configured = setupInfo().aiConfigured;
    if (!apiKey && !configured) { toast('请先填写 DeepSeek API Key', 'warn'); if (input) input.focus(); return; }
    if (apiKey && apiKey.length < 8) { toast('API Key 看起来太短，请检查后重试', 'warn'); return; }
    setBtnBusy(btn, true);
    try {
      await api('/api/setup/ai-key', { method: 'POST', body: { apiKey: apiKey }, timeout: 60000 });
      toast('DeepSeek API Key 已保存', 'ok');
      addLog('ok', 'DeepSeek API Key 已保存（界面不回显）');
      await refreshState({ silent: true });
      if (!isLoggedIn()) loadWorks(true);
    } catch (err) {
      toast('保存 API Key 失败：' + errMsg(err), 'error');
    } finally {
      setBtnBusy(btn, false);
      renderConnect();
    }
  }

  async function saveChaoxing(btn) {
    var username = valOf('connect-cx-username').trim();
    var password = valOf('connect-cx-password');
    var configured = setupInfo().cxConfigured;
    if (!configured && (!username || !password)) {
      toast('请填写学习通账号和密码', 'warn');
      return;
    }
    if (password && password.length < 4) { toast('密码看起来太短，请检查后重试', 'warn'); return; }
    setBtnBusy(btn, true);
    try {
      await api('/api/setup/chaoxing', { method: 'POST', body: { username: username, password: password }, timeout: 60000 });
      toast('学习通账号密码已保存', 'ok');
      addLog('ok', '学习通账号密码已保存（界面不回显）');
      await refreshState({ silent: true });
    } catch (err) {
      toast('保存学习通账号失败：' + errMsg(err), 'error');
    } finally {
      setBtnBusy(btn, false);
      renderConnect();
    }
  }

  async function startLoginNow(keepHuman, btn) {
    if (S.loginBusy) return;
    if (!setupInfo().cxConfigured) { toast('请先保存学习通账号密码', 'warn'); return; }
    if (!setupInfo().installed) { toast('运行环境未就绪，请先运行「环境准备.cmd」', 'warn'); return; }
    if (btn) setBtnBusy(btn, true);
    S.loginBusy = true;
    if (!keepHuman) S.human = null;
    renderConnect();
    try {
      // 真实服务端登录可能等待人工滑块，最长可达服务端 loginTimeoutSec（默认 300s）
      await api('/api/login/start', { method: 'POST', timeout: 600000 });
    } catch (err) {
      S.loginBusy = false;
      toast('登录失败：' + errMsg(err), 'error', 9000);
      renderConnect();
      return;
    }
    addLog('step', '已发起学习通登录，等待结果…');
    var started = Date.now();
    async function tick() {
      await sleep(1500);
      if (!S.loginBusy) return;
      await refreshState({ silent: true });
      var info = setupInfo();
      if (info.loggedIn) {
        S.loginBusy = false;
        S.human = null;
        toast('学习通登录成功', 'ok');
        loadWorks(true);
        renderConnect();
        return;
      }
      if (S.human) { S.loginBusy = false; renderConnect(); return; }
      if (Date.now() - started > 600000) {
        S.loginBusy = false;
        toast('登录未完成：请检查浏览器窗口，完成验证后点「继续」或稍后重试。', 'warn', 9000);
        renderConnect();
        return;
      }
      setTimeout(tick, 0);
    }
    setTimeout(tick, 1500);
  }

  async function logout() {
    var ok = await confirmDialog({
      title: '退出学习通登录',
      body: el('p', {}, '退出后将清除本机保存的学习通登录 Cookie，下次需要重新登录；账号密码仍保留。'),
      okText: '退出登录',
      danger: true
    });
    if (!ok) return;
    try {
      await api('/api/logout', { method: 'POST', timeout: 60000 });
      toast('已退出登录', 'ok');
      addLog('warn', '已退出学习通登录');
      S.selected.clear();
      S.worksLoaded = false;
      S.works = [];
      await refreshState({ silent: true });
      renderWorks();
      renderConnect();
    } catch (err) {
      toast('退出登录失败：' + errMsg(err), 'error');
    }
  }

  /* ======================== 作业列表区块 ======================== */

  function normalizeWorks(res) {
    var list = Array.isArray(res) ? res : (res && Array.isArray(res.works) ? res.works : []);
    return list.map(function (w) {
      return {
        workId: String(w.workId || w.id || ''),
        courseId: String(w.courseId || ''),
        courseName: w.courseName || w.course || '未命名课程',
        name: w.name || w.title || '未命名作业',
        status: w.status || '未提交',
        left: w.left || w.remaining || '',
        kind: w.kind || 'unknown',
        url: w.url || ''
      };
    }).filter(function (w) { return !!w.workId; });
  }

  function normalizeCourses(res) {
    var list = Array.isArray(res) ? res : (res && Array.isArray(res.courses) ? res.courses : []);
    return list.map(function (c) {
      var pending = null;
      if (c.works && typeof c.works === 'object') pending = num(c.works.pending);
      else if (c.pending != null) pending = num(c.pending);
      return { courseId: String(c.courseId || c.id || ''), name: c.name || c.courseName || '未命名课程', pending: pending };
    });
  }

  async function loadWorks(force) {
    if (S.worksLoading) return;
    if (!isLoggedIn()) { S.worksLoaded = false; renderWorks(); return; }
    S.worksLoading = true;
    S.worksError = '';
    renderWorks();
    try {
      var results = await Promise.all([
        api('/api/courses', { timeout: 120000 }),
        api('/api/works', { timeout: 120000 })
      ]);
      S.courses = normalizeCourses(results[0]);
      S.works = normalizeWorks(results[1]);
      S.worksLoaded = true;
      S.worksAt = Date.now();
      var ids = new Set(S.works.map(function (w) { return w.workId; }));
      var next = new Set();
      S.selected.forEach(function (id) { if (ids.has(id)) next.add(id); });
      S.selected = next;
    } catch (err) {
      S.worksError = errMsg(err);
      S.worksErrorStatus = err.status || 0;
      if (S.worksLoaded) toast('刷新作业列表失败：' + errMsg(err), 'error');
    } finally {
      S.worksLoading = false;
      renderWorks();
    }
  }

  async function refreshWorks(btn) {
    if (S.worksLoading) return;
    if (!isLoggedIn()) { toast('请先登录学习通', 'warn'); return; }
    if (btn) setBtnBusy(btn, true);
    S.worksLoading = true;
    S.worksError = '';
    renderWorks();
    try {
      await api('/api/works/refresh', { method: 'POST', body: {}, timeout: 180000 });
      S.worksLoading = false;
      await loadWorks(true);
      toast('作业列表已刷新', 'ok');
      addLog('step', '已刷新课程与作业列表');
    } catch (err) {
      S.worksLoading = false;
      S.worksError = errMsg(err);
      S.worksErrorStatus = err.status || 0;
      toast('刷新失败：' + errMsg(err), 'error');
      renderWorks();
    }
  }

  function renderWorks() {
    var toolbarHost = $('#works-toolbar');
    var groupsHost = $('#works-groups');
    if (!toolbarHost || !groupsHost) return;
    clearNode(toolbarHost);
    clearNode(groupsHost);

    var info = setupInfo();
    if (!isLoggedIn()) {
      groupsHost.appendChild(el('div', { class: 'panel empty' },
        el('div', { class: 'empty-title' }, '尚未登录学习通'),
        el('div', {}, '请先在「连接」区块填写账号密码并登录，然后回来查看未完成作业。'),
        el('div', { class: 'row', style: 'justify-content:center;margin-top:14px' },
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: function () { scrollToSection('sec-connect'); }
          }, '去登录')
        )
      ));
      return;
    }

    if (S.worksLoading && !S.worksLoaded) {
      groupsHost.appendChild(el('div', { class: 'panel empty' },
        el('div', { class: 'empty-title' }, '正在获取课程与作业…'),
        el('div', {}, '首次加载需要几秒钟，请稍候。')
      ));
    }

    if (S.worksError && !S.worksLoading) {
      groupsHost.appendChild(el('div', { class: 'callout callout-danger', style: 'margin-bottom:14px' },
        el('div', { class: 'callout-icon' }, '!'),
        el('div', { class: 'callout-body' },
          el('div', { style: 'font-weight:700' }, '获取作业列表失败'),
          el('div', {}, S.worksError),
          el('div', { class: 'small muted' }, S.worksErrorStatus === 401 ? '登录可能已过期，请重新登录。' : '请检查网络与学习通登录状态后重试。'),
          el('div', { class: 'row', style: 'margin-top:8px' },
            el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: function () { loadWorks(true); } }, '重试'),
            el('button', { class: 'btn btn-sm', type: 'button', onclick: function () { scrollToSection('sec-connect'); } }, '检查登录状态')
          )
        )
      ));
    }

    if (!S.works.length) {
      if (!S.worksLoading && S.worksLoaded) {
        groupsHost.appendChild(el('div', { class: 'panel empty' },
          el('div', { class: 'empty-title' }, '暂无未完成作业'),
          el('div', {}, '当前没有需要处理的作业。可以点「刷新列表」重新获取。'),
          el('div', { class: 'row', style: 'justify-content:center;margin-top:14px' },
            el('button', { class: 'btn', type: 'button', onclick: function (e) { refreshWorks(e.currentTarget); } }, '刷新列表')
          )
        ));
      }
      if (S.worksLoaded) {
        /* 工具栏仍然显示 */
        toolbarHost.appendChild(buildWorksToolbar(info));
      }
      return;
    }

    toolbarHost.appendChild(buildWorksToolbar(info));

    var groups = new Map();
    S.works.forEach(function (w) {
      var key = w.courseId || w.courseName;
      if (!groups.has(key)) groups.set(key, { name: w.courseName, courseId: w.courseId, works: [] });
      groups.get(key).works.push(w);
    });

    groups.forEach(function (g) {
      var course = S.courses.find(function (c) { return c.courseId === g.courseId; });
      var pending = course && course.pending != null ? course.pending : g.works.length;
      var groupIds = g.works.map(function (w) { return w.workId; });
      var groupSelected = groupIds.filter(function (id) { return S.selected.has(id); }).length;
      var headCheck = el('input', { type: 'checkbox', checked: groupSelected === groupIds.length && groupIds.length > 0, 'aria-label': '选中本课程全部作业' });
      if (groupSelected > 0 && groupSelected < groupIds.length) headCheck.indeterminate = true;
      headCheck.addEventListener('change', function () {
        if (headCheck.checked) groupIds.forEach(function (id) { S.selected.add(id); });
        else groupIds.forEach(function (id) { S.selected.delete(id); });
        renderWorks();
      });

      var list = el('div', { class: 'work-list' });
      g.works.forEach(function (w) {
        var checked = S.selected.has(w.workId);
        var cb = el('input', { type: 'checkbox', checked: checked, 'aria-label': '选择作业 ' + w.name });
        cb.addEventListener('change', function (e) {
          if (e.target.checked) S.selected.add(w.workId);
          else S.selected.delete(w.workId);
          renderWorks();
        });
        list.appendChild(el('label', { class: 'work-row' + (checked ? ' selected' : '') },
          cb,
          el('div', { class: 'work-main' },
            el('div', { class: 'work-name' }, w.name),
            el('div', { class: 'work-meta' },
              kindChip(w.kind),
              chip(w.status, 'chip-gray'),
              w.left ? el('span', { class: leftClass(w.left) }, '⏰ ' + w.left) : null
            )
          )
        ));
      });

      groupsHost.appendChild(el('div', { class: 'panel course-group' },
        el('div', { class: 'course-head' },
          headCheck,
          el('div', { class: 'course-name' }, g.name),
          el('span', { class: 'course-meta' }, g.works.length + ' 项未完成' + (pending != null && pending !== g.works.length ? '（课程统计 ' + pending + '）' : '')),
          el('div', { class: 'spacer' }),
          groupSelected ? chip('已选 ' + groupSelected + ' 项', 'chip-blue') : null
        ),
        list
      ));
    });
  }

  function buildWorksToolbar(info) {
    var selectedCount = S.selected.size;
    var allChecked = S.works.length > 0 && selectedCount === S.works.length;
    var someChecked = selectedCount > 0 && !allChecked;
    var selectAll = el('input', { type: 'checkbox', checked: allChecked, 'aria-label': '全选作业' });
    if (someChecked) selectAll.indeterminate = true;
    selectAll.addEventListener('change', function () {
      if (selectAll.checked) S.works.forEach(function (w) { S.selected.add(w.workId); });
      else S.selected.clear();
      renderWorks();
    });

    var startBtn = el('button', {
      class: 'btn btn-primary', type: 'button',
      disabled: selectedCount === 0 || !isLoggedIn(),
      onclick: function () { startRunFromWorks(startBtn); }
    }, '开始运行' + (selectedCount ? '（' + selectedCount + ' 项）' : ''));

    return el('div', { class: 'panel works-toolbar' },
      el('label', { class: 'row', style: 'gap:8px;cursor:pointer' }, selectAll, el('span', { class: 'small' }, '全选')),
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: function () {
          var next = new Set();
          S.works.forEach(function (w) { if (!S.selected.has(w.workId)) next.add(w.workId); });
          S.selected = next;
          renderWorks();
        }
      }, '反选'),
      el('span', { class: 'toolbar-count' }, '未完成作业共 ', el('b', {}, String(S.works.length)), ' 项，已选 ', el('b', {}, String(selectedCount)), ' 项'),
      el('div', { class: 'spacer' }),
      S.worksAt ? el('span', { class: 'small faint' }, '更新于 ' + fmtTime(S.worksAt)) : null,
      el('button', {
        class: 'btn btn-sm', type: 'button', disabled: S.worksLoading,
        onclick: function (e) { refreshWorks(e.currentTarget); }
      }, S.worksLoading ? '刷新中…' : '刷新列表'),
      el('button', {
        class: 'btn btn-sm', type: 'button', disabled: selectedCount === 0,
        onclick: function () { S.selected.clear(); renderWorks(); }
      }, '清空选择'),
      startBtn
    );
  }

  async function startRunFromWorks(btn) {
    var ids = Array.from(S.selected);
    if (!ids.length) { toast('请先勾选要运行的作业', 'warn'); return; }
    if (!isLoggedIn()) { toast('请先登录学习通', 'warn'); return; }
    if (!setupInfo().installed) { toast('运行环境未就绪，请先运行「环境准备.cmd」', 'warn'); return; }
    var chosen = S.works.filter(function (w) { return S.selected.has(w.workId); });
    var auto = S.settings ? S.settings.autoSubmit : DEFAULTS.autoSubmit;
    var ok = await confirmDialog({
      title: '确认开始运行',
      body: el('div', {},
        el('p', {}, '将自动处理以下 ' + chosen.length + ' 项作业：'),
        el('ul', { class: 'summary-list' }, chosen.map(function (w) {
          return el('li', {},
            chip(w.courseName || '课程', 'chip-blue'),
            el('span', {}, w.name),
            w.left ? el('span', { class: 'small muted' }, w.left) : null
          );
        })),
        el('p', { class: 'small muted' }, auto
          ? '提交策略：自动提交（可在「设置与隐私」中改为先保存、人工确认后提交）。'
          : '提交策略：先保存、人工确认后提交（当前设置）。'),
        el('p', { class: 'small muted' }, '缺资料的作业会自动暂停并提示补充资料，其余作业继续执行。')
      ),
      okText: '开始运行（' + chosen.length + ' 项）'
    });
    if (!ok) return;

    setBtnBusy(btn, true);
    try {
      var res = await api('/api/run', { method: 'POST', body: { workIds: ids }, timeout: 60000 });
      if (res && res.started === false) {
        toast('无法启动：' + (res.error || '已有任务在运行'), 'error');
        return;
      }
      resetRunState();
      S.run.active = true;
      chosen.forEach(function (w) {
        S.run.jobs.set(w.workId, {
          workId: w.workId, name: w.name, courseName: w.courseName,
          status: 'queued', steps: {}, progress: 0, result: null
        });
      });
      S.run.adopted = true;
      addLog('step', '已提交运行请求，等待服务端开始处理…');
      renderRun();
      scrollToSection('sec-run');
      toast('已开始运行，正在处理作业…', 'ok');
    } catch (err) {
      toast('开始运行失败：' + errMsg(err), 'error');
    } finally {
      setBtnBusy(btn, false);
      renderWorks();
    }
  }

  function resetRunState() {
    S.run.jobs = new Map();
    S.run.paused = new Map();
    S.run.summary = null;
    S.run.active = false;
    S.run.queuePaused = false;
    S.run.stopped = false;
    S.run.startedAt = Date.now();
    S.run.adopted = true;
    S.pauseNotes = {};
    S.logs = [];
    S.human = null;
    var box = $('#log-lines');
    if (box) clearNode(box);
    var countEl = $('#log-count');
    if (countEl) countEl.textContent = '0 条';
  }

  /* ======================== 运行区块 ======================== */

  function capturePauseNotes() {
    $$('[data-note-for]').forEach(function (input) {
      var id = input.getAttribute('data-note-for');
      if (id) S.pauseNotes[id] = input.value;
    });
  }

  function renderRun() {
    var statusHost = $('#run-status');
    var pausedHost = $('#run-paused');
    var jobsHost = $('#run-jobs');
    if (!statusHost || !pausedHost || !jobsHost) return;
    capturePauseNotes();
    clearNode(statusHost);
    clearNode(pausedHost);
    clearNode(jobsHost);

    var sum = computeSummary();
    var hasJobs = S.run.jobs.size > 0 || S.run.paused.size > 0;
    var anyActive = !!(S.run.active || sum.running > 0 || sum.queued > 0);

    if (!hasJobs) {
      statusHost.appendChild(el('div', { class: 'panel empty' },
        el('div', { class: 'empty-title' }, '还没有正在运行的作业'),
        el('div', {}, '在上方「作业列表」勾选作业后点「开始运行」，这里会实时显示进度与日志。'),
        el('div', { class: 'row', style: 'justify-content:center;margin-top:14px' },
          el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { scrollToSection('sec-works'); } }, '去勾选作业')
        )
      ));
      return;
    }

    var status = runStatusInfo(anyActive);
    var pauseBtn = el('button', {
      class: 'btn', type: 'button',
      disabled: !S.run.active || S.run.queuePaused,
      onclick: async function (e) {
        var btn = e.currentTarget; setBtnBusy(btn, true);
        try {
          await api('/api/run/pause', { method: 'POST', body: {}, timeout: 30000 });
          S.run.queuePaused = true;
          toast('已请求暂停队列（当前作业完成后暂停）', 'warn');
        } catch (err) { toast('暂停失败：' + errMsg(err), 'error'); }
        finally { setBtnBusy(btn, false); renderRun(); }
      }
    }, '暂停队列');
    var resumeBtn = el('button', {
      class: 'btn btn-primary', type: 'button',
      disabled: !S.run.queuePaused,
      onclick: async function (e) {
        var btn = e.currentTarget; setBtnBusy(btn, true);
        try {
          await api('/api/run/resume', { method: 'POST', body: {}, timeout: 30000 });
          S.run.queuePaused = false;
          toast('已请求继续队列', 'ok');
        } catch (err) { toast('继续失败：' + errMsg(err), 'error'); }
        finally { setBtnBusy(btn, false); renderRun(); }
      }
    }, '继续队列');
    var stopBtn = el('button', {
      class: 'btn btn-danger', type: 'button',
      disabled: !S.run.active,
      onclick: async function (e) {
        var ok = await confirmDialog({
          title: '停止当前运行',
          body: el('p', {}, '停止后当前正在处理的作业会中断，已完成的结果会保留。确定要停止吗？'),
          okText: '停止运行', danger: true
        });
        if (!ok) return;
        var btn = e.currentTarget; setBtnBusy(btn, true);
        try { await api('/api/run/stop', { method: 'POST', body: {}, timeout: 30000 }); toast('已请求停止运行', 'warn'); }
        catch (err) { toast('停止失败：' + errMsg(err), 'error'); }
        finally { setBtnBusy(btn, false); renderRun(); }
      }
    }, '停止');

    statusHost.appendChild(el('div', { class: 'panel run-status-bar' },
      el('span', { class: 'status-pill ' + status.cls }, status.label),
      el('div', { class: 'run-stats' },
        stat('总数', sum.total, 'blue'),
        stat('完成', sum.done, 'green'),
        sum.ready ? stat('待提交', sum.ready, 'orange') : null,
        stat('暂停', sum.paused, 'orange'),
        stat('失败', sum.failed, 'red'),
        sum.queued + sum.running ? stat('进行/排队', sum.queued + sum.running, 'blue') : null
      ),
      el('div', { class: 'spacer' }),
      pauseBtn, resumeBtn, stopBtn
    ));

    if (S.run.summary || (!anyActive && (sum.done || sum.failed))) {
      statusHost.appendChild(summaryCard(sum));
    }

    if (S.run.paused.size) {
      var block = el('div', { class: 'paused-block' });
      S.run.paused.forEach(function (p) { block.appendChild(pausedCard(p)); });
      pausedHost.appendChild(block);
    }

    var jobsPanel = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, '作业进度'),
        el('div', { class: 'panel-sub' }, '点击「详情」查看题目、答案与产物'),
        el('div', { class: 'spacer' }),
        el('div', { class: 'small faint' }, '共 ' + S.run.jobs.size + ' 项')
      ),
      el('div', { class: 'job-list' })
    );
    var jobList = $('.job-list', jobsPanel);
    Array.from(S.run.jobs.values()).forEach(function (job) {
      jobList.appendChild(jobRow(job));
    });
    if (!S.run.jobs.size) jobList.appendChild(el('div', { class: 'empty', style: 'padding:24px' }, '暂无作业进度'));
    jobsHost.appendChild(jobsPanel);
  }

  function stat(label, value, cls) {
    return el('div', { class: 'stat ' + (cls || '') }, el('b', {}, String(value)), el('span', {}, label));
  }

  function runStatusInfo(anyActive) {
    var sum = computeSummary();
    if (S.run.queuePaused && (S.run.active || anyActive)) return { label: '已暂停', cls: 'paused' };
    if (S.run.active || anyActive) return { label: '运行中', cls: 'running' };
    if (S.run.stopped) return { label: '已停止', cls: 'stopped' };
    if (S.run.jobs.size > 0) {
      if (sum.paused > 0) return { label: '已结束 · 有待处理项', cls: 'paused' };
      if (sum.ready > 0) return { label: '已结束 · 有待提交项', cls: 'paused' };
      if (sum.failed > 0) return { label: '已结束 · 有失败项', cls: 'stopped' };
      return { label: '已结束', cls: 'done' };
    }
    return { label: '空闲', cls: 'idle' };
  }

  function jobRow(job) {
    var progress = clamp(job.progress || 0, 0, 100);
    var stepsBox = el('div', { class: 'job-steps' });
    STEP_ORDER.forEach(function (key, idx) {
      var st = (job.steps && job.steps[key]) || '';
      var cls = st === 'done' ? 'done' : (st === 'running' ? 'active' : (st === 'fail' ? 'fail' : ''));
      stepsBox.appendChild(el('span', { class: 'job-step ' + cls }, STEP_LABEL[key]));
      if (idx < STEP_ORDER.length - 1) stepsBox.appendChild(el('span', { class: 'job-step-sep' }, '›'));
    });

    return el('div', { class: 'job-row' },
      el('div', { class: 'job-main' },
        el('div', { class: 'job-top' },
          el('span', { class: 'job-name' }, job.name || job.workId),
          statusChip(job.status)
        ),
        el('div', { class: 'job-sub' },
          job.courseName ? el('span', {}, job.courseName) : null,
          el('span', { class: 'mono faint' }, job.workId),
          job.progress ? el('span', { class: 'faint' }, progress + '%') : null
        ),
        stepsBox,
        job.status === 'running' ? el('div', { class: 'progress job-progress' }, el('div', { class: 'bar', style: 'width:' + progress + '%' })) : null
      ),
      el('div', { class: 'row' },
        job.status === 'ready' ? el('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: async function (e) {
            var btn = e.currentTarget; setBtnBusy(btn, true);
            try { await api('/api/jobs/' + encodeURIComponent(job.workId) + '/open', { method: 'POST', body: {}, timeout: 60000 }); toast('已在受控浏览器打开作业页', 'ok'); }
            catch (err) { toast('打开失败：' + errMsg(err), 'error'); }
            finally { setBtnBusy(btn, false); }
          }
        }, '打开作业页') : null,
        el('button', {
          class: 'btn btn-sm btn-ghost', type: 'button',
          onclick: function () { openJobDetail(job.workId); }
        }, '详情')
      )
    );
  }

  function questionRefsBlock(refs) {
    if (!Array.isArray(refs) || !refs.length) return null;
    var box = el('div', { class: 'detail-section', style: 'margin-top:8px' },
      el('h4', {}, '涉及题目（AI 定位，仅供参考）')
    );
    var list = el('div', { class: 'stack' });
    refs.forEach(function (r) {
      list.appendChild(el('div', { class: 'small', style: 'padding:4px 0;border-bottom:1px solid var(--line)' },
        el('span', { class: 'chip chip-gray', style: 'margin-right:6px' }, '第' + (r.index || '?') + '题'),
        el('span', { class: 'muted' }, (r.typeLabel || r.type || '未知') + ' · '),
        el('span', {}, (r.stem || '（题干未获取）').slice(0, 120))
      ));
    });
    box.appendChild(list);
    return box;
  }

  function pausedCard(p) {
    var isHuman = p.kind === 'human';
    var isReview = p.kind === 'review';
    var card = el('div', { class: 'panel pause-card ' + (isHuman ? 'human' : (isReview ? 'review' : '')) });
    card.appendChild(el('div', { class: 'pause-title' },
      chip(isHuman ? '需要人工验证' : (isReview ? '待确认提交' : '缺少资料'), isHuman ? 'chip-purple' : (isReview ? 'chip-blue' : 'chip-orange')),
      el('span', {}, p.name || p.workId),
      p.courseName ? el('span', { class: 'small muted' }, p.courseName) : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'small mono faint' }, p.workId)
    ));
    card.appendChild(el('div', { class: 'pause-reason' }, p.reason || '需要人工处理'));

    if (isHuman) {
      card.appendChild(el('div', { class: 'pause-hint' },
        '请在弹出的浏览器窗口中完成验证（滑块 / 短信 / 扫码等），完成后点「我已完成」。若浏览器窗口已关闭，可点「重新登录」重新发起。'
      ));
      var doneBtn = el('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: async function (e) {
          var btn = e.currentTarget; setBtnBusy(btn, true);
          try {
            await api('/api/run/resume', { method: 'POST', body: { workId: p.workId }, timeout: 60000 });
            S.run.paused.delete(p.workId);
            var job = S.run.jobs.get(p.workId);
            if (job) job.status = 'running';
            S.human = null;
            toast('已继续该项作业', 'ok');
          } catch (err) {
            toast('继续失败：' + errMsg(err), 'error');
          } finally {
            setBtnBusy(btn, false);
            renderRun();
          }
        }
      }, '我已完成，继续');
      card.appendChild(el('div', { class: 'pause-actions' }, doneBtn,
        el('button', { class: 'btn btn-sm', type: 'button', onclick: function () { startLoginNow(false); } }, '重新登录'),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: function () { S.run.paused.delete(p.workId); renderRun(); } }, '忽略此项')
      ));
      return card;
    }

    if (isReview) {
      card.appendChild(el('div', { class: 'pause-hint' },
        '检测到主观题/附件题，程序已把答案和附件暂存到学习通。AI 内容可能有误，建议先打开作业页检查，再决定是否提交。'
      ));
      var refs = questionRefsBlock(p.reviewQuestions);
      if (refs) card.appendChild(refs);
      var openBtn = el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async function (e) {
          var btn = e.currentTarget; setBtnBusy(btn, true);
          try { await api('/api/jobs/' + encodeURIComponent(p.workId) + '/open', { method: 'POST', body: {}, timeout: 60000 }); toast('已在受控浏览器打开作业页', 'ok'); }
          catch (err) { toast('打开失败：' + errMsg(err), 'error'); }
          finally { setBtnBusy(btn, false); }
        }
      }, '打开作业页');
      var readyBtn = el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async function (e) {
          var btn = e.currentTarget; setBtnBusy(btn, true);
          try {
            await api('/api/jobs/' + encodeURIComponent(p.workId) + '/ready', { method: 'POST', body: {}, timeout: 60000 });
            S.run.paused.delete(p.workId);
            var job = S.run.jobs.get(p.workId);
            if (job) job.status = 'ready';
            toast('已保留暂存，稍后可在学习通手动提交', 'warn');
          } catch (err) { toast('操作失败：' + errMsg(err), 'error'); }
          finally { setBtnBusy(btn, false); renderRun(); }
        }
      }, '仅保存，稍后手动提交');
      var submitBtn = el('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: async function (e) {
          var ok = await confirmDialog({
            title: '确认提交作业',
            body: el('div', {},
              el('p', {}, '请确认已在作业页检查过答案与附件，且确认 AI 生成内容无误。'),
              el('p', { class: 'callout callout-danger' }, '提交后会消耗作答机会，通常不可撤回。')
            ),
            okText: '确认提交', danger: true
          });
          if (!ok) return;
          var btn = e.currentTarget; setBtnBusy(btn, true);
          try {
            await api('/api/jobs/' + encodeURIComponent(p.workId) + '/submit', { method: 'POST', body: {}, timeout: 180000 });
            S.run.paused.delete(p.workId);
            var job = S.run.jobs.get(p.workId);
            if (job) job.status = 'done';
            toast('提交成功', 'ok');
          } catch (err) { toast('提交失败：' + errMsg(err), 'error'); }
          finally { setBtnBusy(btn, false); renderRun(); }
        }
      }, '检查完毕，仍然提交');
      card.appendChild(el('div', { class: 'pause-actions' }, openBtn, readyBtn, submitBtn));
      return card;
    }

    var folder = 'data\\materials\\' + p.workId;
    card.appendChild(el('div', { class: 'pause-hint' }, '请把所需资料放入以下文件夹，然后点击「继续」：'));
    card.appendChild(el('div', { class: 'answer-box mono', style: 'margin-top:6px' }, folder));
    var detailText = pausedDetailText(p.detail);
    if (detailText) card.appendChild(el('div', { class: 'small muted', style: 'margin-top:6px' }, '缺少：' + detailText));
    var refsBox = questionRefsBlock(p.missingQuestions);
    if (refsBox) card.appendChild(refsBox);
    card.appendChild(el('div', { class: 'callout callout-warn', style: 'margin-top:8px' },
      el('div', { class: 'callout-body' }, 'AI 定位的题号/缺资料判断不一定准确，请以作业页面为准，自行读题后补充；提供错误资料可能导致答案错误。')
    ));
    var noteInput = el('input', {
      class: 'input pause-note', type: 'text', placeholder: '补充说明（可选），例如：已放入 实习数据.csv',
      'data-note-for': p.workId, value: S.pauseNotes[p.workId] || ''
    });
    noteInput.addEventListener('input', function () { S.pauseNotes[p.workId] = noteInput.value; });
    var contBtn = el('button', {
      class: 'btn btn-primary btn-sm', type: 'button',
      onclick: async function (e) {
        var btn = e.currentTarget; setBtnBusy(btn, true);
        try {
          await api('/api/jobs/' + encodeURIComponent(p.workId) + '/materials', {
            method: 'POST', body: { note: S.pauseNotes[p.workId] || '' }, timeout: 60000
          });
          S.run.paused.delete(p.workId);
          delete S.pauseNotes[p.workId];
          var job = S.run.jobs.get(p.workId);
          if (job) job.status = 'queued';
          toast('已提交资料补充，继续处理该项作业', 'ok');
        } catch (err) {
          toast('继续失败：' + errMsg(err), 'error');
        } finally {
          setBtnBusy(btn, false);
          renderRun();
        }
      }
    }, '已放入资料，继续');
    card.appendChild(el('div', { class: 'pause-actions' },
      noteInput, contBtn,
      el('button', { class: 'btn btn-sm', type: 'button', onclick: function () { openFolder('materials/' + p.workId); } }, '打开资料文件夹')
    ));
    return card;
  }

  function pausedDetailText(detail) {
    if (!detail) return '';
    if (Array.isArray(detail)) {
      return detail.map(function (x) {
        if (typeof x === 'string') return x;
        return x.name || x.path || x.file || JSON.stringify(x);
      }).slice(0, 6).join('；');
    }
    if (typeof detail === 'object') return detail.file || detail.name || detail.folder || JSON.stringify(detail);
    return String(detail);
  }

  function summaryCard(sum) {
    var s = S.run.summary || {};
    var results = Array.isArray(s.results) ? s.results : (Array.isArray(s.items) ? s.items : null);
    var card = el('div', { class: 'panel summary-card', style: 'margin-top:14px' },
      el('div', { class: 'summary-title' }, '运行结果汇总'),
      el('div', { class: 'summary-grid' },
        stat('总数', sum.total, 'blue'),
        stat('完成', sum.done, 'green'),
        sum.ready ? stat('待提交', sum.ready, 'orange') : null,
        stat('暂停', sum.paused, 'orange'),
        stat('失败', sum.failed, 'red')
      )
    );
    if (results && results.length) {
      var list = el('ul', { class: 'summary-list' });
      results.forEach(function (r) {
        var status = mapOutcome(r) || 'unknown';
        var text = r.name || r.workId || '';
        var extra = '';
        if (r.score != null) extra = ' · 得分 ' + r.score;
        else if (r.error) extra = ' · ' + String(r.error).slice(0, 200);
        else if (r.reason) extra = ' · ' + r.reason;
        else if (r.message) extra = ' · ' + r.message;
        list.appendChild(el('li', {}, statusChip(status), el('span', {}, text + extra)));
      });
      card.appendChild(list);
    }
    return card;
  }

  async function openJobDetail(workId) {
    var job = S.run.jobs.get(workId);
    var modal = openModal({
      title: (job && job.name) || workId,
      body: el('div', { class: 'muted' }, '正在读取作业详情…')
    });
    if (!modal) return;
    try {
      var res = await api('/api/jobs/' + encodeURIComponent(workId), { timeout: 60000 });
      var j = res && res.job ? res.job : res;
      modal.setBody(renderJobDetail(j || {}, workId));
    } catch (err) {
      modal.setBody(el('div', { class: 'callout callout-danger' },
        el('div', { class: 'callout-icon' }, '!'),
        el('div', { class: 'callout-body' },
          el('div', { style: 'font-weight:700' }, '读取作业详情失败'),
          el('div', {}, errMsg(err))
        )
      ));
    }
  }

  function renderJobDetail(j, workId) {
    var box = el('div', {});
    var status = mapJobStatus(j.status || j.phase || (j.paused ? 'paused' : ''));
    box.appendChild(el('div', { class: 'row' },
      statusChip(status),
      j.courseName ? chip(j.courseName, 'chip-gray') : null,
      el('span', { class: 'small mono faint' }, workId || j.workId || '')
    ));

    if (j.paused) {
      var paused = normalizePaused(j.paused === true ? { workId: workId } : j.paused);
      box.appendChild(el('div', { class: 'callout callout-warn', style: 'margin-top:12px' },
        el('div', { class: 'callout-icon' }, '!'),
        el('div', { class: 'callout-body' },
          el('div', { style: 'font-weight:700' }, paused.kind === 'materials' ? '缺少资料，已暂停' : (paused.kind === 'review' ? '待确认提交' : '需要人工验证')),
          el('div', {}, paused.reason)
        )
      ));
    }

    if (Array.isArray(j.steps) && j.steps.length) {
      var tl = el('div', { class: 'steps-timeline' });
      j.steps.forEach(function (s) {
        var st = String(s.status || '').toLowerCase();
        var cls = st === 'done' || st === 'success' ? 'done' : (st === 'fail' || st === 'error' ? 'fail' : 'running');
        tl.appendChild(el('div', { class: 'tl ' + cls },
          el('span', { class: 'st' }, STEP_DISPLAY[s.name] || STEP_DISPLAY[s.step] || (s.name || s.step || '步骤')),
          el('span', {}, (s.message || s.status || '')),
          s.ts ? el('span', { class: 'faint' }, fmtTime(s.ts)) : null
        ));
      });
      box.appendChild(el('div', { class: 'detail-section' }, el('h4', {}, '执行步骤'), tl));
    }

    if (Array.isArray(j.questions) && j.questions.length) {
      var qBox = el('div', { class: 'detail-section' }, el('h4', {}, '题目（' + j.questions.length + '）'));
      j.questions.forEach(function (q, idx) {
        var item = el('div', { class: 'q-item' },
          el('div', { class: 'q-stem' }, (idx + 1) + '. ' + (q.stem || q.title || '')),
          el('div', { class: 'small muted' }, '类型：' + (KIND_LABEL[q.type] || q.type || '未知'))
        );
        if (Array.isArray(q.opts) && q.opts.length) {
          var ul = el('ul', { class: 'q-opts' });
          q.opts.forEach(function (o) { ul.appendChild(el('li', {}, (o.key ? o.key + '. ' : '') + (o.text || ''))); });
          item.appendChild(ul);
        }
        qBox.appendChild(item);
      });
      box.appendChild(qBox);
    }

    if (j.answers && (typeof j.answers === 'object' || typeof j.answers === 'string')) {
      var answersText = typeof j.answers === 'string' ? j.answers : JSON.stringify(j.answers, null, 2);
      box.appendChild(el('div', { class: 'detail-section' },
        el('h4', {}, '答案'),
        el('div', { class: 'answer-box' }, answersText)
      ));
    }

    if (Array.isArray(j.files) && j.files.length) {
      box.appendChild(el('div', { class: 'detail-section' },
        el('h4', {}, '产物文件'),
        el('div', { class: 'kv-list' }, j.files.map(function (f) {
          var p = typeof f === 'string' ? f : (f.path || f.file || '');
          var name = typeof f === 'string' ? f : (f.name || p);
          return el('div', { class: 'kv' }, el('span', { class: 'k' }, name), el('span', { class: 'v mono small' }, p));
        }))
      ));
    }

    if (j.result && typeof j.result === 'object') {
      box.appendChild(el('div', { class: 'detail-section' },
        el('h4', {}, '结果'),
        el('div', { class: 'answer-box' }, JSON.stringify(j.result, null, 2))
      ));
    }

    if (j.error) {
      box.appendChild(el('div', { class: 'detail-section' },
        el('h4', {}, '错误信息'),
        el('div', { class: 'callout callout-danger' },
          el('div', { class: 'callout-body' },
            el('div', { style: 'font-weight:700' }, String(j.error)),
            j.errorHint ? el('div', { class: 'small', style: 'margin-top:4px' }, '建议：' + j.errorHint) : null,
            j.errorCode ? el('div', { class: 'small faint', style: 'margin-top:4px' }, '错误代码：' + j.errorCode) : null
          )
        ),
        j.errorRaw ? el('details', { class: 'detail-section' },
          el('summary', { class: 'small muted' }, '原始报错（排障用）'),
          el('pre', { class: 'small mono', style: 'white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto' }, String(j.errorRaw))
        ) : null
      ));
    }

    box.appendChild(el('details', { class: 'detail-section' },
      el('summary', { class: 'small muted' }, '原始数据（调试）'),
      el('pre', { class: 'small mono', style: 'white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto' }, JSON.stringify(j, null, 2))
    ));
    return box;
  }

  /* ======================== 设置与隐私区块 ======================== */

  function modelText(m) {
    if (m == null) return '默认模型';
    if (typeof m === 'string') return m;
    if (typeof m === 'object') {
      if (m.provider && m.model) return m.provider + ' / ' + m.model;
      return m.model || m.name || JSON.stringify(m);
    }
    return String(m);
  }

  function normalizeSettings(raw) {
    // 兼容：{settings:{...}} / {config:{...}} / 平铺对象；model 可能是 {provider,model} 对象
    var s = raw && raw.settings ? raw.settings : (raw && raw.config ? raw.config : (raw || {}));
    var timeoutMin = num(s.timeoutMin);
    if (!timeoutMin && num(s.engineTimeoutSec)) timeoutMin = Math.max(1, Math.round(num(s.engineTimeoutSec) / 60));
    var acc = num(s.targetAccuracy);
    if (!acc || acc <= 0) acc = DEFAULTS.targetAccuracy;
    return {
      autoSubmit: s.autoSubmit !== undefined ? !!s.autoSubmit : DEFAULTS.autoSubmit,
      targetAccuracy: acc,
      reviewBeforeSubmit: s.reviewBeforeSubmit !== undefined ? s.reviewBeforeSubmit !== false : DEFAULTS.reviewBeforeSubmit,
      modelRaw: s.model !== undefined ? s.model : DEFAULTS.model,
      modelText: modelText(s.model),
      port: num(s.port) || DEFAULTS.port,
      concurrency: num(s.concurrency) || DEFAULTS.concurrency,
      timeoutMin: timeoutMin || DEFAULTS.timeoutMin
    };
  }

  async function loadSettings() {
    if (S.settingsLoading) return;
    S.settingsLoading = true;
    if (S.settingsLoaded) renderSettings();
    try {
      var res = await api('/api/settings', { timeout: 30000 });
      S.settings = normalizeSettings(res && res.settings ? res.settings : res);
      S.settingsLoaded = true;
    } catch (err) {
      toast('读取设置失败：' + errMsg(err), 'error');
    } finally {
      S.settingsLoading = false;
      renderSettings();
    }
  }

  async function loadPrivacy() {
    try {
      var res = await api('/api/privacy', { timeout: 30000 });
      S.privacy = normalizePrivacy(res && res.privacy ? res.privacy : res);
      S.privacyError = '';
      S.privacyLoaded = true;
    } catch (err) {
      S.privacyError = errMsg(err);
    }
    renderSettings();
  }

  function normalizePrivacy(raw) {
    var r = raw || {};
    var enc = r.encrypted;
    return {
      dataDir: r.dataDir || r.path || '',
      logDir: r.logDir || '',
      encrypted: (enc && typeof enc === 'object') ? !!(enc.secrets || enc.session) : enc !== false,
      clearable: Array.isArray(r.clearable) ? r.clearable : (Array.isArray(r.scopes) ? r.scopes : null)
    };
  }

  function formatBytes(bytes) {
    var n = num(bytes);
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function dataDirOf() {
    if (S.privacy && S.privacy.dataDir) return S.privacy.dataDir;
    if (S.state && S.state.paths && S.state.paths.data) return S.state.paths.data;
    if (S.state && (S.state.dataDir || S.state.appRoot)) return S.state.dataDir || S.state.appRoot;
    return '由服务端管理';
  }

  function logDirOf() {
    if (S.privacy && S.privacy.logDir) return S.privacy.logDir;
    if (S.state && S.state.paths && S.state.paths.logs) return S.state.paths.logs;
    return '（数据目录下 logs）';
  }

  function secretEncryptionText() {
    var info = setupInfo();
    if (!info.aiConfigured && !info.cxConfigured) return '未保存任何密钥';
    if (!S.privacy) return '查询中…';
    return S.privacy.encrypted ? 'DPAPI 加密' : '未加密（请检查）';
  }

  function clearItems() {
    if (!S.privacy || !Array.isArray(S.privacy.clearable) || !S.privacy.clearable.length) return CLEAR_FALLBACK;
    var out = [];
    S.privacy.clearable.forEach(function (item) {
      if (typeof item === 'string') out.push({ scope: item, label: item, desc: '' });
      else if (item && (item.scope || item.key)) {
        var desc = item.description || item.desc || '';
        if (!desc && item.bytes != null) desc = '约 ' + formatBytes(item.bytes);
        out.push({ scope: item.scope || item.key, label: item.label || item.scope || item.key, desc: desc });
      }
    });
    return out.length ? out : CLEAR_FALLBACK;
  }

  function renderSettings() {
    var host = $('#settings-body');
    if (!host) return;
    clearNode(host);
    if (S.settingsLoading && !S.settingsLoaded) {
      host.appendChild(el('div', { class: 'panel empty' }, el('div', { class: 'empty-title' }, '正在读取设置…')));
      return;
    }

    var settings = S.settings || normalizeSettings(null);
    var info = setupInfo();
    var grid = el('div', { class: 'settings-grid' });
    host.appendChild(grid);

    /* --- 运行设置 --- */
    var autoCb = el('input', { type: 'checkbox', checked: settings.autoSubmit, id: 'set-auto-submit' });
    var reviewCb = el('input', { type: 'checkbox', checked: settings.reviewBeforeSubmit, id: 'set-review-submit' });
    var timeoutInput = el('input', { class: 'input', id: 'set-timeout', type: 'number', min: '1', max: '120', value: String(settings.timeoutMin) });
    var ACC_LEVELS = [0.99, 0.9, 0.8, 0.6, 0.3];
    var ACC_LABELS = ['99%', '90%', '80%', '60%', '30%'];
    var accIndex = 0;
    for (var ai = 0; ai < ACC_LEVELS.length; ai += 1) {
      if (Math.abs(ACC_LEVELS[ai] - settings.targetAccuracy) < Math.abs(ACC_LEVELS[accIndex] - settings.targetAccuracy)) accIndex = ai;
    }
    var accRange = el('input', {
      type: 'range', min: '0', max: String(ACC_LEVELS.length - 1), step: '1', value: String(accIndex),
      id: 'set-accuracy', class: 'accuracy-range'
    });
    var accVal = el('span', { class: 'accuracy-value' }, ACC_LABELS[accIndex]);
    var accWarn = el('div', { class: 'accuracy-warning' });
    function updateAcc() {
      var idx = clamp(num(accRange.value), 0, ACC_LEVELS.length - 1);
      accVal.textContent = ACC_LABELS[idx];
      var isLow = ACC_LEVELS[idx] <= 0.3;
      accWarn.className = 'accuracy-warning' + (isLow ? ' danger' : '');
      accWarn.textContent = isLow
        ? '⚠ 30% 档位会故意产生大量错误答案，容易影响成绩或引起注意，请谨慎使用。'
        : '仅作用于选择题/填空题，按题数比例故意改错；实际正确率受 AI 能力影响，无法保证。';
    }
    accRange.addEventListener('input', updateAcc);
    updateAcc();

    var settingsPanel = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, '运行设置'),
        el('div', { class: 'panel-sub' }, '模型与端口由服务端配置文件管理，修改后需重启程序')
      ),
      el('div', { class: 'panel-body settings-form' },
        el('div', { class: 'switch-row' },
          el('div', { class: 'field' },
            el('label', { for: 'set-auto-submit' }, '自动提交'),
            el('div', { class: 'hint' }, '开启后自动填写并提交；关闭则先暂存到学习通，标记为「待提交」，由你手动提交。')
          ),
          el('label', { class: 'switch' }, autoCb, el('span', { class: 'track' }))
        ),
        el('div', { class: 'switch-row' },
          el('div', { class: 'field' },
            el('label', { for: 'set-review-submit' }, '主观题/附件题提交前确认'),
            el('div', { class: 'hint' }, '默认开启：检测到主观题/附件题时，先暂存并暂停，等你检查后再决定是否提交。')
          ),
          el('label', { class: 'switch' }, reviewCb, el('span', { class: 'track' }))
        ),
        el('div', { class: 'form-grid' },
          el('div', { class: 'field span-2' },
            el('label', { for: 'set-accuracy' }, '目标正确率（近似）'),
            el('div', { class: 'accuracy-line' }, accRange, accVal),
            accWarn
          ),
          el('div', { class: 'field' },
            el('label', {}, '模型'),
            el('input', { class: 'input', type: 'text', value: settings.modelText, disabled: true, readonly: true }),
            el('div', { class: 'hint' }, '在服务端配置文件中调整模型。')
          ),
          el('div', { class: 'field' },
            el('label', {}, '服务端口'),
            el('input', { class: 'input', type: 'text', value: String(settings.port), disabled: true, readonly: true }),
            el('div', { class: 'hint' }, '以实际监听端口为准；修改需重启程序。')
          ),
          el('div', { class: 'field span-2' },
            el('label', { for: 'set-timeout' }, '单项超时（分钟）'),
            timeoutInput,
            el('div', { class: 'hint' }, 'AI 求解 / 生成文档单项最长等待时间，超时该项失败并继续下一项。')
          )
        )
      ),
      el('div', { class: 'panel-foot' },
        el('span', { class: 'small faint' }, '并发与账号策略由服务端控制；绿色版所有数据只存程序目录。'),
        el('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async function (e) {
            var btn = e.currentTarget;
            var timeoutMin = num(timeoutInput.value);
            if (timeoutMin < 1 || timeoutMin > 120) { toast('超时需在 1–120 分钟之间', 'warn'); timeoutInput.focus(); return; }
            var payload = {
              autoSubmit: autoCb.checked,
              reviewBeforeSubmit: reviewCb.checked,
              targetAccuracy: ACC_LEVELS[clamp(num(accRange.value), 0, ACC_LEVELS.length - 1)],
              timeoutMin: timeoutMin,
              // 真实服务端使用 engineTimeoutSec（秒），两个字段都发以兼容 mock / 真实服务
              engineTimeoutSec: timeoutMin * 60
            };
            setBtnBusy(btn, true);
            try {
              var res = await api('/api/settings', { method: 'POST', body: payload, timeout: 30000 });
              S.settings = normalizeSettings(res || payload);
              S.settingsLoaded = true;
              toast('设置已保存', 'ok');
              addLog('ok', '设置已更新');
              renderSettings();
            } catch (err) {
              toast('保存设置失败：' + errMsg(err), 'error');
            } finally {
              setBtnBusy(btn, false);
            }
          }
        }, '保存设置')
      )
    );
    grid.appendChild(settingsPanel);

    var right = el('div', { class: 'stack' });

    /* --- 数据与日志 --- */
    right.appendChild(el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('div', { class: 'panel-title' }, '数据与日志')),
      el('div', { class: 'panel-body stack' },
        el('div', { class: 'kv-list' },
          kv('数据目录', dataDirOf()),
          kv('日志目录', logDirOf()),
          kv('账密 / Cookie', secretEncryptionText()),
          kv('实时连接', S.sse.connected ? '正常' : '断开 / 重连中')
        ),
        el('div', { class: 'folder-grid' },
          el('button', { class: 'btn', type: 'button', onclick: function () { openFolder('data'); } }, '打开数据目录'),
          el('button', { class: 'btn', type: 'button', onclick: function () { openFolder('logs'); } }, '打开日志目录'),
          el('button', { class: 'btn', type: 'button', onclick: function () { openFolder('materials'); } }, '打开资料目录')
        )
      )
    ));

    /* --- 隐私说明 --- */
    right.appendChild(el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('div', { class: 'panel-title' }, '隐私说明')),
      el('div', { class: 'panel-body' },
        el('ul', { class: 'privacy-list' },
          el('li', {}, el('span', { class: 'ok' }, '✓'), el('span', {}, '学习通账密、Cookie 与 DeepSeek API Key 使用 Windows DPAPI（CurrentUser）加密，仅本机可解密。')),
          el('li', {}, el('span', { class: 'ok' }, '✓'), el('span', {}, '所有数据只保存在程序目录（data\\），不写注册表、不写系统目录。')),
          el('li', {}, el('span', { class: 'ok' }, '✓'), el('span', {}, '界面不回显密码与 API Key，只显示「已保存 / 未设置」。')),
          el('li', {}, el('span', { class: 'ok' }, '✓'), el('span', {}, '除 DeepSeek API 与学习通外，不连接其他外部服务；日志脱敏。')),
          el('li', {}, el('span', { class: 'ok' }, '✓'), el('span', {}, '只操作本人账号；作业内容与学术诚信责任由使用者承担。'))
        )
      )
    ));

    /* --- 清除本地数据 --- */
    var clearActions = el('div', { class: 'clear-actions' });
    clearItems().forEach(function (item) {
      var btn = el('button', {
        class: 'btn btn-sm ' + (item.scope === 'all' ? 'btn-danger' : ''), type: 'button',
        onclick: function () { clearLocalData(item, btn); }
      }, item.scope === 'all' ? '清除全部数据' : '清除' + item.label);
      clearActions.appendChild(el('div', { class: 'clear-row' },
        el('span', { class: 'label' }, item.label + (item.desc ? ' — ' + item.desc : '')),
        btn
      ));
    });
    right.appendChild(el('div', { class: 'panel danger-zone' },
      el('div', { class: 'panel-head' }, el('div', { class: 'panel-title' }, '清除本地数据'),
        el('span', { class: 'small faint' }, '需二次确认')),
      el('div', { class: 'panel-body stack' },
        el('div', { class: 'small muted' }, '清除操作不可恢复。建议确认已保存好需要的作业产物后再操作。'),
        clearActions
      )
    ));

    grid.appendChild(right);
  }

  function kv(k, v) {
    return el('div', { class: 'kv' }, el('span', { class: 'k' }, k), el('span', { class: 'v small' }, v));
  }

  async function clearLocalData(item, btn) {
    var ok = await confirmDialog({
      title: '清除本地数据 · ' + item.label,
      body: el('div', {},
        el('p', {}, '即将清除：' + item.label + '。'),
        item.desc ? el('p', { class: 'muted' }, item.desc) : null,
        el('p', { class: 'callout callout-danger' }, '此操作不可恢复，请再次确认。')
      ),
      okText: '确认清除',
      danger: true
    });
    if (!ok) return;
    setBtnBusy(btn, true);
    try {
      var res = await api('/api/privacy/clear', { method: 'POST', body: { scope: item.scope }, timeout: 60000 });
      if (res && res.ok === false) throw new ApiError(res.error || '清除失败');
      toast('已清除：' + item.label, 'ok');
      addLog('warn', '已清除本地数据：' + item.label);
      if (item.scope === 'all' || item.scope === 'session') {
        S.works = [];
        S.selected.clear();
        S.worksLoaded = false;
        if (item.scope === 'all') resetRunState();
      }
      await refreshState({ silent: true });
      await loadPrivacy();
      renderWorks();
      renderConnect();
    } catch (err) {
      toast('清除失败：' + errMsg(err), 'error');
    } finally {
      setBtnBusy(btn, false);
    }
  }

  async function openFolder(which) {
    try {
      var res = await api('/api/open-folder', { method: 'POST', body: { path: which, which: which }, timeout: 30000 });
      if (res && res.ok === false) throw new ApiError(res.error || '打开文件夹失败');
      toast(res && res.note ? '已请求打开：' + res.note : '已打开文件夹：' + folderName(which), 'ok');
    } catch (err) {
      toast('打开文件夹失败：' + errMsg(err), 'error');
    }
  }

  function folderName(which) {
    return ({ data: '数据目录', logs: '日志目录', materials: '资料目录' })[which] || which;
  }

  /* ======================== 启动 / 交互绑定 ======================== */

  function scrollToSection(id) {
    var node = document.getElementById(id);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function bindChrome() {
    $$('.quick-link').forEach(function (btn) {
      btn.addEventListener('click', function () { scrollToSection(btn.dataset.anchor); });
    });
    var refreshBtn = $('#refresh-state');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async function () {
        setBtnBusy(refreshBtn, true);
        try {
          var st = await refreshState({ silent: false });
          if (st) {
            await Promise.all([loadPrivacy(), loadSettings()]);
            if (isLoggedIn()) await loadWorks(true);
            toast('状态已刷新', 'ok');
          }
        } finally {
          setBtnBusy(refreshBtn, false);
        }
      });
    }
    var refreshWorksBtn = $('#btn-refresh-works');
    if (refreshWorksBtn) {
      refreshWorksBtn.addEventListener('click', function () { refreshWorks(refreshWorksBtn); });
    }
    window.addEventListener('unhandledrejection', function (e) {
      var msg = e && e.reason ? (e.reason.message || String(e.reason)) : '未知错误';
      toast('发生未处理的错误：' + msg, 'error');
    });
  }

  async function boot() {
    if (S.booted) return;
    S.booted = true;
    bindChrome();
    ensureLogPanel();
    startHeartbeat();
    connectSSE();

    var st = await refreshState({ silent: false });
    renderConnect();
    renderWorks();
    renderRun();
    renderSettings();

    if (st) {
      await Promise.all([loadPrivacy(), loadSettings()]);
      if (isLoggedIn()) loadWorks(true);
    } else {
      renderBanner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
