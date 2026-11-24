#!/usr/bin/env node
/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/* ==========================================================================
 * 学习通作业助手 · 本地 mock API（零依赖，仅 Node.js 内置模块）
 *
 * 用途：在没有真实 app\server.mjs 的情况下预览、演示并验证 ui\ 的全部交互。
 * 启动：node _mock/mock-api.mjs
 * 打开：http://127.0.0.1:8877/
 *
 * 实现设计说明 5.3 的全部端点 + 新增隐私端点 + SSE 事件：
 *   登录（含需要人工滑块）→ 作业列表 → 运行 → 暂停（缺资料 / 人工验证）
 *   → 继续 → 完成汇总
 *
 * 绿色版说明：环境由「环境准备.cmd」准备，mock 默认视为已就绪（不再模拟安装进度）。
 *
 * 环境变量：
 *   MOCK_PORT   监听端口（默认 8877）
 *   MOCK_SPEED  时间倍率（默认 1；0.2 = 快 5 倍，便于自动化测试）
 *
 * 额外提供（仅 mock）：POST /api/mock/reset  重置全部演示数据。
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..');
const MOCK_DATA_DIR = path.join(__dirname, 'data');
const PORT = Number(process.env.MOCK_PORT || 8877);
const SPEED = (() => {
  const v = Number(process.env.MOCK_SPEED || 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(1, Math.round(ms * SPEED))));
const log = (...args) => console.log('[mock]', ...args);
const rand = (min, max) => min + Math.random() * (max - min);

/* ======================== 演示数据 ======================== */

const COURSES = [
  { courseId: 'c1', classId: 'cls-2026-1001', cpi: 'mock-cpi-1001', name: '高等数学（上）', entryUrl: 'https://mooc1.chaoxing.com/mycourse/studentcourse?courseId=c1' },
  { courseId: 'c2', classId: 'cls-2026-1002', cpi: 'mock-cpi-1002', name: '大学英语 II', entryUrl: 'https://mooc1.chaoxing.com/mycourse/studentcourse?courseId=c2' },
  { courseId: 'c3', classId: 'cls-2026-1003', cpi: 'mock-cpi-1003', name: '中国近现代史纲要', entryUrl: 'https://mooc1.chaoxing.com/mycourse/studentcourse?courseId=c3' },
  { courseId: 'c4', classId: 'cls-2026-1004', cpi: 'mock-cpi-1004', name: '计算机基础', entryUrl: 'https://mooc1.chaoxing.com/mycourse/studentcourse?courseId=c4' },
];

const WORKS = [
  { workId: 'w1001', courseId: 'c1', courseName: '高等数学（上）', name: '第三章 导数与微分 单元测验', status: '未提交', left: '剩余 2 天 3 小时', kind: 'quiz', url: 'https://mooc1.chaoxing.com/work/w1001' },
  { workId: 'w1002', courseId: 'c1', courseName: '高等数学（上）', name: '第四章 不定积分 课后作业', status: '待重做', left: '剩余 3 天', kind: 'quiz', url: 'https://mooc1.chaoxing.com/work/w1002' },
  { workId: 'w1003', courseId: 'c1', courseName: '高等数学（上）', name: '实验报告：函数图像绘制与误差分析', status: '未提交', left: '剩余 5 天', kind: 'attach', url: 'https://mooc1.chaoxing.com/work/w1003' },
  { workId: 'w2001', courseId: 'c2', courseName: '大学英语 II', name: 'Unit 5 Translation Practice', status: '未提交', left: '剩余 1 天 6 小时', kind: 'mixed', url: 'https://mooc1.chaoxing.com/work/w2001' },
  { workId: 'w2002', courseId: 'c2', courseName: '大学英语 II', name: 'Unit 6 Writing: Argumentative Essay', status: '未提交', left: '剩余 4 天', kind: 'attach', url: 'https://mooc1.chaoxing.com/work/w2002' },
  { workId: 'w3001', courseId: 'c3', courseName: '中国近现代史纲要', name: '专题二 思考题（简答）', status: '未提交', left: '剩余 12 小时', kind: 'mixed', url: 'https://mooc1.chaoxing.com/work/w3001' },
  { workId: 'w4001', courseId: 'c4', courseName: '计算机基础', name: 'Excel 函数与数据处理 实操作业', status: '未提交', left: '剩余 2 天 8 小时', kind: 'attach', url: 'https://mooc1.chaoxing.com/work/w4001' },
];

/* ======================== 运行时状态 ======================== */

