/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 学习通 Cookie 的加密存储（DPAPI），避免明文 session.json 落盘。
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './paths.mjs';
import { protectText, unprotectText } from './secret.mjs';

const SESSION_DAT = path.join(DIRS.data, 'session.dat');

export function createSessionStore() {
  return {
    file: SESSION_DAT,
    async load() {
      if (!fs.existsSync(SESSION_DAT)) return null;
      const blob = fs.readFileSync(SESSION_DAT, 'utf8').trim();
      if (!blob) return null;
      const text = await unprotectText(blob);
      const obj = JSON.parse(text);
      return obj && typeof obj === 'object' ? obj : null;
    },
    async save(obj) {
      const blob = await protectText(JSON.stringify(obj || {}));
      fs.mkdirSync(path.dirname(SESSION_DAT), { recursive: true });
      fs.writeFileSync(SESSION_DAT, blob, 'utf8');
    },
    async clear() {
      try { fs.unlinkSync(SESSION_DAT); } catch {}
    },
    exists() {
      return fs.existsSync(SESSION_DAT);
    },
  };
}

export { SESSION_DAT };
