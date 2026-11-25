/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 学习通全自动作业助手 — 本地 HTTP 服务（127.0.0.1）。
// 静态 UI + REST API + SSE 事件流；编排器见 orchestrator.mjs。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DIRS, UI_DIR, findDshBin, ensureDirs } from './paths.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { normalizeTargetAccuracy } from './accuracy.mjs';
import { humanizeError } from './errors.mjs';
import { EventHub } from './events.mjs';
import { JobStore } from './jobs.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { mergeSecrets, getSecrets, secretSummary, clearSecrets } from './secret.mjs';
import { createSessionStore } from './session-store.mjs';

const STARTED_AT = new Date().toISOString();
ensureDirs();
const config = loadConfig();
const events = new EventHub();
const jobs = new JobStore();
const sessionStore = createSessionStore();
const orchestrator = new Orchestrator({
  config,
  events,
  jobs,
  sessionStore,
  loadSecrets: getSecrets,
  saveConfig,
});

// ---------------------------------------------------------------- 工具函数
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function readEnvJson() {
  try {
    const f = path.join(DIRS.data, 'env.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  } catch {}
  return null;
}

function checkDsh() {
  const env = readEnvJson();
  let envDsh = process.env.CX_DSH
    || (env && env.dsh && (env.dsh.path || env.dsh.bin))
    || '';
  // start.ps1 可能给的是 dsh.cmd，统一换算成 lib/bin.js 便于判断版本/被引擎直接 spawn
  if (envDsh && /\.cmd$/i.test(envDsh)) {
    const sibling = path.join(path.dirname(envDsh), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(sibling)) envDsh = sibling;
  }
  const bin = envDsh && fs.existsSync(envDsh) ? envDsh : findDshBin();
  if (!bin) return { installed: false, version: '', bin: '', source: '' };
  let version = (env && env.dsh && env.dsh.version) || '';
  try {
    if (!version) {
      const pkg = bin.endsWith('.cmd')
        ? path.join(path.dirname(bin), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
        : path.join(path.dirname(bin), '..', 'package.json');
      if (fs.existsSync(pkg)) version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '';
    }
  } catch {}
  return { installed: true, version, bin, source: envDsh ? 'portable' : 'system' };
}

function buildEnv() {
  const raw = readEnvJson() || {};
  const dsh = checkDsh();
  return {
    node: {
      version: (raw.node && raw.node.version) || process.version,
      path: process.env.CX_NODE || process.execPath,
      source: process.env.CX_NODE ? 'portable' : 'system',
    },
    dsh: { version: dsh.version, path: dsh.bin, source: dsh.source },
    python: raw.python || null,
    git: raw.git || null,
    dshHome: DIRS.dshHome,
  };
}

async function buildState() {
  const sec = await secretSummary().catch(() => ({ hasFile: false, aiConfigured: false, chaoxingConfigured: false, username: '' }));
  let session = { loggedIn: false, uid: '' };
  if (sec.chaoxingConfigured) {
    session = await orchestrator.sessionStatus().catch(() => ({ loggedIn: false, uid: '' }));
  }
  const allJobs = jobs.list().map((j) => ({
    workId: j.workId,
    name: j.name,
    courseName: j.courseName,
    kind: j.kind,
    status: j.status === 'running' ? 'running' : j.phase || j.status,
    phase: j.phase,
    progress: jobProgress(j),
    result: j.result,
    error: j.error,
    errorCode: j.errorCode || '',
    errorHint: j.errorHint || '',
    errorRaw: j.errorRaw || '',
    accuracy: j.accuracy || null,
    highAccuracy: j.highAccuracy || null,
    formulaWarning: j.formulaWarning || null,
    formulaError: j.formulaError || '',
    skippedQuestions: Array.isArray(j.skippedQuestions) ? j.skippedQuestions : [],
    updatedAt: j.updatedAt,
  }));
  const paused = jobs.list()
    .filter((j) => j.status === 'paused')
    .map((j) => ({
      workId: j.workId,
      name: j.name,
      courseName: j.courseName,
      kind: (j.paused && j.paused.kind) || 'materials',
      reason: (j.paused && j.paused.reason) || '需要处理',
      detail: (j.paused && j.paused.detail) || [],
      missingQuestions: (j.paused && j.paused.missingQuestions) || [],
      reviewQuestions: (j.paused && j.paused.reviewQuestions) || [],
      accuracyChanges: (j.paused && j.paused.accuracyChanges) || [],
      skippedQuestions: Array.isArray(j.skippedQuestions) ? j.skippedQuestions : [],
      skippableQuestions: (j.paused && j.paused.skippableQuestions) || [],
      highAccuracyTies: (j.paused && j.paused.highAccuracyTies) || [],
      createdAt: (j.paused && j.paused.at) || j.updatedAt,
    }));
  const dsh = checkDsh();
  const ready = dsh.installed && sec.aiConfigured && sec.chaoxingConfigured;
  return {
    ok: true,
    phase: orchestrator.running ? 'running' : ready ? 'idle' : 'setup',
    startedAt: STARTED_AT,
    running: orchestrator.running,
    setup: {
      dsh,
      ai: { configured: Boolean(sec.aiConfigured) },
      chaoxing: { configured: Boolean(sec.chaoxingConfigured), loggedIn: Boolean(session.loggedIn), uid: session.uid || '', username: sec.username || '' },
    },
    session,
    jobs: allJobs,
    paused,
    courses: orchestrator.courses,
    lastRefresh: orchestrator.lastRefresh,
    paths: { root: DIRS.root, data: DIRS.data, logs: DIRS.logs, materials: DIRS.materials, jobs: DIRS.jobs },
    env: buildEnv(),
    privacy: privacySummary(),
    config: publicConfig(),
    logs: events.recentLogs(100),
  };
}

function jobProgress(job) {
  if (job.status === 'done' || job.status === 'ready') return 100;
  const steps = job.steps || [];
  const done = steps.filter((s) => s.status === 'done').length;
  if (!steps.length) return 0;
  return Math.min(99, Math.round((done / Math.max(steps.length, 5)) * 100));
}

function publicConfig() {
  return {
    port: config.port,
    autoSubmit: config.autoSubmit,
    targetAccuracy: config.targetAccuracy,
    highAccuracy: config.highAccuracy === true,
    reviewBeforeSubmit: config.reviewBeforeSubmit !== false,
    model: config.model,
    engineTimeoutSec: config.engineTimeoutSec,
    loginTimeoutSec: config.loginTimeoutSec,
    dshVersion: config.dshVersion,
    httpOnly: Boolean(config.httpOnly),
  };
}

// ---------------------------------------------------------------- 环境与隐私
function dirSize(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const name of fs.readdirSync(p)) total += dirSize(path.join(p, name));
    return total;
  } catch { return 0; }
}

function privacySummary() {
  const sessionFile = path.join(DIRS.data, 'session.dat');
  const secretsFile = path.join(DIRS.data, 'secrets.dat');
  return {
    dataDir: DIRS.data,
    encrypted: {
      secrets: fs.existsSync(secretsFile),
      session: fs.existsSync(sessionFile),
    },
    scopes: [
      { scope: 'secrets', label: '账号密码 / API Key（DPAPI 加密）', bytes: dirSize(secretsFile) + dirSize(path.join(DIRS.dshHome, '.credentials.yaml')) },
      { scope: 'session', label: '学习通登录态 + 独立 Edge 配置', bytes: dirSize(sessionFile) + dirSize(DIRS.edgeProfile) },
      { scope: 'logs', label: '运行日志', bytes: dirSize(DIRS.logs) },
      { scope: 'all', label: '全部本地数据（含作业记录/附件）', bytes: dirSize(DIRS.data) + dirSize(DIRS.logs) },
    ],
    note: '绿色版所有数据只保存在程序目录的 data\\ 与 logs\\ 下，不写注册表、不建系统服务',
  };
}

async function privacyClear(scope) {
  const removed = [];
  const rm = (p, label) => {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(label || p);
      }
    } catch (e) {
      events.warn('删除失败：' + p + ' ' + e.message);
    }
  };
  if (scope === 'secrets' || scope === 'all') {
    await clearSecrets();
    removed.push('secrets.dat');
    rm(path.join(DIRS.dshHome, '.credentials.yaml'), 'dsh-home/.credentials.yaml');
  }
  if (scope === 'session' || scope === 'all') {
    try { await sessionStore.clear(); removed.push('session.dat'); } catch {}
    try { if (typeof orchestrator.logout === 'function') await orchestrator.logout(); } catch {}
    rm(DIRS.edgeProfile, 'edge-profile');
  }
  if (scope === 'logs' || scope === 'all') {
    try {
      for (const n of fs.readdirSync(DIRS.logs)) rm(path.join(DIRS.logs, n), 'logs/' + n);
    } catch {}
  }
  if (scope === 'all') {
    rm(DIRS.jobs, 'jobs');
    rm(DIRS.materials, 'materials');
    rm(DIRS.downloads, 'downloads');
    rm(DIRS.dshHome, 'dsh-home');
    rm(DIRS.chaoxingData, 'chaoxing-data');
    rm(DIRS.tmp, 'tmp');
  }
  ensureDirs();
  events.info('已清除本地数据，范围：' + (scope || 'all'));
  return { ok: true, scope, removed };
}

