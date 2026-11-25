/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 端到端冒烟测试（不依赖真实学习通 / 真实 AI）：
//   1) DPAPI 机密往返
//   2) 编排器：刷新列表 → 客观题作业完成 → 附件作业因缺资料暂停 → 补充资料后继续完成
//   3) 真实 server.mjs 进程：健康检查、状态、刷新、运行、暂停/继续、静态 UI（若已就位）
// 用法：node tests/smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TEST_ROOT = path.join(ROOT, 'test-root-e2e');
const SERVER_ROOT = path.join(ROOT, 'test-root-server');

function resetDir(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(d, { recursive: true });
}

let failures = 0;
function ok(cond, name, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures += 1; console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

process.env.CX_APP_ROOT = TEST_ROOT;
process.env.CX_FAKE = '1';
resetDir(TEST_ROOT);
fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });

const { secretSummary, mergeSecrets, clearSecrets, getSecrets } = await import('../app/secret.mjs');
const { createSessionStore } = await import('../app/session-store.mjs');
const { EventHub } = await import('../app/events.mjs');
const { JobStore } = await import('../app/jobs.mjs');
const { Orchestrator } = await import('../app/orchestrator.mjs');
const { DEFAULT_CONFIG } = await import('../app/config.mjs');
const { createCx } = await import('./fake/cx.mjs');
const { createEngine } = await import('./fake/engine.mjs');

console.log('\n[1] DPAPI 机密往返');
{
  await mergeSecrets({ deepseek: { apiKey: 'sk-smoke-test' }, chaoxing: { username: 'u', password: 'p' } });
  const back = await getSecrets();
  ok(back.deepseek.apiKey === 'sk-smoke-test', '加密后能正确解密');
  const sum = await secretSummary(true);
  ok(sum.aiConfigured && sum.chaoxingConfigured, 'secretSummary 标记已配置');
  await clearSecrets();
  const sum2 = await secretSummary(true);
  ok(!sum2.aiConfigured, '清除后标记未配置');
}

console.log('\n[2] Cookie 加密存储（DPAPI）');
{
  const store = createSessionStore();
  const sentinel = 'SENTINEL_COOKIE_9f3a2b';
  const obj = { savedAt: new Date().toISOString(), cookies: [{ name: '_uid', value: sentinel, domain: '.chaoxing.com', path: '/' }] };
  await store.save(obj);
  const back = await store.load();
  ok(back && back.cookies[0].value === sentinel, 'Cookie 加密后能正确读回');
  const raw = fs.readFileSync(store.file, 'utf8');
  ok(!raw.includes('SENTINEL'), '磁盘上不含明文 Cookie 内容');
  await store.clear();
  ok((await store.load()) === null, '清除后读取为空');
}

