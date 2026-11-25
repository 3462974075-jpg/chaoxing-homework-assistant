/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 目标正确率（近似）单元测试：按题数、只作用于客观选择题/填空题
import assert from 'node:assert';
import * as acc from '../app/accuracy.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '：' + e.message); process.exitCode = 1; }
}

const questions = [
  { qid: 'q1', type: 'single', opts: [{ key: 'A' }, { key: 'B' }] },
  { qid: 'q2', type: 'multi', opts: [{ key: 'A' }, { key: 'B' }, { key: 'C' }] },
  { qid: 'q3', type: 'judge', opts: [] },
  { qid: 'q4', type: 'blank', blanks: ['x'] },
  { qid: 'q5', type: 'single', opts: [{ key: 'A' }, { key: 'B' }] },
  { qid: 'q6', type: 'short' },
];
const answers = { answers: { q1: 'A', q2: 'AB', q3: 'true', q4: ['x'], q5: 'B', q6: '主观题答案' } };

test('99% 不故意改错', () => {
  const plan = acc.planTargetAccuracy({ questions, answers, target: 0.99 });
  assert.strictEqual(plan.wrongCount, 0);
  assert.strictEqual(plan.selected.length, 0);
});

test('80% 按题数计算（5 道客观题 → 1 道改错）', () => {
  const plan = acc.planTargetAccuracy({ questions, answers, target: 0.8 });
  assert.strictEqual(plan.eligibleCount, 5);
  assert.strictEqual(plan.wrongCount, 1);
  assert.strictEqual(plan.selected.length, 1);
});

test('30% 按题数计算（5 道客观题 → 4 道改错）', () => {
  const plan = acc.planTargetAccuracy({ questions, answers, target: 0.3 });
  assert.strictEqual(plan.wrongCount, 4);
});

test('排除手填题，且不会改主观题', () => {
  const plan = acc.planTargetAccuracy({ questions, answers, target: 0.6, excludeQids: ['q1', 'q6'] });
  assert.ok(!plan.selected.some((x) => x.qid === 'q1'));
  assert.ok(!plan.selected.some((x) => x.qid === 'q6'));
});

test('选择题改错后一定与正确答案不同', () => {
  const plan = acc.planTargetAccuracy({ questions, answers, target: 0.3 });
  const result = acc.applyTargetAccuracyFor({ plan, answers: { answers: { ...answers.answers } }, questions });
  assert.ok(result.changed.length >= 1);
  for (const c of result.changed) {
    const before = Array.isArray(c.before) ? c.before.join('') : String(c.before);
    const after = Array.isArray(c.after) ? c.after.join('') : String(c.after);
    assert.notStrictEqual(after, before, c.qid + ' 改错后不应相同');
  }
});

test('填空可注入模型生成的错误答案', () => {
  const onlyBlank = [questions[3]];
  const onlyAnswers = { answers: { q4: ['x'] } };
  const plan = acc.planTargetAccuracy({ questions: onlyBlank, answers: onlyAnswers, target: 0.6 });
  const result = acc.applyTargetAccuracyFor({ plan, answers: { answers: { q4: ['x'] } }, questions: onlyBlank, blankWrong: { q4: '故意错误' } });
  assert.strictEqual(result.changed.length, 1);
  assert.strictEqual(result.changed[0].qid, 'q4');
  assert.strictEqual(result.changed[0].after, '故意错误');
});

test('目标档位归一化', () => {
  assert.strictEqual(acc.normalizeTargetAccuracy(0.85), 0.8);
  assert.strictEqual(acc.normalizeTargetAccuracy(0.31), 0.3);
  assert.strictEqual(acc.normalizeTargetAccuracy('bad'), 0.99);
});

console.log(`\n结果：${passed} 通过${process.exitCode ? '，有失败' : '，全部通过 ✓'}`);
