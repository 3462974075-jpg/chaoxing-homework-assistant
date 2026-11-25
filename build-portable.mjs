// 打包绿色版到 output\学习通作业助手_绿色版_<日期>\
// 用法：node build-portable.mjs
// 产物：完整绿色目录（启动/停止/环境准备 + app/cx/engine/ui/bootstrap + docs + README）+ 同名 zip
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = process.env.CX_OUTPUT_ROOT
  ? path.resolve(process.env.CX_OUTPUT_ROOT)
  : path.join(HERE, 'output');
const PRODUCT_VERSION = 'v1.5.0';
const BUILD_ID = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const DEST = process.env.CX_BUILD_DEST
  ? path.resolve(process.env.CX_BUILD_DEST)
  : path.join(OUTPUT_ROOT, `学习通作业助手_绿色版_${BUILD_ID}`);
// CX_DIST=1：生成发给别人的“干净分发版”（不含 tests/bootstrap/开发文档，入口文件带序号，顶层只读说明）
const DIST = process.env.CX_DIST === '1';

const EXCLUDE_DIRS = new Set([
  'node_modules', '_tmp', '_probe', '_mock', '.test-home', 'test-root', 'test-root-e2e',
  'test-root-server', 'test-root-demo', 'test-cx', 'test-cx-app', 'test-cx-browser',
  'test-cx-http', 'test-cx-http2', 'test-engine-app', 'test-ui-real', 'test-ui-serve',
  'test-e2e-real-engine', 'portable-test', 'portable-test-empty', 'portable-test-netfail',
  'portable space test', 'install-test', '.git', 'edge-shot-profile',
]);
const EXCLUDE_FILE = /(^_|\.tmp$|\.log$|probe-|^e2e-real|^secrets\.dat$|^secrets\.json$)/i;

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('_') && entry.isDirectory()) continue;
    if (EXCLUDE_FILE.test(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function dirSize(p) {
  let total = 0;
  if (!fs.existsSync(p)) return 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, entry.name);
    total += entry.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return total;
}

console.log('目标目录：', DEST);
rmrf(DEST);
fs.mkdirSync(DEST, { recursive: true });

const copyDirs = DIST
  ? ['app', 'cx', 'engine', 'ui', 'docs']
  : ['app', 'cx', 'engine', 'ui', 'bootstrap', 'tests', 'docs'];
for (const dir of copyDirs) {
  const src = path.join(HERE, dir);
  if (!fs.existsSync(src)) { console.warn('跳过不存在的目录:', dir); continue; }
  copyDir(src, path.join(DEST, dir));
  console.log('已复制:', dir);
}

// 启动器脚本与中文文案提到根目录
const bootstrap = DIST ? path.join(HERE, 'bootstrap') : path.join(DEST, 'bootstrap');
const rootFiles = ['启动.cmd', '环境准备.cmd', 'start.ps1', 'prepare.ps1', 'env-detect.ps1', 'messages.json', 'README.md'];
if (fs.existsSync(bootstrap)) {
  for (const name of rootFiles) {
    const s = path.join(bootstrap, name);
    if (fs.existsSync(s) && name !== 'README.md') {
      fs.copyFileSync(s, path.join(DEST, name));
      console.log('提到根目录:', name);
    }
  }
}

// 停止服务（Lead 补充：绿色版后台服务需要一个明确的停止入口）
const stopMessages = {
  start: '正在停止学习通作业助手后台服务…',
  none: '没有发现正在运行的服务（可能已停止）。',
  stopped: '已停止学习通作业助手后台服务。',
  done: '可以关闭本窗口了。',
};
fs.writeFileSync(path.join(DEST, 'stop-messages.json'), JSON.stringify(stopMessages, null, 2), 'utf8');
const stopPs1 = `# Chaoxing Homework Assistant v1.5.0
# Copyright (c) 2026 sevenplayer (Lsy). All rights reserved.
# SPDX-License-Identifier: MIT
# Powered by DeepSeek (AI-assisted development)
# Stop the portable ChaoxingHomework background server (ASCII only; Chinese text in stop-messages.json)
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$msgFile = Join-Path $root 'stop-messages.json'
$m = $null
try { $m = Get-Content -LiteralPath $msgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
function Say($key, $fallback) {
    $text = $fallback
    if ($m -and $m.PSObject.Properties.Name -contains $key) { $text = [string]$m.$key }
    Write-Host $text
}
Say 'start' 'Stopping the background service...'

# Preferred source of truth: pid files written by start.ps1 / server.mjs
$pids = New-Object System.Collections.ArrayList
$dataDir = Join-Path $root 'data'
foreach ($name in @('server.json', 'app.pid')) {
    $f = Join-Path $dataDir $name
    if (-not (Test-Path -LiteralPath $f)) { continue }
    try {
        if ($name -eq 'app.pid') {
            $v = (Get-Content -LiteralPath $f -Raw).Trim()
            if ($v -match '^\\d+$') { [void]$pids.Add([int]$v) }
        } else {
            $j = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.pid -and [int]$j.pid -gt 0) { [void]$pids.Add([int]$j.pid) }
        }
    } catch { }
}
# Fallback: any node process whose command line mentions this root
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
foreach ($p in $procs) {
    $cl = [string]$p.CommandLine
    if ($cl -and $cl.Contains($root) -and $cl -match 'app[\\\\/]server\\.mjs') { [void]$pids.Add([int]$p.ProcessId) }
}
$unique = @($pids | Sort-Object -Unique)
$stopped = New-Object System.Collections.ArrayList
foreach ($id in $unique) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    if ($proc.ProcessName -ne 'node') { continue }
    try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; [void]$stopped.Add([string]$id) } catch { }
}
if ($stopped.Count -eq 0) {
    Say 'none' 'No running service was found.'
} else {
    Say 'stopped' ('Stopped the background service.')
    Remove-Item -LiteralPath (Join-Path $dataDir 'server.json') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $dataDir 'app.pid') -Force -ErrorAction SilentlyContinue
}
Say 'done' 'You can close this window now.'
`;
fs.writeFileSync(path.join(DEST, 'stop.ps1'), stopPs1, 'utf8');
fs.writeFileSync(path.join(DEST, '停止服务.cmd'), [
  '@echo off',
  'rem Chaoxing Homework Assistant v1.5.0',
  'rem Copyright (c) 2026 sevenplayer (Lsy). All rights reserved.',
  'rem SPDX-License-Identifier: MIT',
  'rem Powered by DeepSeek (AI-assisted development)',
  'chcp 65001 >nul',
  'title ChaoxingHomework - Stop',
  'setlocal',
  'set "PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
  'if not exist "%PS%" set "PS=powershell.exe"',
  '"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"',
  'if not "%CX_NO_PAUSE%"=="1" pause',
  'endlocal',
].join('\r\n'), 'utf8');
console.log('已生成: 停止服务.cmd / stop.ps1');

if (DIST) {
  // 使用须知 -> 顶层最显眼位置（00_ 前缀，资源管理器按名称排序在最前）
  const usageSrc = path.join(DEST, 'docs', '使用须知.md');
  const usage = fs.existsSync(usageSrc) ? fs.readFileSync(usageSrc, 'utf8') : '# 学习通作业助手\n';
  fs.writeFileSync(
    path.join(DEST, '00_先看这里_使用须知与步骤.txt'),
    '\uFEFF' + usage.replace(/\r?\n/g, '\r\n'),
    'utf8',
  );
  fs.copyFileSync(usageSrc, path.join(DEST, 'README.md'));
  // 清理开发文档，只保留截图目录
  const docsDir = path.join(DEST, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const e of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (e.isFile()) rmrf(path.join(docsDir, e.name));
    }
  }
  // 入口文件加序号，按 01/02/03 顺序双击即可
  const renames = [
    ['环境准备.cmd', '01_环境准备（首次）.cmd'],
    ['启动.cmd', '02_启动.cmd'],
    ['停止服务.cmd', '03_停止服务.cmd'],
  ];
  for (const [from, to] of renames) {
    const a = path.join(DEST, from);
    const b = path.join(DEST, to);
    if (fs.existsSync(a)) fs.renameSync(a, b);
  }
  // 分发包不需要开发/自测内容
  for (const rel of ['cx/test', 'engine/selftest.mjs', 'app/README.md', 'cx/README.md', 'engine/README.md', 'ui/README.md']) {
    rmrf(path.join(DEST, rel));
  }
  // 版权与作者文件放在一级目录
  for (const name of ['LICENSE', 'COPYRIGHT.txt', 'AUTHORS.md']) {
    const s = path.join(HERE, name);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(DEST, name));
  }
  console.log('分发版：已生成 00_先看这里 / 01_02_03 入口，已移除开发自测文件');
}

