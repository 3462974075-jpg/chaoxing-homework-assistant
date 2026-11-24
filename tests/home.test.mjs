/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 回归：隐私补丁与 DSH 默认空 patch 的合并（v1.4 修复“AI 引擎自检失败”）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergePrivacyPatch, PRIVACY_MARKER_BEGIN, PRIVACY_MARKER_END } from '../engine/privacy.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name + '：' + err.message);
    process.exitCode = 1;
  }
}

test('DSH 默认空 patch（[]）→ 替换为受管块，不留下非法 flow sequence', () => {
  const existing = '# Your patch layer for this dsh profile\n# ...\n[]\n';
  const merged = mergePrivacyPatch(existing);
  assert.ok(merged.includes(PRIVACY_MARKER_BEGIN));
  assert.ok(merged.includes(PRIVACY_MARKER_END));
  assert.ok(!merged.split('\n').some((line) => line.trim() === '[]'), '不应残留单独的 [] 行');
});

test('已有用户条目 + 隐私块 → 保留用户条目并追加受管块', () => {
  const existing = '- id: user-custom-row\n  config:\n    enabled: true\n';
  const merged = mergePrivacyPatch(existing);
  assert.ok(merged.includes('user-custom-row'));
  assert.ok(merged.includes(PRIVACY_MARKER_BEGIN));
});

test('重复合并幂等（文本不再变化）', () => {
  const once = mergePrivacyPatch('[]\n');
  const twice = mergePrivacyPatch(once);
  assert.strictEqual(twice, once);
});

test('受管块外残留 [] 也会被清理（旧版坏 home 修复）', () => {
  const broken = '[]\n# >>> chaoxing-homework privacy patch (auto-managed by engine)\n- id: session-log-deepseek\n  config:\n    enabled: false\n# <<< chaoxing-homework privacy patch\n';
  const merged = mergePrivacyPatch(broken);
  assert.ok(!merged.split('\n').some((line) => line.trim() === '[]'));
  assert.ok(merged.includes('session-log-deepseek'));
});

console.log(`\n结果：${passed} 通过${process.exitCode ? '，有失败' : '，全部通过 ✓'}`);
