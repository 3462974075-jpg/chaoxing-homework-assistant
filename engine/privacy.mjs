/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * privacy.mjs — 私有 DSH_HOME 的「隐私隔离」补丁（免安装绿色版要求）
 *
 * 目标：让 headless 引擎**不向 DeepSeek 上传会话日志 / 遥测**。
 *
 * 依据（已核对本机已安装 @deepseek-ai/dsh@0.1.7-rc.2 的源码与 README）：
 *   1) `@deepseek-ai/dsh-session-log-deepseek`（row id: `session-log-deepseek`）
 *      负责把 Session 事件流作为 `dsh_session_log` 请求字段增量上传给官方 DeepSeek API。
 *      官方文档给出的关闭方式：`config.enabled: false`（保持 row 挂载，避免依赖它的插件报错）。
 *   2) `@deepseek-ai/dsh-session-telemetry-otel`（row id: `session-telemetry-otel`）
 *      负责在「用户主动反馈」后通过 OTLP/HTTP 导出会话内容（含消息、工具参数、cwd 等）。
 *      官方文档给出的关闭方式：`config.mode: DISABLED`（不构造任何 exporter/transport）。
 *   3) 启动器还支持环境变量 `DSH_TELEMETRY_DISABLED`（任意非空值即硬禁用 telemetry row）；
 *      dsh.mjs 在子进程环境里也会设置它，形成双保险。
 *
 * 做法：在私有 DSH_HOME 的 `profiles/headless/` 里初始化 headless profile 并写入
 * `cordis.patch.yml` 的受管块（marker 包裹，可重复调用/热更新，不破坏用户层其它配置）。
 * 该 profile 的 bundle 列表与官方 shipped 模板一致（dsh-base + dsh-headless）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 受管块的起止标记（重复调用时整块替换） */
export const PRIVACY_MARKER_BEGIN = '# >>> chaoxing-homework privacy patch (auto-managed by engine)';
export const PRIVACY_MARKER_END = '# <<< chaoxing-homework privacy patch';

/** 官方 shipped headless profile 的 bundle 列表（与 dsh-app-boot PROFILE_TEMPLATES 一致） */
export const HEADLESS_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'];

const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

const PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

/** 隐私补丁说明（供 README / UI 展示；引擎实例上暴露为 engine.privacy） */
export const PRIVACY = Object.freeze({
  summary: '私有 DSH_HOME 内禁用「会话日志上传」与「OTel 会话遥测」，引擎只做推理 + 联网检索，不上传会话内容。',
  patchFile: 'profiles/headless/cordis.patch.yml',
  envSwitch: 'DSH_TELEMETRY_DISABLED=1（dsh.mjs 在子进程环境内设置，双保险）',
  rows: Object.freeze([
    Object.freeze({
      id: 'session-log-deepseek',
      plugin: '@deepseek-ai/dsh-session-log-deepseek',
      config: Object.freeze({ enabled: false }),
      why: '该插件把 Session 事件流作为 dsh_session_log 字段随每次 DeepSeek 请求上传；enabled:false 关闭该上传（官方文档配置项）。',
    }),
    Object.freeze({
      id: 'session-telemetry-otel',
      plugin: '@deepseek-ai/dsh-session-telemetry-otel',
      config: Object.freeze({ mode: 'DISABLED' }),
      why: '该插件在用户反馈后通过 OTLP 导出会话内容；mode:DISABLED 时不构造任何 transport，记录不出进程。',
    }),
  ]),
});

function profileDir(dshHome) {
  return path.join(dshHome, 'profiles', 'headless');
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return { filePath, created: false };
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, created: true };
}

