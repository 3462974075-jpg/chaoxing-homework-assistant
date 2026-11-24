#!/usr/bin/env node
/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/* ==========================================================================
 * mock 全链路自检脚本（零依赖）：验证 SSE 事件与「暂停 → 继续 → 完成」流程。
 *
 * 前置：另开窗口启动 mock（默认 8877）：
 *   node _mock/mock-api.mjs
 *   （自动化建议：MOCK_SPEED=0.2 node _mock/mock-api.mjs）
 *
 * 运行：node _mock/verify-flow.mjs
 * 通过时输出每一阶段的事件统计并以退出码 0 结束；失败抛错退出码 1。
 * ========================================================================== */

const BASE = process.env.MOCK_URL || 'http://127.0.0.1:8877';

const events = [];
let abortCtrl = null;
let readerDone = false;

function log(...args) {
  console.log('[verify]', ...args);
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> HTTP ${res.status}: ${text}`);
  return data;
}

async function startSSE() {
  abortCtrl = new AbortController();
  const res = await fetch(BASE + '/api/run/events', {
    headers: { Accept: 'text/event-stream' },
    signal: abortCtrl.signal,
  });
  if (!res.ok || !res.body) throw new Error('SSE 连接失败：HTTP ' + res.status);
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
          const dataLines = chunk.split('\n').filter((l) => l.startsWith('data:'));
          if (!dataLines.length) continue;
          const payload = dataLines.map((l) => l.slice(5).trim()).join('\n');
          try { events.push(JSON.parse(payload)); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') log('SSE 读取结束：', err.message);
    } finally {
      readerDone = true;
    }
  })();
  log('SSE 已连接');
}

function waitUntil(fn, label, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let value;
      try { value = fn(); } catch (err) { reject(err); return; }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('等待超时：' + label));
      setTimeout(poll, 100);
    })();
  });
}

function countType(type) {
  return events.filter((e) => e.type === type).length;
}

async function setupDemo() {
  await api('/api/mock/reset', { method: 'POST', body: {} });
  await api('/api/setup/ai-key', { method: 'POST', body: { apiKey: 'sk-mock-1234567890' } });
  await api('/api/setup/chaoxing', { method: 'POST', body: { username: 'demo-user', password: 'pass1234' } });
  await api('/api/login/start', { method: 'POST', body: {} });
  await api('/api/login/start', { method: 'POST', body: {} });
  const st = await api('/api/state');
  if (!st.setup.chaoxing.loggedIn) throw new Error('登录状态未就绪');
  const works = await api('/api/works');
  if (!Array.isArray(works.works) || works.works.length < 3) throw new Error('作业列表异常');
  log('配置与登录完成，作业数：', works.works.length);
}

async function main() {
  log('mock 地址：', BASE);
  await setupDemo();
  await startSSE();
  await new Promise((r) => setTimeout(r, 300));

  // 1) 启动运行：w1001 正常完成、w1003 缺资料暂停、w3001 人工验证暂停
  const runRes = await api('/api/run', { method: 'POST', body: { workIds: ['w1001', 'w1003', 'w3001'] } });
  if (!runRes.started) throw new Error('启动运行失败：' + JSON.stringify(runRes));
  log('已启动运行');

  await waitUntil(() => events.some((e) => e.type === 'job-paused' && e.kind === 'materials'), '缺资料暂停事件');
  await waitUntil(() => events.some((e) => e.type === 'job-paused' && e.kind === 'human'), '人工验证暂停事件');
  await waitUntil(() => events.some((e) => e.type === 'job-done' && e.workId === 'w1001'), 'w1001 完成');
  await waitUntil(() => events.some((e) => e.type === 'run-done' && e.summary && e.summary.paused >= 2), '第一轮运行结束（含暂停）');
  const st1 = await api('/api/state');
  if (st1.paused.length < 2) throw new Error('暂停项数量异常：' + JSON.stringify(st1.paused));
  log('第一轮事件：job-start=' + countType('job-start'), 'step=' + countType('step'), 'job-paused=' + countType('job-paused'), 'run-done=' + countType('run-done'));

  // 2) 补充资料 → 继续 → 完成
  const materialsRes = await api('/api/jobs/w1003/materials', { method: 'POST', body: { note: '已放入 函数图像实验数据.csv' } });
  if (!materialsRes.ok) throw new Error('补充资料失败');
  await waitUntil(() => events.some((e) => e.type === 'job-done' && e.workId === 'w1003'), 'w1003 补齐资料后完成');
  await waitUntil(() => events.filter((e) => e.type === 'run-done').length >= 2, '第二轮运行结束');
  log('缺资料项已继续并完成');

  // 3) 人工验证完成 → 继续 → 完成
  const humanRes = await api('/api/run/resume', { method: 'POST', body: { workId: 'w3001' } });
  if (!humanRes.ok) throw new Error('人工验证继续失败');
  await waitUntil(() => events.some((e) => e.type === 'job-done' && e.workId === 'w3001'), 'w3001 人工验证后完成');
  await waitUntil(() => events.filter((e) => e.type === 'run-done').length >= 3, '第三轮运行结束');
  log('人工验证项已继续并完成');

  // 4) 结果校验
  const st2 = await api('/api/state');
  const done = st2.jobs.filter((j) => j.status === 'done');
  if (done.length !== 3) throw new Error('完成任务数应为 3，实际 ' + done.length);
  const detail = await api('/api/jobs/w1001');
  if (!detail.job || !Array.isArray(detail.job.steps) || detail.job.steps.length < 3) throw new Error('作业详情 steps 异常');
  if (!detail.job.answers || typeof detail.job.answers !== 'object') throw new Error('作业详情 answers 异常');
  const worksAfter = await api('/api/works');
  if (worksAfter.works.length !== 7 - 3) throw new Error('完成后作业列表未收缩：' + worksAfter.works.length);
  log('结果校验通过：3 项完成，作业列表剩余', worksAfter.works.length, '项');

  // 5) 隐私端点
  const privacy = await api('/api/privacy');
  if (!privacy.dataDir || !Array.isArray(privacy.clearable)) throw new Error('隐私端点字段异常');
  const clearLogs = await api('/api/privacy/clear', { method: 'POST', body: { scope: 'logs' } });
  if (!clearLogs.ok) throw new Error('清除日志失败');
  log('隐私端点校验通过');

  // 6) 设置端点
  const settings = await api('/api/settings', { method: 'POST', body: { autoSubmit: false, model: 'deepseek-reasoner', concurrency: 1, timeoutMin: 8, port: 8877 } });
  if (!settings.settings || settings.settings.autoSubmit !== false) throw new Error('设置保存异常');
  await api('/api/settings', { method: 'POST', body: { autoSubmit: true, model: 'deepseek-chat', concurrency: 1, timeoutMin: 10, port: 8765 } });
  log('设置端点校验通过');

  // 事件类型清单（供 README 对照）
  const types = Array.from(new Set(events.map((e) => e.type))).sort();
  log('已收到 SSE 事件类型：', types.join(', '));
  for (const required of ['log', 'job-start', 'step', 'job-paused', 'job-done', 'run-start', 'run-done']) {
    if (!types.includes(required)) throw new Error('缺少必需 SSE 事件类型：' + required);
  }
  log('日志事件条数：', countType('log'));

  // 重置，方便随后人工演示
  await api('/api/mock/reset', { method: 'POST', body: {} });
  log('全部检查通过 ✅（mock 已重置，可开始浏览器演示）');
}

main()
  .then(() => {
    if (abortCtrl) abortCtrl.abort();
    process.exit(0);
  })
  .catch((err) => {
    console.error('[verify] 失败：', err.message);
    if (abortCtrl) abortCtrl.abort();
    process.exit(1);
  });
