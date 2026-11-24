/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// Windows DPAPI（CurrentUser）加密保存学习通账密与 DeepSeek API Key。
// 实现说明：本产品所在机器可能也处于受限沙箱（开发会话）中，Node 的 pipe spawn 会 EPERM，
// 因此统一用「环境变量传入 + 文件接收输出」的 stdio 形态调用 powershell.exe。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DIRS, isWindows } from './paths.mjs';

const SECRETS_FILE = path.join(DIRS.data, 'secrets.dat');
const PS = process.env.CX_POWERSHELL || 'powershell.exe';

const ENC_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Security',
  '  $bytes = [Convert]::FromBase64String($env:DPAPI_INPUT_B64)',
  '  $prot = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, \'CurrentUser\')',
  '  [IO.File]::WriteAllText($env:DPAPI_OUT, [Convert]::ToBase64String($prot), [Text.Encoding]::ASCII)',
  '} catch {',
  '  [IO.File]::WriteAllText($env:DPAPI_OUT, "ERR:" + $_.Exception.Message, [Text.Encoding]::UTF8)',
  '  exit 1',
  '}',
].join('; ');

const DEC_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Security',
  '  $bytes = [Convert]::FromBase64String($env:DPAPI_INPUT_B64)',
  '  $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, \'CurrentUser\')',
  '  [IO.File]::WriteAllText($env:DPAPI_OUT, [Convert]::ToBase64String($plain), [Text.Encoding]::ASCII)',
  '} catch {',
  '  [IO.File]::WriteAllText($env:DPAPI_OUT, "ERR:" + $_.Exception.Message, [Text.Encoding]::UTF8)',
  '  exit 1',
  '}',
].join('; ');

function withTemp(filePrefix) {
  fs.mkdirSync(DIRS.tmp, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  return {
    out: path.join(DIRS.tmp, `${filePrefix}-${id}.b64`),
    err: path.join(DIRS.tmp, `${filePrefix}-${id}.log`),
  };
}

function runPowerShell(script, inputB64, outFile, errFile) {
  return new Promise((resolve, reject) => {
    // 注意：输出文件由 PowerShell 自己创建写入。Node 不要提前 open，否则 Windows 上
    // 会因文件被占用导致 WriteAllText 失败（开发沙箱里 spawn 也不能用管道）。
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, DPAPI_INPUT_B64: inputB64, DPAPI_OUT: outFile },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        let detail = '';
        try { detail = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
        reject(new Error(`DPAPI 调用失败(code=${code}): ${detail}`));
      }
    });
  });
}

function cleanupTemp(t) {
  for (const f of [t.out, t.err]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

export async function protectText(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const t = withTemp('enc');
  try {
    await runPowerShell(ENC_SCRIPT, b64, t.out, t.err);
    const blob = fs.readFileSync(t.out, 'utf8').trim();
    if (!blob || blob.startsWith('ERR:')) throw new Error(blob || '空输出');
    return blob;
  } finally {
    cleanupTemp(t);
  }
}

export async function unprotectText(blob) {
  const t = withTemp('dec');
  try {
    await runPowerShell(DEC_SCRIPT, blob.trim(), t.out, t.err);
    const b64 = fs.readFileSync(t.out, 'utf8').trim();
    if (!b64 || b64.startsWith('ERR:')) throw new Error(b64 || '空输出');
    return Buffer.from(b64, 'base64').toString('utf8');
  } finally {
    cleanupTemp(t);
  }
}

export function hasSecretsFile() {
  return fs.existsSync(SECRETS_FILE);
}

/** 读取全部机密；文件不存在返回 null，损坏时抛错（由调用方决定提示）。 */
export async function getSecrets() {
  if (!isWindows) throw new Error('本产品仅支持 Windows（DPAPI 需要）');
  if (!fs.existsSync(SECRETS_FILE)) return null;
  const blob = fs.readFileSync(SECRETS_FILE, 'utf8').trim();
  if (!blob) return null;
  const text = await unprotectText(blob);
  const obj = JSON.parse(text);
  return obj && typeof obj === 'object' ? obj : {};
}

export async function saveSecrets(next) {
  if (!isWindows) throw new Error('本产品仅支持 Windows（DPAPI 需要）');
  const blob = await protectText(JSON.stringify(next || {}));
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, blob, 'utf8');
  _summaryCache = null;
  return next;
}

export async function mergeSecrets(patch) {
  const cur = (await getSecrets()) || {};
  const merged = { ...cur, ...(patch || {}) };
  await saveSecrets(merged);
  return merged;
}

export async function clearSecrets() {
  try { fs.unlinkSync(SECRETS_FILE); } catch {}
  _summaryCache = null;
}

let _summaryCache = null;

export async function secretSummary(force = false) {
  if (!force && _summaryCache && Date.now() - _summaryCache.at < 5000) return _summaryCache.value;
  let s = null;
  try { s = await getSecrets(); } catch { s = null; }
  const value = {
    hasFile: hasSecretsFile(),
    aiConfigured: Boolean(s && s.deepseek && s.deepseek.apiKey),
    chaoxingConfigured: Boolean(s && s.chaoxing && s.chaoxing.username && s.chaoxing.password),
    username: s && s.chaoxing ? String(s.chaoxing.username || '') : '',
  };
  _summaryCache = { at: Date.now(), value };
  return value;
}
