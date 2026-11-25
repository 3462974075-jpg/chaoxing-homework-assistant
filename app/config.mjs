/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 配置读写（data/config.json）。敏感信息不放这里，见 secret.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './paths.mjs';

const CONFIG_FILE = path.join(DIRS.data, 'config.json');

export const DEFAULT_CONFIG = {
  port: 8765,
  autoSubmit: true,          // 默认全自动提交（用户要求）；设置里可关
  targetAccuracy: 0.99,      // 目标正确率（近似）：仅客观选择题/填空题，按题数比例；无法保证真实正确率
  highAccuracy: false,       // v1.7.2：客观题 3 次求解投票（仅 99% 正确率时可用）
  reviewBeforeSubmit: true,  // 主观/附件题提交前暂停确认（v1.5）
  model: { provider: 'deepseek-official', model: 'deepseek-flash' },
  engineTimeoutSec: 300,
  loginTimeoutSec: 300,
  workTimeoutSec: 300,
  dshVersion: '0.1.7-rc.2',
  httpOnly: false,           // 仅调试/受限环境：课程与作业列表走纯 HTTP（不启动 Edge）
  lastCourseRefresh: null,
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const text = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
      return deepMerge(DEFAULT_CONFIG, JSON.parse(text));
    }
  } catch (e) {
    console.warn('[config] 读取失败，使用默认配置:', e.message);
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return cfg;
}