const DATA = {
  aiKey: '',
  username: '',
  password: '',
  loggedIn: false,
  uid: null,
  loginAt: null,
  installRunning: false,
  loginPendingHuman: false,
  loginAttempts: 0,
};

const st = {
  setup: {
    // 免安装绿色版：环境由「环境准备.cmd」准备，mock 默认已就绪
    dsh: { installed: true, version: '0.1.7-rc.2' },
    ai: { configured: false },
    chaoxing: { configured: false, loggedIn: false, uid: null },
  },
  settings: { autoSubmit: true, model: 'deepseek-chat', port: 8765, concurrency: 1, timeoutMin: 10 },
};

const completed = new Set();
const materialsProvided = new Set();
const humanVerified = new Set();

/** workId -> job 记录 */
const jobs = new Map();

const run = {
  active: false,
  processing: false,
  paused: false,
  stop: false,
  queue: [],
  retry: [],
  startedAt: 0,
};

/* ======================== SSE ======================== */

const sseClients = new Set();

function sseWrite(res, obj) {
  try {
    res.write('data: ' + JSON.stringify({ ts: now(), ...obj }) + '\n\n');
  } catch (err) {
    /* 客户端已断开，忽略 */
  }
}

function emit(obj) {
  sseClients.forEach((res) => sseWrite(res, obj));
}

