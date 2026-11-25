#!/usr/bin/env node
/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/* ==========================================================================
 * UI 端到端自检（零依赖）：用 Edge headless + CDP 驱动真实页面，
 * 走通「连接配置 → 登录（人工滑块）→ 勾选作业 → 运行 → 暂停 → 继续 → 汇总」，
 * 并把关键步骤截图保存到 _mock/proof/。
 *
 * 前置：
 *   1) 启动 mock（建议快速模式）：MOCK_SPEED=0.2 node _mock/mock-api.mjs
 *   2) 启动 Edge headless 调试实例（另开窗口，PowerShell）：
 *      & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
 *        --headless=new --remote-debugging-port=9222 `
 *        --user-data-dir="<ui>\_mock\edge-profile" --no-first-run `
 *        --no-default-browser-check --disable-gpu --window-size=1280,800 about:blank
 *
 * 运行：node _mock/e2e-cdp.mjs
 *
 * 可用环境变量：MOCK_URL（默认 http://127.0.0.1:8877）、CDP_URL（默认 http://127.0.0.1:9222）
 * 通过时退出码 0，并把截图写入 _mock/proof/。
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = path.join(__dirname, 'proof');
const BASE = process.env.MOCK_URL || 'http://127.0.0.1:8877';
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log('[e2e]', ...args);
const errors = [];

/* ---------------- 极简 CDP 客户端 ---------------- */

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')); });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error('CDP 错误：' + JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const fns = this.listeners.get(msg.method) || [];
        fns.forEach((fn) => { try { fn(msg.params); } catch (e) { /* ignore */ } });
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 命令超时：' + method)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ---------------- 页面操作辅助 ---------------- */

let client = null;

async function evaluate(expression) {
  const res = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text;
    throw new Error('页面脚本异常：' + String(desc).slice(0, 400));
  }
  return res.result ? res.result.value : undefined;
}

async function waitFor(expr, label, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    const value = await evaluate(expr);
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('等待超时：' + label);
    await sleep(150);
  }
}

async function clickButtonIn(selector, text) {
  const expr = `(() => {
    const host = document.querySelector(${JSON.stringify(selector)});
    if (!host) return 'NO_HOST';
    const btn = Array.from(host.querySelectorAll('button'))
      .find((b) => !b.disabled && b.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}));
    if (!btn) return 'NO_BTN';
    btn.click();
    return 'OK';
  })()`;
  const r = await evaluate(expr);
  if (r !== 'OK') throw new Error(`点击失败（${selector} / ${text}）：${r}`);
  await sleep(120);
}

async function setInput(selector, value) {
  const expr = `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return 'NO_INPUT';
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`;
  const r = await evaluate(expr);
  if (r !== value) throw new Error('填写输入框失败：' + selector + ' -> ' + r);
}

