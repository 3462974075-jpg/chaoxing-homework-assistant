/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 公式截图兜底流程单元测试（stub 截图/视觉，不访问真实页面）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'D:/dsh2/中间产物/学习通作业助手/测试证据/formula-rescue-test';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
process.env.CX_APP_ROOT = ROOT;

const { Orchestrator } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/orchestrator.mjs').href);
const { DEFAULT_CONFIG } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/config.mjs').href);
const { EventHub } = await import(pathToFileURL('D:/dsh2/中间产物/学习通作业助手/app/events.mjs').href);

let passed = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { console.error('  ✗ ' + name + ' ' + detail); process.exitCode = 1; }
};

const events = new EventHub();
const emitted = [];
const orch = new Orchestrator({
  config: { ...DEFAULT_CONFIG },
  events,
  jobs: { save() {}, get() {} },
  loadSecrets: async () => ({}),
  saveConfig: () => {},
  log: () => {},
});
const job = { workId: 'math1', name: '高等数学作业', formulaRescueAttempted: false };
const cx = { captureQuestionScreenshots: async () => [{ path: path.join(ROOT, 'question-01.png'), index: 1, qid: 'q1' }] };
const engine = {
  ocrImages: async () => ({
    texts: [{ text: '第1题 求 $f(x)=x^2$ 的导数。 [[FORMULA_UNCERTAIN]]' }],
    errors: [],
  }),
};
const emit = (type, data) => emitted.push({ type, data });
const r = await orch._tryFormulaRescue({ work: { workId: 'math1' }, job, cx, engine, materialsText: '已有资料', emit });

ok(r.ok === true, '截图识别成功');
ok(r.materialsText.includes('作业页面截图 OCR'), 'OCR 文本已加入资料');
ok(r.text === undefined && r.uncertain === true, '复杂公式标记被识别');
ok(job.formulaWarning && String(job.formulaWarning.text).includes('x^2'), '公式警告已保存');
ok(emitted.some((e) => e.type === 'formula-warning'), '已发出 formula-warning 事件供 UI 弹窗');
ok(!r.ocrText.includes('FORMULA_UNCERTAIN'), '标记已从识别文本中移除');

// 第二次调用应被去重
const r2 = await orch._tryFormulaRescue({ work: {}, job, cx, engine, materialsText: '', emit });
ok(r2.ok === false && r2.reason === 'already-attempted', '每次作业只尝试一次截图兜底');

events.close();
console.log(`\n结果：${passed} 通过${process.exitCode ? '，有失败' : '，全部通过 ✓'}`);
fs.rmSync(ROOT, { recursive: true, force: true });