function emitLog(level, message, workId) {
  emit({ type: 'log', level, message, workId: workId || null });
  log('log:', String(message).slice(0, 120));
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  sseWrite(res, { type: 'hello', phase: computePhase(), mock: true });
  const ping = setInterval(() => sseWrite(res, { type: 'ping' }), 15000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

/* ======================== 状态派生 ======================== */

function computePhase() {
  const ready = st.setup.dsh.installed && !!DATA.aiKey && !!(DATA.username && DATA.password) && DATA.loggedIn;
  if (!ready) return 'setup';
  return run.active ? 'running' : 'idle';
}

function currentWorks() {
  return WORKS.filter((w) => !completed.has(w.workId)).map((w) => ({ ...w }));
}

function slimJob(j) {
  return {
    workId: j.workId,
    name: j.name,
    courseName: j.courseName,
    status: j.status,
    progress: j.progress || 0,
    step: j.step || null,
    updatedAt: j.updatedAt || now(),
    result: j.result || null,
  };
}

function stateJobs() {
  return Array.from(jobs.values()).map(slimJob);
}

function statePaused() {
  return Array.from(jobs.values())
    .filter((j) => j.status === 'paused' && j.paused)
    .map((j) => ({
      workId: j.workId,
      name: j.name,
      courseName: j.courseName,
      kind: j.paused.kind,
      reason: j.paused.reason,
      detail: j.paused.detail || null,
      createdAt: j.paused.createdAt,
    }));
}

function publicState() {
  return {
    phase: computePhase(),
    running: run.active,
    setup: {
      dsh: { installed: !!st.setup.dsh.installed, version: st.setup.dsh.version || null },
      ai: { configured: !!DATA.aiKey },
      chaoxing: { configured: !!(DATA.username && DATA.password), loggedIn: DATA.loggedIn, uid: DATA.uid },
    },
    session: { loggedIn: DATA.loggedIn, uid: DATA.uid, savedAt: DATA.loginAt },
    jobs: stateJobs(),
    paused: statePaused(),
    settings: { ...st.settings },
    dataDir: MOCK_DATA_DIR,
    logDir: path.join(MOCK_DATA_DIR, 'logs'),
    mock: true,
  };
}

/* ======================== 环境（绿色版：默认已就绪） ======================== */

function simulateInstall() {
  // 免安装绿色版：环境由「环境准备.cmd」在程序目录内准备，mock 默认视为已就绪。
  st.setup.dsh.installed = true;
  st.setup.dsh.version = '0.1.7-rc.2';
  emit({ type: 'install-done', ok: true, version: '0.1.7-rc.2' });
  emitLog('info', '运行环境已就绪（免安装绿色版，mock）');
}

/* ======================== 登录 ======================== */

async function handleLoginStart() {
  if (!(DATA.username && DATA.password)) {
    return { code: 400, body: { ok: false, error: '请先保存学习通账号密码' } };
  }
  DATA.loginAttempts += 1;

  if (!DATA.loggedIn && !DATA.loginPendingHuman) {
    DATA.loginPendingHuman = true;
    emitLog('step', '正在打开学习通登录页…');
    emit({ type: 'need-human', scene: 'login', reason: '学习通要求滑块验证：请在自动打开的浏览器窗口中完成滑动验证，然后点「我已完成验证，继续」。', screenshotPath: path.join(MOCK_DATA_DIR, 'jobs', 'login-slider.png') });
    emitLog('warn', '登录需要人工滑块验证');
    return { code: 200, body: { started: true, needHuman: true } };
  }

  if (DATA.loginPendingHuman) {
    await sleep(1200);
    DATA.loginPendingHuman = false;
    DATA.loggedIn = true;
    DATA.uid = 'mock-uid-10086';
    DATA.loginAt = now();
    st.setup.chaoxing.loggedIn = true;
    st.setup.chaoxing.uid = DATA.uid;
    emit({ type: 'login-done', ok: true, uid: DATA.uid });
    emitLog('ok', '学习通登录成功（mock 账号 uid: ' + DATA.uid + '）');
    return { code: 200, body: { started: true, already: false, loggedIn: true, uid: DATA.uid } };
  }

  return { code: 200, body: { started: true, already: true, loggedIn: true } };
}

/* ======================== 运行模拟 ======================== */

function ensureJob(workId) {
  const work = WORKS.find((w) => w.workId === workId);
  if (!work) return null;
  let rec = jobs.get(workId);
  if (!rec) {
    rec = {
      workId,
      name: work.name,
      courseName: work.courseName,
      status: 'queued',
      progress: 0,
      step: null,
      steps: [],
      questions: mockQuestions(work),
      answers: null,
      files: [],
      result: null,
      paused: null,
      error: null,
      updatedAt: now(),
    };
    jobs.set(workId, rec);
  }
  return rec;
}

function mockQuestions(work) {
  if (work.kind === 'attach') {
    return [
      { qid: work.workId + '-1', type: 'attach', stem: '请根据题目要求撰写实验报告，并上传 .docx 文件。', opts: [], required: true },
      { qid: work.workId + '-2', type: 'short', stem: '简述误差分析的主要结论（200 字以内）。', opts: [], required: false },
    ];
  }
  const bank = [
    { type: 'single', stem: '设函数 f(x)=x²+2x，则 f′(1) 的值为（ ）', opts: [{ key: 'A', text: '2' }, { key: 'B', text: '3' }, { key: 'C', text: '4' }, { key: 'D', text: '5' }] },
    { type: 'judge', stem: '可导函数一定连续。', opts: [] },
    { type: 'blank', stem: '若 y = sin x，则 y′ = ____ 。', blanks: ['cos x'] },
    { type: 'single', stem: '下列函数在 x=0 处不可导的是（ ）', opts: [{ key: 'A', text: 'y=x²' }, { key: 'B', text: 'y=|x|' }, { key: 'C', text: 'y=sin x' }, { key: 'D', text: 'y=eˣ' }] },
  ];
  return bank.slice(0, 3).map((q, i) => ({ qid: work.workId + '-' + (i + 1), ...q, required: true }));
}

function mockAnswers(work) {
  if (work.kind === 'attach') {
    return { [work.workId + '-1']: '（附件）实验报告.docx', [work.workId + '-2']: '误差主要来源于测量数据的舍入与绘图比例尺选择，整体相对误差小于 2%。' };
  }
  return { [work.workId + '-1']: 'C', [work.workId + '-2']: '对', [work.workId + '-3']: ['cos x'] };
}

function buildSummary() {
  const list = Array.from(jobs.values());
  return {
    total: list.length,
    done: list.filter((j) => j.status === 'done').length,
    paused: list.filter((j) => j.status === 'paused').length,
    failed: list.filter((j) => j.status === 'failed').length,
    results: list.map((j) => ({
      workId: j.workId,
      name: j.name,
      status: j.status,
      score: j.result ? j.result.score : null,
      message: j.result ? j.result.message : (j.paused ? j.paused.reason : ''),
    })),
  };
}

function pushStep(rec, name, status, message) {
  const item = { name, status, message: message || '', ts: now() };
  rec.steps.push(item);
  return item;
}

function emitStep(rec, key, label, status, progress) {
  rec.step = key;
  rec.status = 'running';
  rec.progress = Math.max(rec.progress, progress || 0);
  rec.updatedAt = now();
  emit({ type: 'step', workId: rec.workId, step: key, name: label, status, progress: rec.progress });
}

async function waitIfPaused() {
  while (run.paused && !run.stop) await sleep(250);
  return !run.stop;
}

async function runOneJob(workId, isRetry) {
  const rec = jobs.get(workId);
  if (!rec || run.stop) return;
  const work = WORKS.find((w) => w.workId === workId);
  const resumeFrom = isRetry ? rec.resumeFrom || 'solve' : null;
  rec.status = 'running';
  rec.updatedAt = now();
  emit({
    type: 'job-start',
    workId,
    name: rec.name,
    courseName: rec.courseName,
    step: resumeFrom || 'fetch',
    message: isRetry ? '继续处理' : '开始处理',
  });
  emitLog('step', `【${rec.name}】${isRetry ? '继续' : '开始'}处理`, workId);
  if (!isRetry) pushStep(rec, '取题', 'done', '已打开作答页并获取题目');

  const plan = isRetry
    ? (resumeFrom === 'fill' ? ['fill', 'submit'] : ['solve', 'fill', 'submit'])
    : ['fetch', 'solve', 'fill', 'submit'];
  const labels = { fetch: '取题', solve: '求解', fill: '填写', submit: '提交' };
  const progressMap = { fetch: 20, solve: 55, fill: 80, submit: 95 };

  for (let i = 0; i < plan.length; i++) {
    const key = plan[i];
    if (!(await waitIfPaused())) return;
    emitStep(rec, key, labels[key], 'running', Math.max(0, (progressMap[key] || 0) - 12));
    emitLog('info', `【${rec.name}】${labels[key]}…`, workId);
    await sleep(key === 'solve' ? rand(1400, 1900) : rand(650, 950));
    if (!(await waitIfPaused())) return;

    // 步骤内的暂停点
    if (key === 'solve' && workId === 'w1003' && !materialsProvided.has(workId)) {
      rec.status = 'paused';
      rec.resumeFrom = 'solve';
      rec.paused = {
        kind: 'materials',
        reason: '第 3 题需要「函数图像实验数据.csv」才能完成误差分析，但题目附件中未提供该数据文件。',
        detail: { folder: 'materials\\' + workId, file: '函数图像实验数据.csv' },
        createdAt: now(),
      };
      rec.updatedAt = now();
      pushStep(rec, '求解', 'paused', rec.paused.reason);
      emit({ type: 'job-paused', workId, name: rec.name, courseName: rec.courseName, kind: 'materials', reason: rec.paused.reason, detail: rec.paused.detail });
      emitLog('warn', `【${rec.name}】缺少资料，已暂停，等待补充后继续`, workId);
      return;
    }
    if (key === 'fill' && workId === 'w3001' && !humanVerified.has(workId)) {
      rec.status = 'paused';
      rec.resumeFrom = 'fill';
      rec.paused = {
        kind: 'human',
        reason: '提交前学习通要求输入图形验证码；请在自动打开的浏览器窗口中完成验证码校验。',
        detail: null,
        createdAt: now(),
      };
      rec.updatedAt = now();
      pushStep(rec, '填写', 'paused', rec.paused.reason);
      emit({ type: 'job-paused', workId, name: rec.name, courseName: rec.courseName, kind: 'human', reason: rec.paused.reason, detail: null });
      emitLog('warn', `【${rec.name}】需要人工验证码，已暂停`, workId);
      return;
    }

    emitStep(rec, key, labels[key], 'done', progressMap[key]);
    pushStep(rec, labels[key], 'done', '');
    emitLog('info', `【${rec.name}】${labels[key]}完成`, workId);
  }

  const score = Math.round(rand(82, 100));
  rec.status = 'done';
  rec.progress = 100;
  rec.step = 'submit';
  rec.answers = mockAnswers(work);
  rec.files = work.kind === 'attach'
    ? [{ name: '实验报告.docx', path: `data\\jobs\\${workId}\\实验报告.docx` }]
    : [];
  rec.result = { ok: true, score, message: '已提交' };
  rec.updatedAt = now();
  completed.add(workId);
  pushStep(rec, '提交', 'done', `已提交，得分 ${score}`);
  emit({ type: 'job-done', workId, ok: true, result: rec.result, name: rec.name, courseName: rec.courseName });
  emitLog('ok', `【${rec.name}】已完成并提交（得分 ${score}）`, workId);
}

async function processQueue() {
  if (run.processing) return;
  run.processing = true;
  if (run.queue.length || run.retry.length) {
    run.active = true;
    run.startedAt = run.startedAt || now();
  }
  try {
    while (!run.stop) {
      if (run.paused) {
        await sleep(250);
        continue;
      }
      let workId = null;
      let isRetry = false;
      if (run.queue.length) { workId = run.queue.shift(); isRetry = false; }
      else if (run.retry.length) { workId = run.retry.shift(); isRetry = true; }
      if (!workId) break;
      await runOneJob(workId, isRetry);
    }
  } catch (err) {
    emitLog('error', '运行模拟异常：' + String(err && err.message ? err.message : err));
  } finally {
    run.processing = false;
  }

  const idle = !run.queue.length && !run.retry.length;
  if (run.stop) {
    run.active = false;
    run.stop = false;
    emit({ type: 'run-stopped' });
    emitLog('warn', '运行已停止');
    emit({ type: 'run-done', stopped: true, summary: buildSummary() });
  } else if (idle) {
    run.active = false;
    const summary = buildSummary();
    emit({ type: 'run-done', summary });
    emitLog('ok', `运行结束：共 ${summary.total} 项，完成 ${summary.done}，暂停 ${summary.paused}，失败 ${summary.failed}`);
  }
}

function startRun(workIds) {
  if (run.active || run.processing) return { started: false, error: '已有任务在运行' };
  if (!DATA.loggedIn) throw new HttpError(400, '请先登录学习通');
  const available = new Set(currentWorks().map((w) => w.workId));
  const invalid = workIds.filter((id) => !available.has(id));
  if (!workIds.length) throw new HttpError(400, '请先勾选要运行的作业');
  if (invalid.length) throw new HttpError(400, '以下作业不在未完成列表中：' + invalid.join(', '));

  jobs.clear();
  completed.clear();
  materialsProvided.clear();
  humanVerified.clear();
  run.active = true;
  run.stop = false;
  run.paused = false;
  run.queue = workIds.slice();
  run.retry = [];
  run.startedAt = now();
  workIds.forEach((id) => {
    const rec = ensureJob(id);
    if (rec) { rec.status = 'queued'; rec.progress = 0; rec.steps = []; rec.paused = null; rec.result = null; }
  });
  emit({ type: 'run-start', total: workIds.length, workIds: workIds.slice() });
  emitLog('step', `开始运行 ${workIds.length} 项作业（顺序执行，避免风控）`);
  processQueue().catch((err) => emitLog('error', '队列异常：' + String(err)));
  return { started: true, workIds: workIds.slice() };
}

/* ======================== HTTP 工具 ======================== */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status || 500;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new HttpError(413, '请求体过大'));
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const resolved = path.resolve(UI_DIR, '.' + rel);
  const outside = resolved !== UI_DIR && !resolved.startsWith(UI_DIR + path.sep);
  if (outside) {
    sendText(res, 403, '403 Forbidden');
    return;
  }
  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      // 未找到静态文件时回退到 index.html（SPA 路由）
      if (!path.extname(rel)) {
        const index = path.join(UI_DIR, 'index.html');
        fs.readFile(index, (e2, buf) => {
          if (e2) return sendText(res, 404, '404 Not Found');
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
          res.end(buf);
        });
        return;
      }
      sendText(res, 404, '404 Not Found');
      return;
    }
    fs.readFile(resolved, (e, buf) => {
      if (e) return sendText(res, 500, '500 读取文件失败');
      const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
}

/* ======================== 路由 ======================== */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method || 'GET';

  /* ---- 状态 ---- */
  if (method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, publicState());
  }

  /* ---- 配置向导 ---- */
  if (method === 'POST' && p === '/api/setup/install') {
    // 绿色版不再需要安装；保留端点兼容旧调用，直接返回已就绪。
    simulateInstall();
    return sendJson(res, 200, { started: true, alreadyInstalled: true });
  }
  if (method === 'POST' && p === '/api/setup/ai-key') {
    const body = await readBody(req);
    const key = String(body.apiKey || '').trim();
    if (key.length < 8) return sendJson(res, 400, { ok: false, error: 'API Key 无效（至少 8 个字符）' });
    await sleep(350);
    if (!/^sk-[A-Za-z0-9_\-]{6,}$/.test(key) && !key.startsWith('mock-')) {
      return sendJson(res, 400, { ok: false, error: 'API Key 格式不正确：应以 sk- 开头' });
    }
    DATA.aiKey = key;
    st.setup.ai.configured = true;
    emitLog('ok', 'DeepSeek API Key 已保存（mock，不落盘、不回显）');
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/setup/chaoxing') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return sendJson(res, 400, { ok: false, error: '学习通账号和密码不能为空' });
    await sleep(350);
    DATA.username = username;
    DATA.password = password;
    st.setup.chaoxing.configured = true;
    emitLog('ok', '学习通账号密码已保存（mock，不落盘、不回显）');
    return sendJson(res, 200, { ok: true, configured: true });
  }
  if (method === 'POST' && p === '/api/login/start') {
    const r = await handleLoginStart();
    return sendJson(res, r.code, r.body);
  }
  if (method === 'POST' && p === '/api/logout') {
    DATA.loggedIn = false;
    DATA.uid = null;
    DATA.loginPendingHuman = false;
    DATA.loginAt = null;
    st.setup.chaoxing.loggedIn = false;
    st.setup.chaoxing.uid = null;
    emitLog('warn', '已退出学习通登录（mock）');
    return sendJson(res, 200, { ok: true });
  }

  /* ---- 课程与作业 ---- */
  if (method === 'GET' && p === '/api/courses') {
    await sleep(300);
    const works = currentWorks();
    const courses = COURSES.map((c) => {
      const all = WORKS.filter((w) => w.courseId === c.courseId);
      const pending = works.filter((w) => w.courseId === c.courseId);
      return { ...c, works: { total: all.length, pending: pending.length } };
    });
    return sendJson(res, 200, { courses });
  }
  if (method === 'GET' && p === '/api/works') {
    await sleep(300);
    return sendJson(res, 200, { works: currentWorks() });
  }
  if (method === 'POST' && p === '/api/works/refresh') {
    const body = await readBody(req);
    emitLog('step', '正在重新拉取课程与作业列表（mock）' + (body.courseId ? '，课程 ' + body.courseId : ''));
    await sleep(900);
    return sendJson(res, 200, { ok: true, count: currentWorks().length });
  }

  /* ---- 运行控制 ---- */
  if (method === 'POST' && p === '/api/run') {
    const body = await readBody(req);
    const workIds = Array.isArray(body.workIds) ? body.workIds.map(String) : [];
    const r = startRun(workIds);
    return sendJson(res, 200, r);
  }
  if (method === 'POST' && p === '/api/run/pause') {
    if (!run.active && !run.processing) return sendJson(res, 400, { ok: false, error: '当前没有正在运行的任务' });
    run.paused = true;
    emit({ type: 'run-paused' });
    emitLog('warn', '队列已暂停（当前步骤完成后生效）');
    return sendJson(res, 200, { ok: true, paused: true });
  }
  if (method === 'POST' && p === '/api/run/resume') {
    const body = await readBody(req);
    run.paused = false;
    emit({ type: 'run-resumed' });
    emitLog('step', '队列已继续');
    if (body.workId) {
      const rec = jobs.get(String(body.workId));
      if (rec && rec.status === 'paused' && rec.paused && rec.paused.kind === 'human') {
        humanVerified.add(rec.workId);
        rec.paused = null;
        rec.status = 'queued';
        rec.updatedAt = now();
        run.retry.push(rec.workId);
        emitLog('ok', `已完成人工验证，继续处理：${rec.name}`, rec.workId);
        processQueue().catch((err) => emitLog('error', '队列异常：' + String(err)));
      }
    }
    return sendJson(res, 200, { ok: true, resumed: true });
  }
  if (method === 'POST' && p === '/api/run/stop') {
    run.stop = true;
    run.paused = false;
    emit({ type: 'run-stopped' });
    return sendJson(res, 200, { ok: true, stopped: true });
  }
  if (method === 'GET' && p === '/api/run/events') {
    return handleSSE(req, res);
  }

  /* ---- 单项作业 ---- */
  const jobMatch = p.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === 'GET' && jobMatch) {
    const workId = decodeURIComponent(jobMatch[1]);
    const rec = jobs.get(workId);
    if (!rec) {
      const work = WORKS.find((w) => w.workId === workId);
      if (!work) return sendJson(res, 404, { ok: false, error: '未找到该作业：' + workId });
      return sendJson(res, 200, {
        job: {
          workId, name: work.name, courseName: work.courseName, phase: 'idle',
          steps: [], questions: mockQuestions(work), answers: null, files: [], result: null, paused: null,
        },
      });
    }
    const work = WORKS.find((w) => w.workId === workId) || {};
    return sendJson(res, 200, {
      job: {
        workId: rec.workId,
        name: rec.name,
        courseName: rec.courseName,
        phase: rec.status,
        status: rec.status,
        progress: rec.progress,
        steps: rec.steps.slice(),
        questions: rec.questions || mockQuestions(work),
        answers: rec.answers,
        files: rec.files,
        result: rec.result,
        paused: rec.paused ? { ...rec.paused } : null,
        materialsNote: rec.materialsNote || '',
        error: rec.error,
      },
    });
  }

  const materialsMatch = p.match(/^\/api\/jobs\/([^/]+)\/materials$/);
  if (method === 'POST' && materialsMatch) {
    const workId = decodeURIComponent(materialsMatch[1]);
    const rec = jobs.get(workId);
    if (!rec) return sendJson(res, 404, { ok: false, error: '未找到该作业：' + workId });
    if (rec.status !== 'paused' || !rec.paused || rec.paused.kind !== 'materials') {
      return sendJson(res, 400, { ok: false, error: '该作业当前不需要补充资料' });
    }
    const body = await readBody(req);
    rec.materialsNote = String(body.note || '');
    materialsProvided.add(workId);
    rec.paused = null;
    rec.status = 'queued';
    rec.resumeFrom = 'solve';
    rec.updatedAt = now();
    emitLog('ok', `已收到补充资料${rec.materialsNote ? '（' + rec.materialsNote + '）' : ''}，继续处理：${rec.name}`, workId);
    run.retry.push(workId);
    processQueue().catch((err) => emitLog('error', '队列异常：' + String(err)));
    return sendJson(res, 200, { ok: true, resumed: true, workId });
  }

  /* ---- 设置 ---- */
  if (method === 'GET' && p === '/api/settings') {
    await sleep(200);
    return sendJson(res, 200, { ok: true, settings: { ...st.settings } });
  }
  if (method === 'POST' && p === '/api/settings') {
    const body = await readBody(req);
    const next = { ...st.settings };
    if (body.autoSubmit !== undefined) next.autoSubmit = !!body.autoSubmit;
    if (body.model) next.model = String(body.model);
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return sendJson(res, 400, { ok: false, error: '端口需在 1024–65535 之间' });
      next.port = port;
    }
    if (body.concurrency !== undefined) {
      const c = Number(body.concurrency);
      if (!Number.isInteger(c) || c < 1 || c > 5) return sendJson(res, 400, { ok: false, error: '并发数需在 1–5 之间' });
      next.concurrency = c;
    }
    if (body.timeoutMin !== undefined) {
      const t = Number(body.timeoutMin);
      if (!Number.isInteger(t) || t < 1 || t > 120) return sendJson(res, 400, { ok: false, error: '超时需在 1–120 分钟之间' });
      next.timeoutMin = t;
    }
    st.settings = next;
    emitLog('ok', '设置已更新（mock）');
    return sendJson(res, 200, { ok: true, settings: { ...st.settings } });
  }

  /* ---- 打开文件夹 ---- */
  if (method === 'POST' && p === '/api/open-folder') {
    const body = await readBody(req);
    const which = String(body.path || body.which || '');
    const allowed = { data: MOCK_DATA_DIR, logs: path.join(MOCK_DATA_DIR, 'logs'), materials: path.join(MOCK_DATA_DIR, 'materials') };
    let target = allowed[which];
    // 兼容真实服务端：materials/<workId> 直接定位到该项资料目录
    if (!target && which.startsWith('materials/')) target = path.join(allowed.materials, which.slice(10));
    if (!target) return sendJson(res, 400, { ok: false, error: '未知的文件夹类型：' + which });
    emitLog('info', `请求打开文件夹：${which}（${target}）`);
    return sendJson(res, 200, { ok: true, path: target, which, note: target + '（mock 环境不会真正打开资源管理器）' });
  }

  /* ---- 隐私与本地数据 ---- */
  if (method === 'GET' && p === '/api/privacy') {
    await sleep(150);
    return sendJson(res, 200, {
      ok: true,
      dataDir: MOCK_DATA_DIR,
      logDir: path.join(MOCK_DATA_DIR, 'logs'),
      encrypted: true,
      clearable: [
        { scope: 'session', label: '登录 Cookie', description: '清除后需要重新登录学习通。' },
        { scope: 'secrets', label: '账密与 API Key', description: '清除后需要重新填写学习通账密和 DeepSeek API Key。' },
        { scope: 'logs', label: '运行日志', description: '删除 logs 目录中的日志文件。' },
        { scope: 'all', label: '全部本地数据', description: '删除配置、密钥、Cookie、日志与作业产物（不可恢复）。' },
      ],
    });
  }
  if (method === 'POST' && p === '/api/privacy/clear') {
    const body = await readBody(req);
    const scope = String(body.scope || '');
    if (!['secrets', 'session', 'logs', 'all'].includes(scope)) {
      return sendJson(res, 400, { ok: false, error: '未知的清除范围：' + scope });
    }
    await sleep(500);
    if (scope === 'all') {
      resetAll();
      emit({ type: 'privacy-cleared', scope });
      return sendJson(res, 200, { ok: true, scope, cleared: true });
    }
    if (scope === 'session' || scope === 'secrets') {
      DATA.loggedIn = false;
      DATA.uid = null;
      DATA.loginAt = null;
      DATA.loginPendingHuman = false;
      st.setup.chaoxing.loggedIn = false;
      st.setup.chaoxing.uid = null;
    }
    if (scope === 'secrets') {
      DATA.aiKey = '';
      DATA.username = '';
      DATA.password = '';
      st.setup.ai.configured = false;
      st.setup.chaoxing.configured = false;
    }
    emitLog('warn', `已清除本地数据：${scope}（mock）`);
    emit({ type: 'privacy-cleared', scope });
    return sendJson(res, 200, { ok: true, scope, cleared: true });
  }

  /* ---- 仅 mock：重置演示数据 ---- */
  if (method === 'POST' && p === '/api/mock/reset') {
    resetAll();
    return sendJson(res, 200, { ok: true, reset: true });
  }

  return sendJson(res, 404, { ok: false, error: '未知接口：' + method + ' ' + p });
}