// README 与版本信息
const readmeSrc = path.join(DEST, 'docs', 'README-绿色版.md');
if (!DIST && fs.existsSync(readmeSrc)) fs.copyFileSync(readmeSrc, path.join(DEST, 'README.md'));
const versions = {
  产品: '学习通作业助手 · 绿色免安装版',
  版本: PRODUCT_VERSION,
  作者: '七号玩家（sevenplayer / Lsy）',
  版权: 'Copyright (c) 2026 七号玩家 (sevenplayer / Lsy)',
  协议: 'MIT License',
  PoweredBy: 'DeepSeek（AI 辅助开发）',
  构建时间: new Date().toISOString(),
  构建机器: os.hostname(),
  运行平台: 'Windows 10/11 x64',
  内置模块: DIST ? 'app / cx / engine / ui' : 'app / cx / engine / ui / bootstrap',
  说明: '程序目录可整目录复制；data/ 与 logs/ 为运行数据；卸载=删除目录',
};
fs.writeFileSync(path.join(DEST, '版本信息.json'), JSON.stringify(versions, null, 2), 'utf8');
fs.writeFileSync(path.join(DEST, 'VERSION.txt'), `${PRODUCT_VERSION}\n`, 'utf8');

// 自检：文件齐全 + 语法
const required = DIST
  ? [
      '00_先看这里_使用须知与步骤.txt', '01_环境准备（首次）.cmd', '02_启动.cmd', '03_停止服务.cmd',
      'start.ps1', 'prepare.ps1', 'messages.json', 'LICENSE', 'COPYRIGHT.txt', 'AUTHORS.md',
      'app/server.mjs', 'app/orchestrator.mjs', 'cx/index.mjs', 'engine/index.mjs', 'ui/index.html', 'README.md',
    ]
  : [
      '启动.cmd', '停止服务.cmd', '环境准备.cmd', 'start.ps1', 'prepare.ps1', 'messages.json',
      'app/server.mjs', 'app/orchestrator.mjs', 'cx/index.mjs', 'engine/index.mjs', 'ui/index.html', 'README.md',
    ];
