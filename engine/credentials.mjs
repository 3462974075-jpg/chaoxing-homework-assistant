/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * credentials.mjs — 私有 DSH_HOME 与 `.credentials.yaml` 管理
 *
 * 文件格式（已确认，见设计说明第 2 节）：
 *
 *   version: 1
 *   refs:
 *     DEEPSEEK_API_KEY: sk-...
 *   records: {}
 *
 * 安全约定（务必遵守）：
 *   - 绝不把 API Key 打印到 stdout / 日志 / 异常消息；对外只暴露「是否已配置」。
 *   - 原子写：临时文件 + fsync + rename；不破坏同目录其它字段。
 *   - 不复制/不读取 probe-dsh-home 的真实凭据；调用方负责把 key 传进来。
 */

import fs from 'node:fs';
import path from 'node:path';

import { ensurePrivacyProfile } from './privacy.mjs';

export const CREDENTIALS_FILENAME = '.credentials.yaml';
export const API_KEY_REF = 'DEEPSEEK_API_KEY';

/** 校验 API Key 形状：sk- 开头、长度合理、无空白 */
export function validateApiKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return { ok: false, reason: 'API Key 为空' };
  if (/\s/.test(key)) return { ok: false, reason: 'API Key 含空白字符' };
  if (!key.startsWith('sk-')) return { ok: false, reason: 'API Key 必须以 sk- 开头' };
  if (key.length < 20) return { ok: false, reason: 'API Key 长度过短，疑似不完整' };
  if (key.length > 400) return { ok: false, reason: 'API Key 过长' };
  if (!/^sk-[A-Za-z0-9_\-.]+$/.test(key)) return { ok: false, reason: 'API Key 含非法字符' };
  return { ok: true, reason: null };
}

/** 脱敏展示（任何日志都只能用这个；不保留尾部字符） */
export function maskKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey : '';
  if (!key) return '(空)';
  return `sk-***(${key.length} chars)`;
}

export function credentialsPath(dshHome) {
  return path.join(dshHome, CREDENTIALS_FILENAME);
}

/**
 * 极简 YAML 读取：只服务于 credentials 文件，不追求通用性。
 * 返回 { version, refs:{name:value}, recordsRaw:string, raw:string }
 */
export function parseCredentialsYaml(text) {
  const result = { version: 1, refs: {}, recordsRaw: '', raw: text || '' };
  const lines = String(text || '').split(/\r?\n/);
  let section = null;
  const recordsLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top && !/^\s/.test(line)) {
      section = top[1];
      if (section === 'version') {
        const v = Number(top[2]);
        if (Number.isFinite(v)) result.version = v;
      }
      continue;
    }
    if (section === 'refs') {
      const ref = /^\s+([A-Za-z_][\w-]*):\s*(.+?)\s*$/.exec(line);
      if (ref) {
        let value = ref[2];
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        result.refs[ref[1]] = value;
      }
      continue;
    }
    if (section === 'records') {
      // 保留 records 原样（可能是多级映射），遇到下一个顶层键时停止
      recordsLines.push(line);
    }
  }
  result.recordsRaw = recordsLines.join('\n');
  return result;
}

