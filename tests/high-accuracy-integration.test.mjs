/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 高正确率全流程：三次投票出现全不同 → 暂停人工复核
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'D:/dsh2/中间产物/学习通作业助手/测试证据/high-accuracy-int-test';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
process.env.CX_APP_ROOT = ROOT;

const { Orchestrator } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/orchestrator.mjs').href);
const { DEFAULT_CONFIG } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/config.mjs').href);
const { EventHub } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/events.mjs').href);
const { JobStore } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/jobs.mjs').href);
const { createCx } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/tests/fake/cx.mjs').href);
const { createEngine } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/tests/fake/engine.mjs').href);

let passed = 0;
const ok = (c, n, d = '') => { if (c) { passed += 1; console.log('  ✓ ' + n); } else { console.error('  ✗ ' + n + ' ' + d); process.exitCode = 1; } };

const baseEngine = await createEngine({});
let round = 0;
const engine = {
  ...baseEngine,
  async solveObjective({ work, questions }) {
    round += 1;
    const answers = {};
    for (const q of questions) {
      if (q.type === 'single') answers[q.qid] = ['A', 'B', 'C'][(round - 1) % 3];
      else if (q.type === 'multi') answers[q.qid] = (q.opts || []).map((o) => o.key).join('');
      else if (q.type === 'blank') answers[q.qid] = (q.blanks || []).map(() => '固定');
      else answers[q.qid] = 'A';
    }
    return { answers, sources: [{ title: 'round', url: 'https://example.com' }], needMaterials: [] };
  },
};
const jobs = new JobStore();
const events = new EventHub();
const orch = new Orchestrator({
  config: { ...DEFAULT_CONFIG, autoSubmit: true, targetAccuracy: 0.99, highAccuracy: true },
  events, jobs,
  loadSecrets: async () => ({}),
  saveConfig: () => {},
  cxFactory: async () => createCx({}),
  engineFactory: async () => engine,
});
await orch.refresh({});
await orch.run(['1001']);
const job = jobs.get('1001');
ok(round === 3, '客观题实际调用了 3 次 AI', String(round));
ok(job.highAccuracy && job.highAccuracy.enabled === true, '记录高正确率已启用');
ok(job.highAccuracy.ties.length === 1, '三次全不同的题被记录', JSON.stringify(job.highAccuracy.ties));
ok(job.status === 'paused' && job.paused.kind === 'review', '出现全不同答案后暂停人工复核', job.status + '/' + (job.paused && job.paused.kind));
ok(job.paused.highAccuracyTies && job.paused.highAccuracyTies.length === 1, '暂停详情包含三答案');
ok(!job.result || job.result.submitted !== true, '未自动提交');

events.close();
console.log(`\n结果：${passed} 通过${process.exitCode ? '，有失败' : '，全部通过 ✓'}`);
fs.rmSync(ROOT, { recursive: true, force: true });
