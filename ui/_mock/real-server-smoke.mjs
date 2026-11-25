#!/usr/bin/env node
/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/* ==========================================================================
 * 真实服务端兼容性冒烟测试（可选，需先启动 app/server.mjs 且 CX_FAKE=1）
 *
 * 目的：验证 UI 依赖的真实接口字段与 SSE 事件形态（5.3 + 隐私端点），
 *       与 mock 一起构成双层验证。
 *
 * 前置（终端 1，测试用临时数据根目录）：
 *   $env:CX_APP_ROOT=".\ui\_mock\real-test"
 *   $env:CX_FAKE="1"
 *   node app\server.mjs
 * 前置（终端 2，首次配置；已有配置可跳过）：
 *   调用 /api/setup/ai-key、/api/setup/chaoxing、/api/login/start（见 README §6.1）
 *
 * 运行：node _mock/real-server-smoke.mjs   （BASE_URL 可覆盖，默认 http://127.0.0.1:8765）
 *
 * 注意：会向测试数据目录的 materials/1002 写入一个占位资料文件，仅在 CX_FAKE 测试根目录使用。
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[real-smoke]', ...a);
const events = [];
let ctrl = null;

async function api(urlPath, opts = {}) {
  const res = await fetch(BASE + urlPath, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${urlPath} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

async function startSSE() {
  ctrl = new AbortController();
  const res = await fetch(BASE + '/api/run/events', { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
  if (!res.ok || !res.body) throw new Error('SSE HTTP ' + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          try { events.push(JSON.parse(dataLine.slice(5).trim())); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') log('SSE 读取结束：', err.message);
    }
  })();
}

function waitUntil(fn, label, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('等待超时：' + label));
      setTimeout(poll, 150);
    })();
  });
}

async function main() {
  const st0 = await api('/api/state');
  if (!st0.setup.dsh.installed) throw new Error('真实服务端 DSH 未就绪');
  const health = await api('/api/health');
  if (!health.ok) throw new Error('health 异常');
  log('服务端在线，phase=' + st0.phase);

  // 1. 刷新作业列表（CX_FAKE 假数据：1001 quiz / 1002 attach 待办）
  await api('/api/works/refresh', { method: 'POST', body: {} });
  const worksRes = await api('/api/works');
  const works = worksRes.works || [];
  log('待办作业：', works.map((w) => `${w.workId}:${w.name}(${w.kind})`).join(' | '));
  if (!works.length) throw new Error('真实服务端（fake cx）未返回待办作业，请确认 CX_FAKE=1');
  const quiz = works.find((w) => w.kind === 'quiz');
  const attach = works.find((w) => w.kind === 'attach');
  if (!quiz || !attach) throw new Error('fake cx 待办作业缺少 quiz/attach 类型，无法验证两类流程');

  // 清理上一次测试可能留下的资料，确保 attach 作业先触发「缺资料暂停」
  const stPaths = await api('/api/state');
  const attachMaterialsDir = path.join(stPaths.paths.materials, String(attach.workId));
  fs.rmSync(attachMaterialsDir, { recursive: true, force: true });

  // 2. 订阅 SSE 并运行
  await startSSE();
  await sleep(400);
  const runRes = await api('/api/run', { method: 'POST', body: { workIds: [quiz.workId, attach.workId] } });
  if (!runRes.started) throw new Error('run 未启动：' + JSON.stringify(runRes));

  await waitUntil(() => events.some((e) => e.type === 'job-done' && String(e.workId) === String(quiz.workId) && !e.error), 'quiz 完成');
  log('quiz 作业完成事件收到');
  await waitUntil(() => events.some((e) => e.type === 'job-paused' && String(e.workId) === String(attach.workId)), 'attach 缺资料暂停');
  log('attach 缺资料暂停事件收到：', events.filter((e) => e.type === 'job-paused').map((e) => e.reason).join('；'));
  await waitUntil(() => events.some((e) => e.type === 'run-done' && e.summary), '第一轮 run-done', 150000);
  const st1 = await api('/api/state');
  if (!st1.paused.length) throw new Error('state.paused 为空');

  // 3. 补充资料后继续
  const materialsDir = path.join(st1.paths.materials, String(attach.workId));
  fs.mkdirSync(materialsDir, { recursive: true });
  fs.writeFileSync(path.join(materialsDir, '参考资料.txt'), '真实服务端冒烟测试用的占位资料内容。', 'utf8');
  const matRes = await api('/api/jobs/' + encodeURIComponent(attach.workId) + '/materials', { method: 'POST', body: { note: '冒烟测试补充资料' } });
  if (!matRes.ok) throw new Error('materials 接口失败：' + JSON.stringify(matRes));
  await waitUntil(() => events.some((e) => e.type === 'job-done' && String(e.workId) === String(attach.workId) && !e.error), 'attach 补充资料后完成', 150000);
  log('attach 补充资料后完成事件收到');

  // 4. 作业详情与状态字段
  const detail = await api('/api/jobs/' + encodeURIComponent(quiz.workId));
  if (!detail.ok || !detail.job) throw new Error('jobs/:workId 响应异常');
  const j = detail.job;
  if (!Array.isArray(j.steps) || !j.steps.length) throw new Error('job.steps 不是数组');
  if (!j.questions || !j.questions.length) throw new Error('job.questions 为空');
  if (!j.answers || typeof j.answers !== 'object') throw new Error('job.answers 缺失');
  log('作业详情字段 OK：steps=' + j.steps.length + '，questions=' + j.questions.length + '，status=' + j.status);

  const st2 = await api('/api/state');
  const doneJobs = st2.jobs.filter((x) => x.status === 'done');
  log('state.jobs 状态统计：done=' + doneJobs.length + '，paused=' + st2.paused.length);
  const summaryEvent = events.filter((e) => e.type === 'run-done' && e.summary && Array.isArray(e.summary.results)).pop();
  if (!summaryEvent) throw new Error('未收到带 results 的批量 run-done');
  const outcome = summaryEvent.summary.results.map((r) => r.outcome).join(',');
  log('run-done.summary.results outcome：', outcome);

  // 5. 设置与隐私端点形态（UI 兼容性关键）
  const settings = await api('/api/settings');
  if (!settings.ok || !settings.config) throw new Error('/api/settings 缺少 config');
  const privacy = await api('/api/privacy');
  if (!privacy.dataDir || !Array.isArray(privacy.scopes)) throw new Error('/api/privacy 形态异常');
  log('settings.config.model =', JSON.stringify(settings.config.model), '；privacy.scopes =', privacy.scopes.map((s) => s.scope).join(','));
  log('settings.paths =', JSON.stringify(settings.paths));

  // 6. SSE 事件类型清单
  const types = Array.from(new Set(events.map((e) => e.type))).sort();
  log('真实服务端 SSE 事件类型：', types.join(', '));
  for (const t of ['log', 'job-start', 'step', 'job-paused', 'job-done', 'run-start', 'run-done']) {
    if (!types.includes(t)) throw new Error('缺少事件类型：' + t);
  }
  log('真实服务端兼容性冒烟测试通过 ✅');
}

main()
  .then(() => { if (ctrl) ctrl.abort(); process.exit(0); })
  .catch((err) => { console.error('[real-smoke] 失败：', err.message); if (ctrl) ctrl.abort(); process.exit(1); });
