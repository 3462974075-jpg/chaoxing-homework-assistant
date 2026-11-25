/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 构建 GitHub 开源源码目录（不含运行数据、测试证据、API Key）。
// 用法：node build-source.mjs
// 产物：<HERE>/dist-staging/源码/学习通作业助手_源码_v1.7.2/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = 'v1.7.2';
const STAGE_ROOT = process.env.CX_SOURCE_DEST
  ? path.resolve(process.env.CX_SOURCE_DEST)
  : path.join(HERE, 'dist-staging', '源码', '学习通作业助手_源码_' + VERSION);

const SKIP_DIRS = new Set([
  'node_modules', '_tmp', '_probe', '_mock', 'edge-profile', 'proof', 'data', 'logs',
  'dist-staging', 'build-staging', 'runtime', 'dsh', '.git',
  'portable-test', 'portable-test-empty', 'portable-test-netfail', 'portable space test',
  '测试证据', '用户数据备份_20261123',
]);

const SKIP_FILES = /^(probe-|e2e-real-engine\.mjs$)/i;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('_') && entry.isDirectory()) continue;
    if (entry.isFile() && SKIP_FILES.test(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
fs.mkdirSync(STAGE_ROOT, { recursive: true });
for (const dir of ['app', 'cx', 'engine', 'ui', 'bootstrap', 'tests', 'docs']) {
  const src = path.join(HERE, dir);
  if (!fs.existsSync(src)) continue;
  copyDir(src, path.join(STAGE_ROOT, dir));
  console.log('已复制:', dir);
}
// 源码包保留 ui/_mock 的测试脚本，但不要 Edge 配置/截图
const mockSrc = path.join(HERE, 'ui', '_mock');
const mockDst = path.join(STAGE_ROOT, 'ui', '_mock');
if (fs.existsSync(mockSrc)) {
  fs.mkdirSync(mockDst, { recursive: true });
  for (const entry of fs.readdirSync(mockSrc, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(mockSrc, entry.name), path.join(mockDst, entry.name));
  }
}
// 开发自测 README 里是作者本机路径，不进 GitHub 源码包
for (const rel of ['app/README.md', 'cx/README.md', 'engine/README.md', 'ui/README.md', 'tests/README.md']) {
  fs.rmSync(path.join(STAGE_ROOT, rel), { force: true });
}
// 测试记录含个人 uid，不进公开源码
fs.rmSync(path.join(STAGE_ROOT, 'docs', '测试记录.md'), { force: true });

for (const name of [
  'README.md', 'CHANGELOG.md', 'LICENSE', 'COPYRIGHT.txt', 'AUTHORS.md', '.gitignore',
  'build-portable.mjs', 'build-source.mjs', 'VERSION.txt', 'package.json',
]) {
  const src = path.join(HERE, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE_ROOT, name));
}
fs.writeFileSync(path.join(STAGE_ROOT, 'VERSION.txt'), VERSION + '\n', 'utf8');
// GitHub 源码里不保留开发期一次性脚本
fs.rmSync(path.join(STAGE_ROOT, 'add-headers.mjs'), { force: true });
// 防止从源码目录运行 smoke/build 后把测试数据带进源码包
for (const rel of ['test-root', 'test-root-e2e', 'test-root-server', 'data', 'logs']) {
  fs.rmSync(path.join(STAGE_ROOT, rel), { recursive: true, force: true });
}

const files = [];
function count(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) count(f);
    else files.push(f);
  }
}
count(STAGE_ROOT);
console.log('源码目录已生成:', STAGE_ROOT, files.length + ' files');
