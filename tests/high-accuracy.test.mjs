/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 高正确率 3 次投票单测
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'D:/dsh2/中间产物/学习通作业助手/测试证据/high-accuracy-test';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
process.env.CX_APP_ROOT = ROOT;

const { Orchestrator } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/orchestrator.mjs').href);
const { DEFAULT_CONFIG } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/config.mjs').href);
const { EventHub } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/events.mjs').href);

let passed = 0;
const ok = (c, n, d = '') => { if (c) { passed += 1; console.log('  ✓ ' + n); } else { console.error('  ✗ ' + n + ' ' + d); process.exitCode = 1; } };

const events = new EventHub();
const orch = new Orchestrator({
  config: { ...DEFAULT_CONFIG, highAccuracy: true, targetAccuracy: 0.99 },
  events,
  jobs: { save() {} },
  loadSecrets: async () => ({}),
  saveConfig: () => {},
  log: () => {},
});
const questions = [
  { qid: 'q1', index: 1, type: 'single' },
  { qid: 'q2', index: 2, type: 'multi' },
  { qid: 'q3', index: 3, type: 'blank' },
  { qid: 'q4', index: 4, type: 'single' },
];
const rounds = [
  { q1: 'A', q2: ['B', 'C'], q3: ['1'], q4: 'A' },
  { q1: 'A', q2: ['C', 'B'], q3: ['1'], q4: 'B' },
  { q1: 'B', q2: ['A', 'D'], q3: ['1'], q4: 'C' },
];
let round = 0;
const solveOnce = async () => ({ ok: true, answers: rounds[round++ % 3] });
const high = await orch._solveHighAccuracy({ solveOnce, questions });
ok(high.answers.q1 === 'A', '多数票：两次 A 一次 B → A', high.answers.q1);
ok(Array.isArray(high.answers.q2) && high.answers.q2.length === 2, '多选答案保留');
ok(high.answers.q3[0] === '1', '填空答案保留');
ok(high.ties.length === 1 && high.ties[0].qid === 'q4', '只有 q4 出现三次全不同（q1/q2/q3 有多数）', JSON.stringify(high.ties));

// q2 三次全不同 → ties
round = 0;
const rounds2 = [
  { q2: ['A'] }, { q2: ['B'] }, { q2: ['C', 'D'] },
];
const high2 = await orch._solveHighAccuracy({
  solveOnce: async () => ({ ok: true, answers: rounds2[round++ % 3] }),
  questions: [{ qid: 'q2', index: 2, type: 'multi' }],
});
ok(high2.ties.length === 1 && high2.ties[0].answers.length === 3, '三次全不同记录三个答案', JSON.stringify(high2.ties));
ok(['A', 'B', 'C,D'].includes(Array.isArray(high2.answers.q2) ? high2.answers.q2.join(',') : high2.answers.q2), '三次全不同时随机选用其中一个');

events.close();
console.log(`\n结果：${passed} 通过${process.exitCode ? '，有失败' : '，全部通过 ✓'}`);
fs.rmSync(ROOT, { recursive: true, force: true });
