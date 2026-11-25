/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 错误“人话解析”单元测试
import assert from 'node:assert';
import { humanizeError } from '../app/errors.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '：' + e.message); process.exitCode = 1; }
}

test('缺少凭据 → 可操作提示', () => {
  const h = humanizeError(new Error('dsh: MISSING_CREDENTIAL: no API key for provider'));
  assert.strictEqual(h.code, 'MISSING_CREDENTIAL');
  assert.match(h.hint, /API Key/);
});

test('循环检测 → 资料不足提示', () => {
  const h = humanizeError({ code: 'LOOP_DETECTED', message: '检测到检索循环' });
  assert.strictEqual(h.code, 'LOOP_DETECTED');
  assert.match(h.hint, /资料/);
});

test('自动脱敏 Key', () => {
  const h = humanizeError('auth failed for sk-1234567890abcdefghijklmnop');
  assert.ok(!h.raw.includes('sk-1234567890abcdefghijklmnop'));
  assert.ok(h.raw.includes('sk-***'));
});

test('未知错误保留首行', () => {
  const h = humanizeError('some totally unknown failure');
  assert.match(h.message, /some totally unknown failure/);
  assert.strictEqual(h.code, 'UNKNOWN');
});

console.log(`\n结果：${passed} 通过${process.exitCode ? '，有失败' : '，全部通过 ✓'}`);