let failed = false;
for (const rel of required) {
  const f = path.join(DEST, rel);
  if (!fs.existsSync(f)) { console.error('❌ 缺少必要文件:', rel); failed = true; continue; }
  if (rel.endsWith('.mjs')) {
    const r = spawnSync(process.execPath, ['--check', f], { stdio: 'ignore' });
    if (r.status !== 0) { console.error('❌ 语法检查失败:', rel); failed = true; }
  }
}
if (failed) process.exit(1);

// 自检：用打包目录自身启动 server（fake 学习通，不联网），检查状态/UI/隐私接口后清理
const smokeRoot = path.join(DEST, 'data');
fs.mkdirSync(smokeRoot, { recursive: true });
fs.writeFileSync(path.join(smokeRoot, 'config.json'), JSON.stringify({ port: 18799, autoSubmit: false }), 'utf8');
const { spawn } = await import('node:child_process');
const smokeSrv = spawn(process.execPath, [path.join(DEST, 'app', 'server.mjs')], {
  env: { ...process.env, CX_APP_ROOT: DEST, CX_FAKE_CX: '1' },
  stdio: 'ignore',
  windowsHide: true,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:18799';
let okSmoke = false;
try {
  for (let i = 0; i < 40; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })).ok) { okSmoke = true; break; }
    } catch {}
    await sleep(300);
  }
  if (okSmoke) {
    const state = await (await fetch(`${base}/api/state`)).json();
    const privacy = await (await fetch(`${base}/api/privacy`)).json();
    const home = await fetch(`${base}/`);
    const homeText = await home.text();
    console.log(`自检：state.phase=${state.phase} privacy.scopes=${privacy.scopes && privacy.scopes.length} 首页=${home.status}(${homeText.length}B)`);
    if (!state.ok || home.status !== 200 || !homeText.includes('学习通作业助手')) {
      console.error('❌ 打包目录自检失败（state/UI）');
      failed = true;
    }
  } else {
    console.error('❌ 打包目录自检失败（服务未起来）');
    failed = true;
  }
} finally {
  try { smokeSrv.kill(); } catch {}
  await sleep(500);
  try { smokeSrv.kill('SIGKILL'); } catch {}
  // 清理自检产生的运行数据，避免把测试 state 打进交付包
  rmrf(path.join(DEST, 'data'));
  rmrf(path.join(DEST, 'logs'));
}
if (failed) process.exit(1);

const mb = (dirSize(DEST) / 1024 / 1024).toFixed(1);
console.log(`\n打包完成：${DEST}（${mb} MB）`);
console.log('启动入口：启动.cmd    停止入口：停止服务.cmd    环境准备：环境准备.cmd');