// ---------------------------------------------------------------- 路由
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method || 'GET';

  if (method === 'GET' && p === '/api/health') {
    return sendJson(res, 200, { ok: true, startedAt: STARTED_AT, pid: process.pid });
  }

  if (method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, await buildState());
  }

  if (method === 'GET' && p === '/api/run/events') {
    events.addClient(req, res);
    return;
  }

  if (method === 'GET' && p === '/api/logs') {
    const n = Number(url.searchParams.get('n') || 200);
    return sendJson(res, 200, { ok: true, logs: events.recentLogs(Number.isFinite(n) ? n : 200) });
  }

  if (method === 'GET' && p === '/api/env') {
    return sendJson(res, 200, { ok: true, ...buildEnv() });
  }

  if (method === 'GET' && p === '/api/privacy') {
    return sendJson(res, 200, { ok: true, ...privacySummary() });
  }

  if (method === 'POST' && p === '/api/privacy/clear') {
    const body = await readBody(req).catch(() => ({}));
    const scope = String(body.scope || 'all');
    if (!['secrets', 'session', 'logs', 'all'].includes(scope)) {
      return sendJson(res, 400, { ok: false, error: '不支持的清除范围：' + scope });
    }
    return sendJson(res, 200, await privacyClear(scope));
  }

  if (method === 'POST' && p === '/api/setup/install') {
    return sendJson(res, 200, { started: false, error: '绿色版请在程序目录双击运行「环境准备.cmd」' });
  }

  if (method === 'POST' && p === '/api/setup/ai-key') {
    const body = await readBody(req);
    const apiKey = String(body.apiKey || '').trim();
    if (!/^sk-[A-Za-z0-9_\-.]+$/.test(apiKey) || apiKey.length < 12) {
      return sendJson(res, 400, { ok: false, error: 'API Key 格式不正确（应以 sk- 开头）' });
    }
    await mergeSecrets({ deepseek: { apiKey } });
    try {
      const engine = await orchestrator._loadEngine();
      if (engine && typeof engine.ensureHome === 'function') await engine.ensureHome({ apiKey });
    } catch (e) {
      events.warn('AI 引擎尚未就绪，API Key 已保存，稍后自动写入：' + e.message);
    }
    events.info('DeepSeek API Key 已加密保存');
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/setup/chaoxing') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return sendJson(res, 400, { ok: false, error: '账号和密码都不能为空' });
    await mergeSecrets({ chaoxing: { username, password } });
    events.info('学习通账号密码已加密保存');
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/login/start') {
    try {
      const r = await orchestrator.login();
      return sendJson(res, 200, r);
    } catch (e) {
      events.error('登录失败：' + e.message);
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (method === 'POST' && p === '/api/logout') {
    return sendJson(res, 200, await orchestrator.logout());
  }

  if (method === 'GET' && p === '/api/courses') {
    return sendJson(res, 200, { ok: true, courses: orchestrator.courses });
  }

  if (method === 'GET' && p === '/api/works') {
    return sendJson(res, 200, { ok: true, works: orchestrator.works, lastRefresh: orchestrator.lastRefresh });
  }

  if (method === 'POST' && p === '/api/works/refresh') {
    const body = await readBody(req).catch(() => ({}));
    const r = await orchestrator.refresh({ courseId: body.courseId });
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (method === 'POST' && p === '/api/run') {
    const body = await readBody(req);
    const ids = Array.isArray(body.workIds) ? body.workIds : [];
    try {
      if (!orchestrator.works.length) await orchestrator.refresh({});
      orchestrator.run(ids).catch((e) => {
        events.error('批量运行失败：' + e.message);
        events.broadcast('run-done', { summary: { total: ids.length, done: 0, paused: 0, failed: ids.length }, error: e.message });
      });
      return sendJson(res, 200, { started: true, workIds: ids });
    } catch (e) {
      return sendJson(res, 400, { started: false, error: e.message });
    }
  }

  if (method === 'POST' && p === '/api/run/pause') {
    orchestrator.pauseQueue();
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/run/resume') {
    orchestrator.resumeQueue();
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/run/stop') {
    orchestrator.stopQueue();
    return sendJson(res, 200, { ok: true });
  }

  const jobMatch = p.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === 'GET' && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) return sendJson(res, 404, { ok: false, error: '没有该作业的记录' });
    return sendJson(res, 200, { ok: true, job });
  }

  const reviewSubmitMatch = p.match(/^\/api\/jobs\/([^/]+)\/submit$/);
  if (method === 'POST' && reviewSubmitMatch) {
    const workId = decodeURIComponent(reviewSubmitMatch[1]);
    try {
      const result = await orchestrator.submitReview(workId);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: humanizeError(e).message, detail: humanizeError(e) });
    }
  }

  const reviewReadyMatch = p.match(/^\/api\/jobs\/([^/]+)\/ready$/);
  if (method === 'POST' && reviewReadyMatch) {
    const workId = decodeURIComponent(reviewReadyMatch[1]);
    try {
      const result = await orchestrator.markReady(workId);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: humanizeError(e).message });
    }
  }

  const reviewOpenMatch = p.match(/^\/api\/jobs\/([^/]+)\/open$/);
  if (method === 'POST' && reviewOpenMatch) {
    const workId = decodeURIComponent(reviewOpenMatch[1]);
    try {
      const result = await orchestrator.openReview(workId);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: humanizeError(e).message });
    }
  }

  const reviewRescueMatch = p.match(/^\/api\/jobs\/([^/]+)\/rescue$/);
  if (method === 'POST' && reviewRescueMatch) {
    const workId = decodeURIComponent(reviewRescueMatch[1]);
    try {
      const result = await orchestrator.rescueJob(workId);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: humanizeError(e).message, detail: humanizeError(e) });
    }
  }

  const reviewSkipMatch = p.match(/^\/api\/jobs\/([^/]+)\/skip$/);
  if (method === 'POST' && reviewSkipMatch) {
    const workId = decodeURIComponent(reviewSkipMatch[1]);
    const body = await readBody(req).catch(() => ({}));
    if (!body || !body.qid) return sendJson(res, 400, { ok: false, error: '缺少 qid' });
    try {
      const result = await orchestrator.skipQuestion(workId, body.qid);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: humanizeError(e).message });
    }
  }

  const matMatch = p.match(/^\/api\/jobs\/([^/]+)\/materials$/);
  if (method === 'POST' && matMatch) {
    const workId = decodeURIComponent(matMatch[1]);
    const job = jobs.get(workId);
    if (!job) return sendJson(res, 404, { ok: false, error: '没有该作业的记录' });
    const body = await readBody(req).catch(() => ({}));
    const dir = path.join(DIRS.materials, workId);
    fs.mkdirSync(dir, { recursive: true });
    events.info(`「${job.name}」用户已补充资料：${body.note || '（未填写说明）'}`);
    orchestrator.resumeWork(workId).catch((e) => {
      events.error(`「${job.name}」恢复失败：${e.message}`);
      events.broadcast('job-done', { workId, name: job.name, error: e.message });
    });
    return sendJson(res, 200, { ok: true, started: true, materialsDir: dir });
  }

  if (method === 'GET' && p === '/api/settings') {
    return sendJson(res, 200, {
      ok: true,
      config: publicConfig(),
      paths: { root: DIRS.root, data: DIRS.data, logs: DIRS.logs, materials: DIRS.materials, jobs: DIRS.jobs },
    });
  }

  if (method === 'POST' && p === '/api/settings') {
    const body = await readBody(req);
    const allowed = ['autoSubmit', 'engineTimeoutSec', 'loginTimeoutSec', 'model', 'targetAccuracy', 'reviewBeforeSubmit', 'highAccuracy'];
    for (const k of allowed) {
      if (body[k] !== undefined) config[k] = body[k];
    }
    if (config.targetAccuracy !== undefined) config.targetAccuracy = normalizeTargetAccuracy(config.targetAccuracy);
    if (config.reviewBeforeSubmit !== undefined) config.reviewBeforeSubmit = config.reviewBeforeSubmit !== false;
    if (config.highAccuracy !== undefined) config.highAccuracy = config.highAccuracy === true;
    // 高正确率只在 99% 档生效；切到其他正确率时自动关闭
    if (Number(config.targetAccuracy) !== 0.99) config.highAccuracy = false;
    saveConfig(config);
    events.info('设置已保存');
    return sendJson(res, 200, { ok: true, config: publicConfig() });
  }

  if (method === 'POST' && p === '/api/open-folder') {
    const body = await readBody(req).catch(() => ({}));
    const which = String(body.path || body.which || 'data');
    const map = {
      root: DIRS.root, data: DIRS.data, logs: DIRS.logs, materials: DIRS.materials,
      jobs: DIRS.jobs, downloads: DIRS.downloads, dshHome: DIRS.dshHome,
    };
    let target = map[which];
    if (!target && which.startsWith('materials/')) target = path.join(DIRS.materials, which.slice(10));
    if (!target) return sendJson(res, 400, { ok: false, error: '不支持的目录' });
    fs.mkdirSync(target, { recursive: true });
    try {
      spawn('explorer.exe', [target], { stdio: 'ignore', detached: true }).unref();
      return sendJson(res, 200, { ok: true, path: target });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在: ' + method + ' ' + p });
}

function eventSafe(fn) { try { fn(); } catch {} }

// ---------------------------------------------------------------- 静态文件
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  const file = path.join(UI_DIR, safe);
  if (!file.startsWith(UI_DIR)) {
    res.writeHead(403); res.end('403'); return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // 前端路由兜底
      const index = path.join(UI_DIR, 'index.html');
      if (fs.existsSync(index) && !rel.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        fs.createReadStream(index).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><h1>界面文件未就位</h1><p>缺少 ${file}</p><p>请确认 ui/ 目录已随应用一起安装。</p>`);
      }
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- 启动
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${config.port}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error('[api]', e);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
      else try { res.end(); } catch {}
    });
    return;
  }
  if ((req.method || 'GET') === 'GET') {
    serveStatic(req, res, url);
  } else {
    res.writeHead(405); res.end('405');
  }
});

function listen(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('服务启动失败：', e.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    if (config.port !== port) { config.port = port; saveConfig(config); }
    const urlStr = `http://127.0.0.1:${port}/`;
    console.log(`\n学习通作业助手已启动：${urlStr}`);
    console.log(`程序目录：${DIRS.root}`);
    events.info(`服务已启动：${urlStr}`);
    try {
      fs.mkdirSync(DIRS.data, { recursive: true });
      fs.writeFileSync(
        path.join(DIRS.data, 'server.json'),
        JSON.stringify({ port, url: urlStr, pid: process.pid, startedAt: STARTED_AT }, null, 2),
        'utf8',
      );
    } catch (e) {
      events.warn('写入 server.json 失败：' + e.message);
    }
    if (process.env.CX_OPEN_BROWSER === '1') {
      try { spawn('cmd.exe', ['/c', 'start', '', urlStr], { stdio: 'ignore', detached: true }).unref(); } catch {}
    }
  });
}

listen(Number(config.port) || 8765);

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  events.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