console.log('\n[3] 编排器流程（fake cx/engine）');
{
  const events = new EventHub();
  const jobs = new JobStore();
  const config = { ...DEFAULT_CONFIG, autoSubmit: true };
  const orch = new Orchestrator({
    config, events, jobs,
    loadSecrets: async () => ({}),
    saveConfig: () => {},
    cxFactory: async () => createCx({}),
    engineFactory: async () => createEngine({}),
  });
  const refreshed = await orch.refresh({});
  ok(refreshed.works.length === 2, '刷新后得到 2 项待完成作业', JSON.stringify(refreshed.works.map((w) => w.workId)));
  const summary = await orch.run(['1001', '1002']);
  const j1 = jobs.get('1001');
  const j2 = jobs.get('1002');
  ok(j1 && j1.status === 'done', '客观题作业完成', j1 && j1.status);
  ok(j2 && j2.status === 'paused', '附件作业因缺资料暂停', j2 && j2.status);
  ok(j2 && j2.paused && j2.paused.kind === 'materials', '暂停原因类型为 materials', j2 && JSON.stringify(j2.paused));
  ok(j2 && Array.isArray(j2.paused.missingQuestions) && j2.paused.missingQuestions.length >= 1, '暂停时附带题号/题干定位', j2 && JSON.stringify(j2.paused.missingQuestions));
  ok(summary.paused === 1, '汇总里暂停数为 1', JSON.stringify(summary));

  // 用户补充资料后继续
  const matDir = path.join(TEST_ROOT, 'data', 'materials', '1002');
  fs.mkdirSync(matDir, { recursive: true });
  fs.writeFileSync(path.join(matDir, '第6次作业模板.docx'), 'template placeholder', 'utf8');
  const resumed = await orch.resumeWork('1002');
  const j2b = jobs.get('1002');
  ok(resumed.outcome === 'paused' && j2b.paused && j2b.paused.kind === 'review', '补充资料后进入待确认提交', j2b && j2b.status + '/' + (j2b.paused && j2b.paused.kind));
  const submitted2 = await orch.submitReview('1002');
  const j2c = jobs.get('1002');
  ok(submitted2.outcome === 'done' && j2c.status === 'done' && j2c.files.length === 1, '确认提交后完成并记录文件', JSON.stringify(j2c.files));
  ok(j2c.result && j2c.result.submitted === true, '记录为已提交');

  // 关闭自动提交：必须暂存为「待提交」，不能显示“已完成”
  const jobs2 = new JobStore();
  const events2 = new EventHub();
  const orch2 = new Orchestrator({
    config: { ...DEFAULT_CONFIG, autoSubmit: false },
    events: events2, jobs: jobs2,
    loadSecrets: async () => ({}),
    saveConfig: () => {},
    cxFactory: async () => createCx({}),
    engineFactory: async () => createEngine({}),
  });
  await orch2.refresh({});
  const r2 = await orch2.run(['1001']);
  const jr = jobs2.get('1001');
  ok(r2.ready === 1 && jr.status === 'ready' && jr.result && jr.result.saved === true, '关闭自动提交后状态为待提交（已暂存）', jr && jr.status + ' / ' + JSON.stringify(jr.result));
  // 目标正确率（近似）：按题数改错，只改客观题，并记录改动
  const jobs3 = new JobStore();
  const events3 = new EventHub();
  const orch3 = new Orchestrator({
    config: { ...DEFAULT_CONFIG, autoSubmit: true, targetAccuracy: 0.8 },
    events: events3, jobs: jobs3,
    loadSecrets: async () => ({}),
    saveConfig: () => {},
    cxFactory: async () => createCx({}),
    engineFactory: async () => createEngine({}),
  });
  await orch3.refresh({});
  await orch3.run(['1001']);
  const ja = jobs3.get('1001');
  const changed = ja && ja.accuracy && Array.isArray(ja.accuracy.changed) ? ja.accuracy.changed : [];
  ok(changed.length === 1, '目标正确率 80% 按题数改错 1 题', JSON.stringify(ja && ja.accuracy));
  const baseline = { q1: 'A', q2: 'ABC', q3: ['分隔符'] };
  const changedQid = changed[0] && changed[0].qid;
  if (changedQid) {
    const before = JSON.stringify(baseline[changedQid]);
    const after = JSON.stringify(ja.answers && ja.answers.answers ? ja.answers.answers[changedQid] : null);
    ok(before !== after, '改错后答案与原答案不同', before + ' -> ' + after);
  }
  events3.close();
  events.close();
  events2.close();
}