function resetAll() {
  run.active = false;
  run.processing = false;
  run.paused = false;
  run.stop = false;
  run.queue = [];
  run.retry = [];
  run.startedAt = 0;
  jobs.clear();
  completed.clear();
  materialsProvided.clear();
  humanVerified.clear();
  DATA.aiKey = '';
  DATA.username = '';
  DATA.password = '';
  DATA.loggedIn = false;
  DATA.uid = null;
  DATA.loginAt = null;
  DATA.installRunning = false;
  DATA.loginPendingHuman = false;
  DATA.loginAttempts = 0;
  st.setup.dsh.installed = true;
  st.setup.dsh.version = '0.1.7-rc.2';
  st.setup.ai.configured = false;
  st.setup.chaoxing.configured = false;
  st.setup.chaoxing.loggedIn = false;
  st.setup.chaoxing.uid = null;
  st.settings = { autoSubmit: true, model: 'deepseek-chat', port: 8765, concurrency: 1, timeoutMin: 10 };
  emit({ type: 'log', level: 'warn', message: '演示数据已重置（mock）', workId: null });
  emit({ type: 'run-done', stopped: true, summary: { total: 0, done: 0, paused: 0, failed: 0, results: [] } });
  log('演示数据已重置');
}

/* ======================== 服务器 ======================== */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch (err) {
    return sendText(res, 400, '400 Bad Request');
  }
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (isApi) log(`${req.method} ${url.pathname}`);

  try {
    if (isApi) await handleApi(req, res, url);
    else serveStatic(res, url.pathname);
  } catch (err) {
    if (res.headersSent) {
      try { res.end(); } catch (e) { /* ignore */ }
      return;
    }
    if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, error: err.message });
    console.error('[mock] 未处理异常：', err);
    return sendJson(res, 500, { ok: false, error: '服务内部错误：' + String(err && err.message ? err.message : err) });
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[mock] 端口 ${PORT} 已被占用，请设置 MOCK_PORT 换一个端口后重试。`);
    process.exit(1);
  }
  console.error('[mock] 服务错误：', err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('==============================================================');
  console.log('  学习通作业助手 · mock API 已启动（零依赖，仅用于预览演示）');
  console.log('--------------------------------------------------------------');
  console.log(`  UI:     http://127.0.0.1:${PORT}/`);
  console.log(`  API:    http://127.0.0.1:${PORT}/api/state`);
  console.log(`  SSE:    http://127.0.0.1:${PORT}/api/run/events`);
  console.log(`  速率:   MOCK_SPEED=${SPEED}（1 = 正常，0.2 = 快 5 倍）`);
  console.log('  说明:   Ctrl+C 停止；POST /api/mock/reset 可重置演示数据');
  console.log('==============================================================');
});

process.on('SIGINT', () => {
  console.log('\n[mock] 正在关闭…');
  sseClients.forEach((res) => { try { res.end(); } catch (e) { /* ignore */ } });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