function yamlScalar(value) {
  const s = String(value ?? '');
  if (!s) return "''";
  // API Key / 常规 token 都是安全字符；其它情况用单引号包一层（单引号内 '' 转义）
  if (/^[A-Za-z0-9_.:/@+\-=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** 构造 credentials YAML 文本（refs 合并已有，records 原样保留） */
export function renderCredentialsYaml({ apiKey, existingText = '' }) {
  const existing = parseCredentialsYaml(existingText);
  const refs = { ...existing.refs };
  if (apiKey) refs[API_KEY_REF] = apiKey;
  const lines = ['version: 1'];
  if (Object.keys(refs).length) {
    lines.push('refs:');
    for (const [name, value] of Object.entries(refs)) lines.push(`  ${name}: ${yamlScalar(value)}`);
  } else {
    lines.push('refs: {}');
  }
  if (existing.recordsRaw.trim()) {
    lines.push('records:');
    lines.push(existing.recordsRaw);
  } else {
    lines.push('records: {}');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 原子写文件：同目录临时文件 → fsync → rename。
 * Windows 下 rename 覆盖已存在文件由 Node（MoveFileEx REPLACE_EXISTING）处理；
 * 若目标被占用则回退为「先删后改名」并抛出可读错误。
 */
export function writeFileAtomic(targetPath, content, { mode = 0o600 } = {}) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w', mode);
    fs.writeFileSync(fd, content, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* 某些文件系统不支持 fsync，忽略 */
    }
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      if (err && (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES')) {
        fs.rmSync(targetPath, { force: true });
        fs.renameSync(tmpPath, targetPath);
      } else {
        throw err;
      }
    }
    try {
      fs.chmodSync(targetPath, mode);
    } catch {
      /* Windows 上 chmod 语义有限，忽略 */
    }
    return { filePath: targetPath, bytes: Buffer.byteLength(content, 'utf8') };
  } catch (err) {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`写入凭据文件失败：${err && err.message}`);
  }
}

/**
 * 创建/更新私有 DSH_HOME 并写入 `.credentials.yaml`，同时写入 headless 隐私补丁
 * （禁用 session-log-deepseek 上传与 session-telemetry-otel 遥测，见 privacy.mjs）。
 * 只返回「已配置」等元信息，不返回值、不回显 Key。
 *
 * @param {{dshHome:string, apiKey?:string, log?:(m:string)=>void, requireKey?:boolean, model?:any}} opts
 * @returns {{ok:boolean, dshHome:string, credentialsPath:string, configured:boolean, created:boolean,
 *            updated:boolean, keyMasked:string|null, privacy:any}}
 */
export function ensureHome({ dshHome, apiKey, log, requireKey = false, model = null } = {}) {
  if (!dshHome) throw new Error('ensureHome：缺少 dshHome');
  const target = credentialsPath(dshHome);
  const dirExists = fs.existsSync(dshHome);
  fs.mkdirSync(dshHome, { recursive: true });

  let existingText = '';
  if (fs.existsSync(target)) {
    try {
      existingText = fs.readFileSync(target, 'utf8');
    } catch (err) {
      throw new Error(`读取已有凭据失败：${err && err.message}`);
    }
  }

  let key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key) {
    const check = validateApiKey(key);
    if (!check.ok) throw new Error(`API Key 不合法：${check.reason}`);
  } else if (requireKey) {
    const existing = parseCredentialsYaml(existingText);
    if (!existing.refs[API_KEY_REF]) throw new Error('缺少 API Key，且 DSH_HOME 内尚未配置');
  }

  // 没有新 Key 且文件已存在：保持原样（不动 records，避免破坏已有登录态）
  const alreadyConfigured = (() => {
    if (!fs.existsSync(target)) return false;
    const parsed = parseCredentialsYaml(existingText);
    return Boolean(parsed.refs[API_KEY_REF]);
  })();

  let result;
  if (!key && alreadyConfigured) {
    result = {
      ok: true,
      dshHome,
      credentialsPath: target,
      configured: true,
      created: !dirExists,
      updated: false,
      keyMasked: null,
    };
  } else {
    const text = renderCredentialsYaml({ apiKey: key, existingText });
    writeFileAtomic(target, text, { mode: 0o600 });
    log?.(
      `已写入 DSH_HOME 凭据：${target}` +
        (key ? `（key=${maskKey(key)}${alreadyConfigured ? '，已更新' : ''}）` : '（未提供新 key）')
    );
    result = {
      ok: true,
      dshHome,
      credentialsPath: target,
      configured: Boolean(key) || alreadyConfigured,
      created: !dirExists,
      updated: Boolean(key),
      keyMasked: key ? maskKey(key) : null,
    };
  }

  // 隐私隔离：无论是否更新凭据，都保证 headless profile 的隐私补丁存在。
  // 失败不阻断凭据写入，但显式记录（调用方可据此提示用户）。
  let privacy;
  try {
    privacy = ensurePrivacyProfile({ dshHome, model, log });
  } catch (err) {
    log?.(`写入 headless 隐私补丁失败：${err && err.message}`);
    privacy = { error: err && err.message, privacyComplete: false };
  }
  return { ...result, privacy };
}

/**
 * 只返回「是否已配置 DEEPSEEK_API_KEY」——绝不返回值。
 * @returns {{configured:boolean, dshHome:string, credentialsPath:string, exists:boolean, refNames:string[]}}
 */
export function readKeyRef(dshHome) {
  if (!dshHome) throw new Error('readKeyRef：缺少 dshHome');
  const target = credentialsPath(dshHome);
  const exists = fs.existsSync(target);
  let refNames = [];
  let configured = false;
  if (exists) {
    let text = '';
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch {
      text = '';
    }
    const parsed = parseCredentialsYaml(text);
    refNames = Object.keys(parsed.refs); // 只有名字，没有值
    configured = Boolean(parsed.refs[API_KEY_REF]);
  }
  return { configured, dshHome, credentialsPath: target, exists, refNames };
}

/** 从现有 home 取出某个 ref 的值——仅供「迁移/自检」内部使用，禁止日志回显 */
export function _readRefValueForMigration(dshHome, refName = API_KEY_REF) {
  const target = credentialsPath(dshHome);
  if (!fs.existsSync(target)) return null;
  const parsed = parseCredentialsYaml(fs.readFileSync(target, 'utf8'));
  return parsed.refs[refName] ?? null;
}

/** 检查 DSH_HOME 是否像一个可用的 DSH home（有 profiles/ 或已有凭据） */
export function describeHome(dshHome) {
  return {
    dshHome,
    exists: fs.existsSync(dshHome),
    hasCredentials: fs.existsSync(credentialsPath(dshHome)),
    hasProfilesDir: fs.existsSync(path.join(dshHome, 'profiles')),
  };
}