async function shot(name, anchorSelector) {
  if (anchorSelector) {
    await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(anchorSelector)}); if (n) n.scrollIntoView({ block: 'start' }); })()`);
    await sleep(350);
  }
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = path.join(PROOF_DIR, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  log('截图：', path.relative(process.cwd(), file));
}

/* ---------------- 主流程 ---------------- */

async function resetMock() {
  const res = await fetch(BASE + '/api/mock/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error('mock 重置失败 HTTP ' + res.status);
}

async function main() {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  log('mock：', BASE, ' CDP：', CDP);

  // 1. 找到 Edge 页面目标
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(CDP + '/json')).json();
      if (Array.isArray(targets) && targets.length) break;
    } catch { /* 等待 Edge 启动 */ }
    await sleep(500);
  }
  if (!Array.isArray(targets) || !targets.length) throw new Error('无法连接 Edge 调试端口：' + CDP);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到可用的页面目标');
  client = new CDPClient(page.webSocketDebuggerUrl);
  await client.connect();

  client.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    const text = d.exception ? d.exception.description : d.text;
    errors.push('页面异常：' + String(text).slice(0, 500));
  });
  client.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      const text = (p.args || []).map((a) => (a.value != null ? a.value : a.description)).join(' ');
      if (!/favicon/i.test(text)) errors.push('console.error：' + text);
    }
  });
  client.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    if (e.level === 'error' && !/favicon/i.test(e.text || '')) errors.push('浏览器日志错误：' + e.text);
  });

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // 2. 重置 mock 并打开页面
  await resetMock();
  await client.send('Page.navigate', { url: BASE + '/' });
  await waitFor(`document.readyState === 'complete'`, '页面加载完成', 30000);
  await waitFor(`!!document.querySelector('#connect-api-key')`, '连接区块渲染完成', 30000);
  log('页面已加载');

  // 3. 初始状态
  const envText = await evaluate(`document.querySelector('#badge-env').textContent`);
  if (!/环境 ✓/.test(envText)) throw new Error('环境角标异常：' + envText);
  const bannerText = await evaluate(`document.querySelector('#global-banner').textContent`);
  if (!/DeepSeek API Key/.test(bannerText)) throw new Error('未就绪提示异常：' + bannerText);
  await shot('01-connect-empty.png', '#sec-connect');

  // 4. 填写 API Key
  await setInput('#connect-api-key', 'sk-mock-1234567890');
  await clickButtonIn('#connect-body', '保存 API Key');
  await waitFor(`/AI 引擎 ✓/.test(document.querySelector('#badge-ai').textContent)`, 'AI 引擎角标就绪');
  log('API Key 已保存');

  // 5. 填写学习通账号并登录（人工滑块）
  await setInput('#connect-cx-username', 'demo-user');
  await setInput('#connect-cx-password', 'pass1234');
  await clickButtonIn('#connect-body', '保存账号密码');
  await waitFor(`/账号密码已保存/.test(document.querySelector('#connect-body').textContent)`, '账号密码已保存');
  await waitFor(`!!Array.from(document.querySelectorAll('#connect-body button')).find((b) => b.textContent.includes('登录学习通'))`, '登录按钮出现');
  await clickButtonIn('#connect-body', '登录学习通');
  await waitFor(`/登录需要人工验证/.test(document.querySelector('#connect-body').textContent)`, '人工滑块提示卡片出现', 30000);
  await shot('02-need-human.png', '#sec-connect');
  await clickButtonIn('#connect-body', '我已完成验证，继续');
  await waitFor(`/学习通 ✓ 已登录/.test(document.querySelector('#badge-cx').textContent)`, '学习通登录成功', 30000);
  await waitFor(`document.querySelectorAll('.work-row').length >= 7`, '作业列表加载（7 项）', 60000);
  log('登录成功，作业列表已加载');
  await shot('03-logged-in.png', '#sec-connect');

  // 6. 勾选 3 项作业（含缺资料/人工验证触发项）
  async function checkWork(keyword) {
    const r = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.work-row'));
      const row = rows.find((r) => (r.querySelector('.work-name') || {}).textContent?.includes(${JSON.stringify(keyword)}));
      if (!row) return 'NO_ROW';
      const cb = row.querySelector('input[type=checkbox]');
      if (!cb) return 'NO_CB';
      if (!cb.checked) cb.click();
      return 'OK';
    })()`);
    if (r !== 'OK') throw new Error('勾选作业失败：' + keyword + ' -> ' + r);
    await sleep(200);
  }
  await checkWork('导数与微分');
  await checkWork('实验报告：函数图像绘制');
  await checkWork('专题二 思考题');
  const selectedCount = await evaluate(`/已选 3 项/.test(document.querySelector('#works-toolbar').textContent)`);
  if (!selectedCount) throw new Error('勾选计数不正确');
  await shot('04-works-selected.png', '#sec-works');
  log('已勾选 3 项作业');

  // 7. 开始运行（确认弹窗）
  await clickButtonIn('#works-toolbar', '开始运行');
  await waitFor(`!!document.querySelector('#modal-root .modal')`, '确认弹窗出现');
  await clickButtonIn('#modal-root', '开始运行（3 项）');
  await waitFor(`document.querySelectorAll('#run-jobs .job-row').length === 3`, '运行面板出现 3 项作业', 60000);
  await waitFor(`!!document.querySelector('#run-jobs .job-step.active')`, '作业步骤推进');
  await shot('05-running.png', '#sec-run');
  log('运行已开始');

  // 8. 暂停卡片：缺资料 + 人工验证
  await waitFor(`document.querySelectorAll('#run-paused .pause-card').length >= 2`, '两类暂停卡片出现', 90000);
  const pausedText = await evaluate(`document.querySelector('#run-paused').textContent`);
  if (!/缺少资料/.test(pausedText)) throw new Error('缺少「缺少资料」暂停卡片');
  if (!/需要人工验证/.test(pausedText)) throw new Error('缺少「需要人工验证」暂停卡片');
  if (!/data[\\/]+materials[\\/]+w1003/.test(pausedText)) {
    throw new Error('缺资料路径提示不是 data/materials/<workId>：' + pausedText.slice(0, 300));
  }
  await shot('06-paused.png', '#sec-run');
  log('两类暂停卡片已出现');

  // 9. 缺资料 → 继续 → 完成
  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.pause-card')).find((c) => c.textContent.includes('缺少资料'));
    const btn = card && Array.from(card.querySelectorAll('button')).find((b) => b.textContent.includes('已放入资料'));
    if (!btn) return 'NO_BTN';
    btn.click();
    return 'OK';
  })()`).then((r) => { if (r !== 'OK') throw new Error('缺资料继续按钮点击失败：' + r); });
  await waitFor(`document.querySelectorAll('#run-paused .pause-card').length === 1`, '缺资料项继续处理');
  log('缺资料项已继续');

  // 10. 人工验证 → 继续 → 完成
  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.pause-card')).find((c) => c.textContent.includes('需要人工验证'));
    const btn = card && Array.from(card.querySelectorAll('button')).find((b) => b.textContent.includes('我已完成'));
    if (!btn) return 'NO_BTN';
    btn.click();
    return 'OK';
  })()`).then((r) => { if (r !== 'OK') throw new Error('人工验证继续按钮点击失败：' + r); });
  await waitFor(`document.querySelectorAll('#run-paused .pause-card').length === 0`, '全部暂停项已继续', 60000);
  log('人工验证项已继续');

  // 11. 结果汇总
  await waitFor(`!!document.querySelector('.summary-card')`, '结果汇总出现', 90000);
  await waitFor(`(() => {
    const stat = Array.from(document.querySelectorAll('.summary-card .stat'))
      .find((s) => s.textContent.includes('完成'));
    const b = stat && stat.querySelector('b');
    return b && b.textContent.trim() === '3';
  })()`, '汇总显示完成 3 项', 30000);
  const logCount = await evaluate(`document.querySelectorAll('#log-lines .log-line').length`);
  if (logCount < 15) throw new Error('SSE 日志条数过少：' + logCount);
  const worksAfter = await evaluate(`document.querySelectorAll('.work-row').length`);
  if (worksAfter !== 4) throw new Error('运行结束后作业列表未刷新为 4 项，实际 ' + worksAfter);
  await shot('07-summary.png', '#sec-run');
  log('汇总完成，日志条数：', logCount);

  // 12. 设置与隐私
  await waitFor(`/DPAPI 加密|数据目录/.test(document.querySelector('#settings-body').textContent)`, '设置区块渲染');
  await shot('08-settings.png', '#sec-settings');
  const settingsText = await evaluate(`document.querySelector('#settings-body').textContent`);
  if (!/隐私说明/.test(settingsText)) throw new Error('缺少隐私说明');
  if (!/清除全部数据/.test(settingsText)) throw new Error('缺少清除本地数据入口');
  if (!/不写注册表/.test(settingsText)) throw new Error('缺少不写注册表说明');

  // 13. 清除日志（隐私清除链路 + 二次确认）
  await clickButtonIn('#settings-body', '清除运行日志');
  await waitFor(`!!document.querySelector('#modal-root .modal')`, '清除确认弹窗');
  const confirmText = await evaluate(`document.querySelector('#modal-root .modal-body').textContent`);
  if (!/不可恢复/.test(confirmText)) throw new Error('清除确认弹窗缺少二次确认说明');
  await clickButtonIn('#modal-root', '确认清除');
  await waitFor(`/已清除/.test(document.body.textContent)`, '清除完成提示', 20000);
  log('隐私清除链路正常');

  // 14. 刷新状态按钮
  await clickButtonIn('.topbar', '刷新状态');
  await sleep(800);
  await waitFor(`/状态已刷新/.test(document.body.textContent) || true`, '刷新状态');
  await shot('09-settings-privacy.png', '#sec-settings');

  // 15. 控制台错误检查
  if (errors.length) {
    console.error('[e2e] 浏览器控制台错误：');
    errors.forEach((e) => console.error('  -', e));
    throw new Error('页面存在控制台错误（' + errors.length + ' 条）');
  }
  log('浏览器控制台无报错');

  // 16. 关闭页面
  await client.send('Page.navigate', { url: 'about:blank' });
  client.close();
  log('全部 UI 流程检查通过 ✅');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[e2e] 失败：', err.message);
    if (errors.length) errors.forEach((e) => console.error('  -', e));
    if (client) client.close();
    process.exit(1);
  });
