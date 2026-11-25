/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 跳过主观题 + 正确率不受影响 单测
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'D:/dsh2/中间产物/学习通作业助手/测试证据/skip-test';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
process.env.CX_APP_ROOT = ROOT;

const { Orchestrator } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/orchestrator.mjs').href);
const { DEFAULT_CONFIG } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/config.mjs').href);
const { EventHub } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/events.mjs').href);
const { createEngine } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/tests/fake/engine.mjs').href);

let passed = 0;
const ok = (c, n, d = '') => { if (c) { passed += 1; console.log('  ✓ ' + n); } else { console.error('  ✗ ' + n + ' ' + d); process.exitCode = 1; } };

const job = {
  workId: 'skip1',
  name: '主观题测试',
  status: 'paused',
  phase: 'paused',
  questions: [
    { qid: 's1', type: 'short', stem: '' },
    { qid: 's2', type: 'short', stem: '请说明循环结构' },
    { qid: 'q1', type: 'single', stem: '选择题' },
  ],
  answers: { answers: { s1: '原答案', s2: '原答案2', q1: 'A' } },
  skippedQuestions: [],
  accuracy: { target: 0.8, changed: [], originalAnswers: { q1: 'A' }, applied: true },
  paused: { kind: 'materials', reason: '缺少内容', skippedQuestions: [] },
};
const jobs = { get: () => job, save: () => job };
const events = new EventHub();
const orch = new Orchestrator({
  config: { ...DEFAULT_CONFIG, autoSubmit: true, targetAccuracy: 0.8 },
  events,
  jobs,
  loadSecrets: async () => ({}),
  saveConfig: () => {},
  engineFactory: async () => createEngine({}),
  cxFactory: async () => ({}),
});
const r = await orch.skipQuestion('skip1', 's1');
ok(r.ok === true, '主观题跳过接口成功');
ok(job.skippedQuestions.includes('s1'), '记录跳过题号');
ok(!job.answers.answers.s1, '主观题答案留空');
ok(job.accuracy.skippedCount === 0, '主观题跳过不影响目标正确率计数');
let rejected = false;
try { await orch.skipQuestion('skip1', 'q1'); } catch { rejected = true; }
ok(rejected, '客观题不允许跳过');

events.close();
console.log(`\n结果：${passed} 通过${process.exitCode ? '，有失败' : '，全部通过 ✓'}`);
fs.rmSync(ROOT, { recursive: true, force: true });
