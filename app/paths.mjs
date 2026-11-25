/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 路径与目录解析：开发期（中间产物/学习通作业助手/{app,cx,engine,ui}）
// 与安装后（<root>/app + <root>/cx 等）两种布局都兼容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MODULE_ROOT = path.resolve(APP_DIR, '..');

function resolveModuleDir(name) {
  const candidates = [path.join(APP_DIR, name), path.join(MODULE_ROOT, name)];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[1];
}

export const UI_DIR = resolveModuleDir('ui');
export const CX_DIR = resolveModuleDir('cx');
export const ENGINE_DIR = resolveModuleDir('engine');
export const BOOTSTRAP_DIR = resolveModuleDir('bootstrap');

const portableRoot = path.resolve(APP_DIR, '..');
const defaultRoot = portableRoot;
export const ROOT = path.resolve(process.env.CX_APP_ROOT || defaultRoot);

export const DIRS = {
  root: ROOT,
  app: APP_DIR,
  data: path.join(ROOT, 'data'),
  logs: path.join(ROOT, 'logs'),
  dsh: path.join(ROOT, 'dsh'),
  runtime: path.join(ROOT, 'runtime'),
  dshHome: path.join(ROOT, 'data', 'dsh-home'),
  chaoxingData: path.join(ROOT, 'data', 'chaoxing'),
  edgeProfile: path.join(ROOT, 'data', 'edge-profile'),
  jobs: path.join(ROOT, 'data', 'jobs'),
  materials: path.join(ROOT, 'data', 'materials'),
  downloads: path.join(ROOT, 'data', 'downloads'),
  tmp: path.join(ROOT, 'data', 'tmp'),
};

export function ensureDirs(extra = []) {
  const list = [
    DIRS.data, DIRS.logs, DIRS.jobs, DIRS.materials, DIRS.downloads,
    DIRS.tmp, DIRS.dshHome, DIRS.chaoxingData, DIRS.edgeProfile, ...extra,
  ];
  for (const d of list) fs.mkdirSync(d, { recursive: true });
}

/** 找可执行的 DSH 入口（必须是可用 node 直接 spawn 的 lib/bin.js；.cmd 会被换算，绝不直接返回）。 */
export function findDshBin() {
  const candidates = [
    path.join(DIRS.dsh, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(DIRS.dsh, 'lib', 'bin.js'),
    path.join(DIRS.runtime, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  // start.ps1 可能把 CX_DSH 设为 dsh.cmd：换算成同目录下的 lib/bin.js，避免 `node dsh.cmd` 崩溃
  const envDsh = process.env.CX_DSH || '';
  if (envDsh) {
    if (/\.(cmd|bat)$/i.test(envDsh)) {
      candidates.push(path.join(path.dirname(envDsh), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    } else {
      candidates.push(envDsh);
    }
  }
  candidates.push(
    path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
    ),
  );
  for (const c of candidates) {
    if (c && /\.js$/i.test(c) && fs.existsSync(c)) return c;
  }
  return null;
}

export const isWindows = process.platform === 'win32';