function modelRowYaml(model) {
  if (!model) return '';
  const provider = model.provider || 'deepseek-official';
  const name = model.model || model.name || (typeof model === 'string' ? model : null);
  if (!name) return '';
  const lines = [
    '# 可选：覆盖 headless 默认模型（createEngine({ model }) 写入）',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${provider}`,
    `    model: ${name}`,
  ];
  if (model.reasoningEffort) lines.push(`    reasoningEffort: ${model.reasoningEffort}`);
  return `${lines.join('\n')}\n`;
}

/** 生成受管补丁块（隐私 rows + 可选模型覆盖） */
export function renderPrivacyBlock({ model } = {}) {
  const lines = [PRIVACY_MARKER_BEGIN, '# 学习通作业助手：禁止会话日志上传与会话遥测（勿手改本块）'];
  for (const row of PRIVACY.rows) {
    lines.push(`- id: ${row.id}`);
    lines.push('  config:');
    for (const [key, value] of Object.entries(row.config)) {
      lines.push(`    ${key}: ${typeof value === 'string' ? value : String(value)}`);
    }
  }
  const modelYaml = modelRowYaml(model);
  if (modelYaml) lines.push(modelYaml.replace(/\n$/, ''));
  lines.push(PRIVACY_MARKER_END);
  return `${lines.join('\n')}\n`;
}

/** 把受管块合并进已有 patch 文本（存在则替换，不存在则追加） */
export function mergePrivacyPatch(existingText, { model } = {}) {
  const block = renderPrivacyBlock({ model });
  const normalize = (s) => `${String(s).replace(/[ \t]+\n/g, '\n').replace(/\n+$/, '')}\n`;
  const header =
    '# Your patch layer for this dsh profile, applied after every bundle layer:\n' +
    '# 由学习通作业助手 engine 维护（隐私补丁整块替换）。\n';
  // DSH 首次初始化会生成只有注释 + `[]` 的空 patch。若把隐私块直接追加在 `[]` 后面，
  // YAML 会变成「先空 flow sequence 再 block sequence」而解析失败（DSH 启动即报
  // loadOverlayPatches 错误，表现为 AI 引擎自检失败）。这里把空序列归一化后再合并。
  const stripEmptySequences = (s) =>
    String(s)
      .split('\n')
      .filter((line) => line.trim() !== '[]')
      .join('\n');
  const isOnlyEmptySequence = (s) => {
    const body = String(s)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .join('\n')
      .trim();
    return body === '' || body === '[]';
  };

  const text = String(existingText ?? '');
  if (isOnlyEmptySequence(text)) return normalize(header + block);

  const begin = text.indexOf(PRIVACY_MARKER_BEGIN);
  const end = text.indexOf(PRIVACY_MARKER_END);
  if (begin >= 0 && end > begin) {
    const before = stripEmptySequences(text.slice(0, begin));
    const after = stripEmptySequences(text.slice(end + PRIVACY_MARKER_END.length));
    // 统一为块末尾单个换行，保证重复调用文本稳定（幂等）
    return normalize(`${before}${block}${after.replace(/^\n+/, '\n')}`);
  }
  // 已有用户层配置：追加受管块（YAML 上层后写覆盖同 id row）
  return normalize(`${stripEmptySequences(text).trimEnd()}\n\n${block}`);
}

/** 读取当前隐私状态（不含任何凭据） */
export function readPrivacyStatus(dshHome) {
  const dir = profileDir(dshHome);
  const patchPath = path.join(dir, 'cordis.patch.yml');
  let patchText = '';
  if (fs.existsSync(patchPath)) {
    try {
      patchText = fs.readFileSync(patchPath, 'utf8');
    } catch {
      patchText = '';
    }
  }
  const hasMarker = patchText.includes(PRIVACY_MARKER_BEGIN) && patchText.includes(PRIVACY_MARKER_END);
  const rowChecks = PRIVACY.rows.map((row) => {
    // 只在受管块内检查，避免把用户层同名 row 误判为本引擎写入
    const begin = patchText.indexOf(PRIVACY_MARKER_BEGIN);
    const end = patchText.indexOf(PRIVACY_MARKER_END);
    const managed = begin >= 0 && end > begin ? patchText.slice(begin, end) : '';
    return { id: row.id, present: new RegExp(`- id:\\s*${row.id}\\b`).test(managed) };
  });
  return {
    profileInitialized: fs.existsSync(path.join(dir, 'package.json')),
    profileDir: dir,
    patchPath,
    patchExists: fs.existsSync(patchPath),
    managedBlockPresent: hasMarker,
    rows: rowChecks,
    privacyComplete: hasMarker && rowChecks.every((r) => r.present),
    modelOverride: /- id:\s*agent-default-model/.test(patchText),
  };
}

/**
 * 初始化（或补全）私有 DSH_HOME 的 headless profile 并写入隐私补丁。
 * 幂等：可重复调用；已存在的用户层配置不会被删除（仅替换受管块 / 追加）。
 *
 * @param {{dshHome:string, model?:any, log?:(m:string)=>void}} opts
 * @returns {{profileDir:string, createdFiles:string[], patchPath:string, privacyComplete:boolean, rows:any[]}}
 */
export function ensurePrivacyProfile({ dshHome, model = null, log } = {}) {
  if (!dshHome) throw new Error('ensurePrivacyProfile：缺少 dshHome');
  const dir = profileDir(dshHome);
  fs.mkdirSync(dir, { recursive: true });

  const createdFiles = [];
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      `${JSON.stringify(
        {
          name: 'dsh-profile-headless',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: [...HEADLESS_BUNDLES] } },
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    createdFiles.push(manifest);
  }
  const pnpm = path.join(dir, 'pnpm-workspace.yaml');
  if (!fs.existsSync(pnpm)) {
    fs.writeFileSync(pnpm, PNPM_WORKSPACE, 'utf8');
    createdFiles.push(pnpm);
  }
  // cordis.yml 实际由启动器每次启动重写；这里预置一份，保证目录自解释
  const rootCfg = path.join(dir, 'cordis.yml');
  if (!fs.existsSync(rootCfg)) {
    fs.writeFileSync(rootCfg, PROFILE_ROOT_CONFIG, 'utf8');
    createdFiles.push(rootCfg);
  }

  const patchPath = path.join(dir, 'cordis.patch.yml');
  const existing = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
  const merged = mergePrivacyPatch(existing, { model });
  if (merged !== existing) {
    // 原子写，避免半截 patch 让 headless 启动失败
    const tmp = `${patchPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, merged, 'utf8');
    try {
      fs.renameSync(tmp, patchPath);
    } catch (err) {
      try {
        fs.rmSync(patchPath, { force: true });
        fs.renameSync(tmp, patchPath);
      } catch {
        fs.rmSync(tmp, { force: true });
        throw new Error(`写入隐私补丁失败：${err && err.message}`);
      }
    }
    log?.(`已写入 headless 隐私补丁：${patchPath}`);
  } else {
    log?.(`隐私补丁已是最新：${patchPath}`);
  }

  const status = readPrivacyStatus(dshHome);
  return {
    profileDir: dir,
    createdFiles,
    patchPath,
    privacyComplete: status.privacyComplete,
    rows: status.rows,
    modelOverride: Boolean(model) || status.modelOverride,
    summary: PRIVACY.summary,
  };
}

/** 只渲染模型覆盖 overlay（给 `--patch` 用，不动 profile 文件） */
export function renderModelOverlay({ model } = {}) {
  const row = modelRowYaml(model);
  if (!row) return '';
  return `# 学习通作业助手：headless 模型覆盖（--patch 覆盖层，由 createEngine({ model }) 生成）\n${row}`;
}

/**
 * 写/更新模型覆盖 overlay 文件（幂等：内容不变则不重写）。
 * @param {{dir:string, model:any, log?:(m:string)=>void, fileName?:string}} opts
 *        fileName 默认为 engine-model-patch.yml；备用模型可用 engine-model-patch-fallback-<i>.yml
 * @returns {{filePath:string|null, content:string, changed:boolean}}
 */
export function ensureModelOverlay({ dir, model, log, fileName = 'engine-model-patch.yml' } = {}) {
  if (!model) return { filePath: null, content: '', changed: false };
  const content = renderModelOverlay({ model });
  if (!content) throw new Error('ensureModelOverlay：model 配置无效（缺少 model 名称）');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (existing === content) return { filePath, content, changed: false };
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.rmSync(filePath, { force: true });
    fs.renameSync(tmp, filePath);
  }
  log?.(`已写入模型覆盖 overlay：${filePath}`);
  return { filePath, content, changed: true };
}