console.log('\n[4] server.mjs 进程级冒烟');
{
  resetDir(SERVER_ROOT);
  fs.mkdirSync(path.join(SERVER_ROOT, 'data'), { recursive: true });
  const port = 18767;
  fs.writeFileSync(path.join(SERVER_ROOT, 'data', 'config.json'), JSON.stringify({ port, autoSubmit: true }), 'utf8');
  const serverPath = path.join(ROOT, 'app', 'server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, CX_APP_ROOT: SERVER_ROOT, CX_FAKE: '1', CX_OPEN_BROWSER: '0' },
    stdio: 'ignore',
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let health = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { health = await r.json(); break; }
    } catch {}
    await wait(300);
  }
  ok(Boolean(health && health.ok), '服务健康检查通过', health ? '' : '服务未起来');

  try {
    let state = await (await fetch(`${base}/api/state`)).json();
    ok(state.phase === 'setup' || state.phase === 'idle', '初始状态可读', state.phase);

    const saveCreds = await (await fetch(`${base}/api/setup/chaoxing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '13800000000', password: 'secret' }),
    })).json();
    ok(saveCreds.ok === true, '学习通账密保存接口');

    const badKey = await fetch(`${base}/api/setup/ai-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'bad' }),
    });
    ok(badKey.status === 400, '非法 API Key 被拒绝', String(badKey.status));

    const refresh = await (await fetch(`${base}/api/works/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    ok(refresh.ok === true && refresh.works.length === 2, '刷新作业列表', JSON.stringify(refresh.works && refresh.works.length));

    const run = await (await fetch(`${base}/api/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workIds: ['1001', '1002'] }),
    })).json();
    ok(run.started === true, '启动批量运行');

    let seeDone = false;
    let seePaused = false;
    for (let i = 0; i < 80; i += 1) {
      state = await (await fetch(`${base}/api/state`)).json();
      const j1001 = state.jobs.find((j) => j.workId === '1001');
      if (j1001 && j1001.status === 'done') seeDone = true;
      seePaused = state.paused.some((p) => p.workId === '1002') || state.jobs.some((j) => j.workId === '1002' && j.status === 'paused');
      if (seeDone && seePaused) break;
      await wait(400);
    }
    ok(seeDone, '作业 1001 完成');
    ok(seePaused, '作业 1002 暂停并出现在 paused 列表');

    const matDir = path.join(SERVER_ROOT, 'data', 'materials', '1002');
    fs.mkdirSync(matDir, { recursive: true });
    fs.writeFileSync(path.join(matDir, '模板.docx'), 'template', 'utf8');
    const resume = await (await fetch(`${base}/api/jobs/1002/materials`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '已补充模板' }),
    })).json();
    ok(resume.ok === true, '提交补充资料接口');

    let reviewSeen = false;
    for (let i = 0; i < 60; i += 1) {
      state = await (await fetch(`${base}/api/state`)).json();
      const p = state.paused.find((x) => x.workId === '1002');
      if (p && p.kind === 'review') { reviewSeen = true; break; }
      await wait(300);
    }
    ok(reviewSeen, '补充资料后进入待确认提交');
    const confirm = await (await fetch(`${base}/api/jobs/1002/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json();
    ok(confirm.ok === true, '确认提交接口');
    let done2 = false;
    for (let i = 0; i < 60; i += 1) {
      state = await (await fetch(`${base}/api/state`)).json();
      const j = state.jobs.find((x) => x.workId === '1002');
      if (j && j.status === 'done') { done2 = true; break; }
      await wait(300);
    }
    ok(done2, '确认提交后 1002 完成');

    const settings = await (await fetch(`${base}/api/settings`)).json();
    ok(settings.ok === true && settings.config.autoSubmit === true, '设置接口可读');
    ok(settings.config.targetAccuracy === 0.99 && settings.config.reviewBeforeSubmit === true, '设置包含目标正确率与提交前确认');

    const env = await (await fetch(`${base}/api/env`)).json();
    ok(env.ok === true && Boolean(env.node && env.node.version), '环境检测接口', JSON.stringify(env.node));

    const privacy = await (await fetch(`${base}/api/privacy`)).json();
    ok(privacy.ok === true && Array.isArray(privacy.scopes) && privacy.scopes.length === 4, '隐私状态接口');

    const cleared = await (await fetch(`${base}/api/privacy/clear`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'logs' }),
    })).json();
    ok(cleared.ok === true, '清除日志接口');

    ok(fs.existsSync(path.join(SERVER_ROOT, 'data', 'server.json')), '服务写入 data/server.json（供启动器打开正确端口）');

    const ui = await fetch(`${base}/`);
    ok(ui.status === 200, '首页可访问（UI 或占位页）', String(ui.status));
  } finally {
    try { child.kill(); } catch {}
    await wait(500);
    try { child.kill('SIGKILL'); } catch {}
  }
}

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
