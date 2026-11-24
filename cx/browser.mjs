/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * browser.mjs — 本机 Edge 探测 + CDP 客户端 + 页面操作
 *
 * 设计与旧工具（可复用的程序\学习通自动作业\cx.mjs）一致：
 *   - 不装 Playwright/Selenium，直接 spawn 本机 msedge.exe 开调试端口，用 WebSocket 讲 CDP
 *   - 独立 profile 目录（由调用方传入，通常 <root>\data\edge-profile）
 *   - 自动接受 JS 对话框（作答页有"未提交离开"确认框，否则导航会卡死）
 *   - 端口被占用时自动换到下一个端口
 *
 * 注意（本会话沙箱）：spawn 必须用 { detached:true, stdio:'ignore' }，不能捕获子进程输出。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ensureDir } from './session.mjs';

export const EDGE_CANDIDATES = () => [
  process.env.CX_EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  'C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe',
].filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findEdge() {
  for (const p of EDGE_CANDIDATES()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  throw new Error('找不到 Microsoft Edge（msedge.exe），请确认已安装 Edge，或设置环境变量 CX_EDGE_PATH 指向 msedge.exe');
}

function tcpOpen(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

/** 读取 CDP /json/version；不是 CDP 服务返回 null */
export async function cdpInfo(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.webSocketDebuggerUrl ? j : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- CDP 客户端
export class Cdp {
  constructor(wsUrl, { log } = {}) {
    this.wsUrl = wsUrl;
    this.log = log || (() => {});
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = null;
    this.closed = false;
  }

  on(method, fn) {
    this.handlers.set(method, fn);
    return this;
  }

  async connect({ timeoutMs = 10000 } = {}) {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), timeoutMs);
      this.ws.addEventListener(
        'open',
        () => {
          clearTimeout(t);
          res();
        },
        { once: true }
      );
      this.ws.addEventListener(
        'error',
        () => {
          clearTimeout(t);
          rej(new Error('CDP WebSocket 连接失败（调试端口不可用）'));
        },
        { once: true }
      );
    });
    this.ws.addEventListener('message', (ev) => this._onMessage(ev));
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
    return this;
  }

  _onMessage(ev) {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!m.id && m.method) {
      // 页面 JS 对话框（含"未提交离开"确认框）一律自动确定，否则导航会一直挂住
      if (m.method === 'Page.javascriptDialogOpening') {
        const params = { accept: true };
        if (m.params && typeof m.params.promptText === 'string' && m.params.type === 'prompt') {
          params.promptText = m.params.defaultPrompt || '';
        }
        this.send('Page.handleJavaScriptDialog', params, m.sessionId, 5000).catch(() => {});
        return;
      }
      const fn = this.handlers.get(m.method);
      if (fn) {
        try {
          fn(m.params, m.sessionId);
        } catch (e) {
          this.log('CDP 事件处理异常:', m.method, e.message);
        }
      }
      return;
    }
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP 调用超时（${method}）`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          res(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
      try {
        this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        rej(new Error(`CDP 发送失败（${method}）：${e.message}`));
      }
    });
  }

  close() {
    try {
      this.ws && this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- Page（单个标签页）
export class Page {
  constructor(browser, { sessionId, targetId, url }) {
    this.browser = browser;
    this.sid = sessionId;
    this.targetId = targetId;
    this.initialUrl = url || '';
  }

  get cdp() {
    return this.browser.cdp;
  }

  get log() {
    return this.browser.log;
  }

  /** 在页面里执行 JS 并返回值；上下文被销毁时自动重连一次 */
  async eval(expression, { timeoutMs = 30000 } = {}) {
    const run = async () => {
      const r = await this.cdp.send(
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        this.sid,
        timeoutMs
      );
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        const desc = d.exception?.description || d.text || '未知异常';
        const err = new Error(`页面 JS 异常：${String(desc).split('\n')[0]}`);
        err.jsException = true;
        throw err;
      }
      return r.result?.value;
    };
    try {
      return await run();
    } catch (e) {
      if (/Cannot find context|Session closed|Target closed|Inspected target navigated/i.test(e.message)) {
        await this.browser.reattach(this);
        return run();
      }
      throw e;
    }
  }

  /** 执行 JS 并返回 JSON（页面里应 return JSON.stringify(...)） */
  async evalJson(expression, opts = {}) {
    const v = await this.eval(expression, opts);
    if (v == null || v === '') return null;
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch (e) {
      throw new Error(`页面返回的不是合法 JSON：${String(v).slice(0, 200)}`);
    }
  }

  async url() {
    return this.eval('location.href');
  }

  async title() {
    return this.eval('document.title');
  }

  async html() {
    return this.eval('document.documentElement.outerHTML');
  }

  async bodyText(maxLen = 4000) {
    const t = await this.eval(`(() => (document.body ? document.body.innerText : '').slice(0, ${Number(maxLen) || 4000}))()`);
    return String(t || '');
  }

  async readyState() {
    try {
      return await this.eval('document.readyState', { timeoutMs: 5000 });
    } catch {
      return 'loading';
    }
  }

  /** 导航并等待 readyState === 'complete'；JS 对话框会由 CDP 自动确认 */
  async navigate(url, { settleMs = 1200, timeoutMs = 45000 } = {}) {
    this.log('打开:', url);
    const go = async () => this.cdp.send('Page.navigate', { url }, this.sid, 20000);
    try {
      await go();
    } catch {
      await sleep(500);
      await this.cdp.send('Page.handleJavaScriptDialog', { accept: true }, this.sid, 5000).catch(() => {});
      await go();
    }
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(400);
      const st = await this.readyState();
      if (st === 'complete') break;
    }
    if (settleMs > 0) await sleep(settleMs);
    return this.url();
  }

  /** 轮询页面表达式直到返回真值（超时返回 null） */
  async waitFor(expression, { timeoutMs = 20000, intervalMs = 500 } = {}) {
    const t0 = Date.now();
    let lastVal = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        lastVal = await this.eval(expression, { timeoutMs: 8000 });
        if (lastVal) return lastVal;
      } catch {
        /* 导航中上下文可能被销毁，继续轮询 */
      }
      await sleep(intervalMs);
    }
    return null;
  }

  async screenshot(filePath) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sid, 20000);
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  /**
   * 注入 Cookie（浏览器会话过期但 session.json 还有效时用）。
   * 先试批量 Network.setCookies（带 url，成功率最高）；失败再逐条 Network.setCookie。
   * 失败会 log 一次（含 Cookie 名，不含值），不再静默返回 0。
   */
  async setCookies(cookies) {
    const list = (cookies || []).filter((c) => c && c.name);
    if (!list.length) return 0;
    await this.cdp.send('Network.enable', {}, this.sid, 10000).catch(() => {});
    const toParams = (c) => {
      const p = {
        name: c.name,
        value: c.value == null ? '' : String(c.value),
        domain: c.domain || '.chaoxing.com',
        path: c.path || '/',
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        url: 'https://i.chaoxing.com',
      };
      if (c.expires && c.expires > 0) p.expires = c.expires;
      return p;
    };
    // 1) 批量设置（一次 RPC）
    try {
      const r = await this.cdp.send('Network.setCookies', { cookies: list.map(toParams) }, this.sid, 15000);
      if (!r || r.success !== false) return list.length;
    } catch (e) {
      this.log('批量注入 Cookie 失败，改为逐条设置:', e.message);
    }
    // 2) 逐条设置；失败记录前 3 条错误名（不打印值）
    let n = 0;
    let failed = 0;
    for (const c of list) {
      try {
        const r = await this.cdp.send('Network.setCookie', toParams(c), this.sid, 8000);
        if (r && r.success !== false) n++;
        else {
          failed++;
          if (failed <= 3) this.log('setCookie 失败（success=false）:', c.name, String((r && r.success) || '').slice(0, 60));
        }
      } catch (e) {
        failed++;
        if (failed <= 3) this.log('setCookie 失败:', c.name, e.message);
      }
    }
    if (failed) this.log(`Cookie 注入：成功 ${n} 个，失败 ${failed} 个（浏览器内登录态可能不完整）`);
    return n;
  }
}

// ---------------------------------------------------------------- Browser
export class Browser {
  /**
   * @param {{port?:number, profileDir?:string, dataDir?:string, headless?:boolean, log?:Function}} opts
   */
  constructor({ port = Number(process.env.CX_PORT || 9333), profileDir, dataDir, headless = false, log } = {}) {
    this.basePort = Number(port) || 9333;
    this.port = this.basePort;
    this.profileDir = profileDir || path.join(dataDir || process.cwd(), 'edge-profile');
    this.dataDir = dataDir;
    this.headless = Boolean(headless);
    this.log = log || ((...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a));
    this.cdp = null;
    this.pageObj = null;
    this.exe = null;
    this.childPid = 0;
  }

  /** 确保浏览器在跑、CDP 已连接、有一个可用标签页 */
  async ensureStarted({ headless = this.headless } = {}) {
    if (this.cdp && !this.cdp.closed && this.pageObj) return this.pageObj;
    let info = await cdpInfo(this.port);
    if (!info) {
      info = await this.launch({ headless });
    } else {
      this.log('复用已运行的受控浏览器（端口', this.port, '）');
    }
    try {
      this.cdp = await new Cdp(info.webSocketDebuggerUrl, { log: this.log }).connect();
      this.pageObj = await this.attach({ preferUrlPart: 'chaoxing' });
      return this.pageObj;
    } catch (e) {
      this.close();
      throw new Error(
        `受控浏览器连接失败（${e.message}）。请关闭其他受控 Edge 后重试；若在受限沙箱中运行，浏览器自动化可能不可用，可改用 httpOnly 模式`
      );
    }
  }

  /** 结束本次启动的浏览器进程树（启动失败清理 / 测试收尾） */
  killLaunchedTree() {
    if (!this.childPid) return;
    try {
      spawn('taskkill', ['/PID', String(this.childPid), '/T', '/F'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {
      try {
        process.kill(this.childPid);
      } catch {
        /* ignore */
      }
    }
    this.childPid = 0;
  }

  async launch({ headless = this.headless } = {}) {
    this.exe = findEdge();
    ensureDir(this.profileDir);
    const MAX_PORT_ATTEMPTS = Math.max(1, Number(process.env.CX_PORT_ATTEMPTS || 3));
    const PER_PORT_MS = 12000; // 每个端口最多等 12 秒
    const TOTAL_MS = Math.max(PER_PORT_MS, Number(process.env.CX_LAUNCH_TIMEOUT_MS || 30000));
    const t0 = Date.now();
    let lastErr = '';
    for (let i = 0; i < MAX_PORT_ATTEMPTS && Date.now() - t0 < TOTAL_MS; i++) {
      const port = this.basePort + i;
      const existing = await cdpInfo(port);
      if (existing) {
        this.port = port;
        return existing;
      }
      if (await tcpOpen(port)) {
        lastErr = `端口 ${port} 已被其他程序占用`;
        continue;
      }
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=msEdgeSidebarV2',
        '--disable-session-crashed-bubble',
        'about:blank',
      ];
      if (headless) args.unshift('--headless=new');
      this.log('启动 Edge（端口', port + (headless ? '，无头' : '') + '）:', this.exe);
      try {
        // 注意：Edge/Chromium 需要有效的 stdout/stderr 句柄，纯 stdio:'ignore'（NUL）在部分受限环境
        // 会导致浏览器启动后立刻退出（0x80000003）。这里把输出重定向到日志文件，既保活又便于排障。
        let stdio = 'ignore';
        let logFd = 0;
        try {
          const logFile = path.join(this.profileDir, '..', 'edge-launch.log');
          ensureDir(path.dirname(logFile));
          logFd = fs.openSync(logFile, 'a');
          stdio = ['ignore', logFd, logFd];
        } catch {
          stdio = 'ignore';
        }
        const child = spawn(this.exe, args, { detached: true, stdio, windowsHide: true });
        this.childPid = child.pid || 0;
        if (logFd) {
          try {
            fs.closeSync(logFd);
          } catch {
            /* ignore */
          }
        }
        child.unref();
      } catch (e) {
        lastErr = e.message;
        continue;
      }
      const deadline = Math.min(Date.now() + PER_PORT_MS, t0 + TOTAL_MS);
      let ready = null;
      while (Date.now() < deadline) {
        await sleep(500);
        ready = await cdpInfo(port);
        if (ready) break;
      }
      if (ready) {
        this.port = port;
        return ready;
      }
      lastErr = `端口 ${port} 上浏览器调试接口未就绪（可能浏览器启动后立即退出）`;
      this.killLaunchedTree();
    }
    throw new Error(
      `Edge 无法启动调试端口（已尝试 ${MAX_PORT_ATTEMPTS} 个端口，${Math.round((Date.now() - t0) / 1000)} 秒）。` +
        `请关闭其他受控 Edge 或占用调试端口的程序后重试。${lastErr ? '最后错误：' + lastErr : ''}`
    );
  }

  /** 附着到某个标签页（prioritize URL 含 preferUrlPart 的页面） */
  async attach({ preferUrlPart = 'chaoxing' } = {}) {
    const { targetInfos = [] } = await this.cdp.send('Target.getTargets', {}, undefined, 10000);
    const pages = targetInfos.filter((t) => t.type === 'page');
    let hit = pages.find((p) => (p.url || '').includes(preferUrlPart)) || pages[0];
    if (!hit) {
      const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, 15000);
      hit = { targetId, url: 'about:blank' };
    }
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: hit.targetId, flatten: true }, undefined, 10000);
    await this.cdp.send('Page.enable', {}, sessionId, 10000).catch(() => {});
    await this.cdp.send('Runtime.enable', {}, sessionId, 10000).catch(() => {});
    return new Page(this, { sessionId, targetId: hit.targetId, url: hit.url });
  }

  /** 当前页；不存在则新建 */
  async page() {
    if (this.pageObj) return this.pageObj;
    return this.ensureStarted();
  }

  /** 页面被销毁后重新附着到同一个 target */
  async reattach(page) {
    try {
      const { sessionId } = await this.cdp.send(
        'Target.attachToTarget',
        { targetId: page.targetId, flatten: true },
        undefined,
        10000
      );
      await this.cdp.send('Page.enable', {}, sessionId, 10000).catch(() => {});
      await this.cdp.send('Runtime.enable', {}, sessionId, 10000).catch(() => {});
      page.sid = sessionId;
      return page;
    } catch (e) {
      this.pageObj = await this.attach();
      return this.pageObj;
    }
  }

  /** 收集浏览器里所有 Cookie（含 HttpOnly） */
  async cookies() {
    if (!this.cdp) throw new Error('浏览器还没启动');
    const { cookies = [] } = await this.cdp.send('Storage.getCookies', {}, undefined, 15000);
    return cookies;
  }

  /** 清空浏览器 Cookie（退出登录用） */
  async clearCookies() {
    if (!this.cdp) return;
    const page = this.pageObj;
    if (page) {
      await this.cdp.send('Network.enable', {}, page.sid, 10000).catch(() => {});
      await this.cdp.send('Network.clearBrowserCookies', {}, page.sid, 10000).catch(() => {});
    }
    await this.cdp.send('Storage.clearCookies', {}, undefined, 10000).catch(() => {});
  }

  async screenshot(filePath) {
    const page = await this.page();
    return page.screenshot(filePath);
  }

  close() {
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
      this.pageObj = null;
    }
  }

  /** 关闭 CDP 连接并结束本模块启动的浏览器进程（用于测试收尾；保留 profile） */
  async shutdown() {
    this.close();
    this.killLaunchedTree();
  }
}

export default Browser;
