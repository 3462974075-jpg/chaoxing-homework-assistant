/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * index.mjs — AI 引擎对外接口（设计说明 5.2）
 *
 *   const engine = createEngine({ dshHome, dshBin, log });
 *   await engine.ensureHome({ apiKey })
 *   await engine.check()                        // -> { ok, version, latencyMs }
 *   await engine.solveObjective({ work, questions, cwd, onEvent })
 *   await engine.makeSubmissionDoc({ work, questions, materials, templatePath, outDir, onEvent })
 *   await engine.answerShort({ work, question, materials, onEvent })
 *   await engine.cancel()
 *
 * 返回约定：
 *   - 成功：{ ok:true, ...业务字段 }；失败：{ ok:false, error:{ code, message, detail } }（不抛异常，
 *     便于编排器记录并继续下一项）。仅「参数非法」这类编程错误才抛异常。
 *   - 引擎绝不依赖 DSH 的 shell / 文件工具：所有文件由本进程（App 侧）读写。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  runHeadless,
  check as dshCheck,
  getVersion,
  initHome,
  dumpConfig as dshDumpConfig,
  resolveDshBin,
  DEFAULT_DSH_BIN,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_IDLE_TIMEOUT_MS,
} from './dsh.mjs';
import * as credentials from './credentials.mjs';
import * as prompts from './prompts.mjs';
import * as vision from './vision.mjs';
import { PRIVACY, ensurePrivacyProfile, ensureModelOverlay, readPrivacyStatus } from './privacy.mjs';
import {
  extractJson,
  validateObjectiveAnswers,
  validateShortAnswer,
  validateSubmission,
  normalizeMeta,
  ParseError,
  OBJECTIVE_TYPES,
} from './parse.mjs';
import {
  newDocx,
  parseDocx,
  fillDocxTemplate,
  markdownToBlocks,
  buildTemplateOps,
  listPlaceholders,
  docxToText,
} from './docgen.mjs';

export {
  DEFAULT_DSH_BIN,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_IDLE_TIMEOUT_MS,
  ParseError,
  PRIVACY,
  resolveDshBin,
};
export * as parse from './parse.mjs';
export * as docgen from './docgen.mjs';
export * as prompts from './prompts.mjs';
export * as credentials from './credentials.mjs';
export * as privacy from './privacy.mjs';

/** 规范化 createEngine({ model }) 入参：'deepseek-flash' | { provider, model, reasoningEffort } */
export function normalizeModelOption(model) {
  if (!model) return null;
  if (typeof model === 'string') return { provider: 'deepseek-official', model };
  if (typeof model === 'object') {
    const name = model.model || model.name;
    if (!name) return null;
    return {
      provider: model.provider || 'deepseek-official',
      model: name,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    };
  }
  return null;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeFileName(name, fallback = 'submission') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把数组按 size 切成批（size<=0 时整份一批） */
export function chunkArray(items, size) {
  const list = Array.isArray(items) ? items : [];
  const n = Math.max(1, Number(size) || list.length || 1);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** 分片默认值：20 题/批，单批提示词 ≤30000 字符，单批失败重试 1 次（可用参数/env 覆盖） */
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_BATCH_MAX_PROMPT_CHARS = 30_000;
export const DEFAULT_BATCH_RETRIES = 1;

/** 批次失败后自动拆单题重试的错误码（内容审核 refusal / 解析失败，单题成功率更高） */
export const DEFAULT_SPLIT_CODES = ['MODEL_REFUSED', 'BAD_MODEL_OUTPUT'];

/** 拆单题后仍被拒时，触发「联网检索标准答案」兜底的错误码（只对内容审核拒绝） */
export const DEFAULT_SEARCH_FALLBACK_CODES = ['MODEL_REFUSED'];

function resolveEnvBatchSize() {
  const raw = process.env.CX_ENGINE_BATCH_SIZE || process.env.DSH_ENGINE_BATCH_SIZE;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BATCH_SIZE;
}

/**
 * 创建引擎实例。
 * @param {{dshHome:string, dshBin?:string, log?:(msg:string)=>void, timeoutMs?:number,
 *          pollMs?:number, workRoot?:string, stdinPromptThreshold?:number,
 *          model?:string|{provider?:string, model?:string, reasoningEffort?:string},
 *          fallbackModels?:Array<string|{provider?:string, model?:string, reasoningEffort?:string}>,
 *          retry?:boolean, patchFiles?:string[],
 *          maxSteps?:number, maxToolCalls?:number, idleTimeoutMs?:number}} opts
 */
export function createEngine({
  dshHome,
  dshBin = null,
  appRoot = null,
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = 400,
  workRoot = null,
  stdinPromptThreshold = undefined,
  model = null,
  fallbackModels = [],
  retry = true,
  patchFiles = [],
  maxSteps = DEFAULT_MAX_STEPS,
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  batchSize = resolveEnvBatchSize(),
  batchMaxPromptChars = DEFAULT_BATCH_MAX_PROMPT_CHARS,
  batchRetries = DEFAULT_BATCH_RETRIES,
  splitOnFailure = true,
  splitCodes = DEFAULT_SPLIT_CODES,
  splitBatchRetries = 0,
  searchFallback = true,
  searchFallbackCodes = DEFAULT_SEARCH_FALLBACK_CODES,
  searchFallbackRetries = 0,
  visionModel = vision.DEFAULT_VISION_MODEL,
  visionBaseURL = process.env.DEEPSEEK_BASE_URL || vision.DEFAULT_VISION_BASE_URL,
  visionMaxTokens = 8192,
} = {}) {
  if (!dshHome) throw new Error('createEngine：缺少 dshHome');
  // 绿色版：dshBin 可能是 <root>\dsh 下的便携安装，也可能是系统全局安装
  const resolvedDshBin = resolveDshBin({ dshBin, appRoot });
  dshBin = resolvedDshBin;
  const resolvedWorkRoot = workRoot || path.join(path.dirname(path.resolve(dshHome)), 'engine-work');
  const normalizedModel = normalizeModelOption(model);
  const userPatchFiles = [...patchFiles];
  let modelPatchPath = null;
  if (normalizedModel) {
    try {
      modelPatchPath = ensureModelOverlay({ dir: resolvedWorkRoot, model: normalizedModel, log }).filePath;
    } catch (err) {
      log(`模型覆盖 overlay 写入失败（将使用默认模型）：${err && err.message}`);
    }
  }
  const runPatchFiles = [...new Set([...userPatchFiles, ...(modelPatchPath ? [modelPatchPath] : [])])];
  // 备用模型（可选，默认关闭）：主模型被内容审核拒绝时按顺序轮换重试
  const fallbackModelEntries = [];
  (Array.isArray(fallbackModels) ? fallbackModels : []).forEach((raw, index) => {
    const normalized = normalizeModelOption(raw);
    if (!normalized) return;
    try {
      const overlay = ensureModelOverlay({
        dir: resolvedWorkRoot,
        model: normalized,
        log,
        fileName: `engine-model-patch-fallback-${index}.yml`,
      });
      if (overlay.filePath) {
        fallbackModelEntries.push({
          provider: normalized.provider,
          model: normalized.model,
          reasoningEffort: normalized.reasoningEffort ?? null,
          patchPath: overlay.filePath,
          label: `${normalized.provider}/${normalized.model}`,
        });
      }
    } catch (err) {
      log(`备用模型 overlay 写入失败（跳过 ${normalized.provider}/${normalized.model}）：${err && err.message}`);
    }
  });
  const primaryModelLabel = normalizedModel ? `${normalizedModel.provider}/${normalizedModel.model}` : 'default';
  let activeController = null;
  let cancelled = false;

  const logEvent = (step, evt) => {
    if (evt.type === 'status' && evt.phase) log(`[engine:${step}] status ${evt.phase} turn=${evt.turn ?? ''} step=${evt.step ?? ''}`);
    else if (evt.type === 'thinking') log(`[engine:${step}] thinking ...`);
    else if (evt.type === 'error') log(`[engine:${step}] error ${evt.message || evt.error || ''}`);
  };

  /** 统一执行：建独立 cwd、注册 AbortController、跑 headless */
  async function run({
    step,
    prompt,
    cwd,
    onEvent,
    extraLog,
    timeoutMs: stepTimeoutMs = null,
    patchFiles: patchFilesOverride = null,
  }) {
    if (cancelled) {
      return { ok: false, cancelled: true, error: { code: 'CANCELLED', message: '引擎已取消' } };
    }
    const runCwd = ensureDir(cwd || path.join(resolvedWorkRoot, `${step}-${stamp()}`));
    const controller = new AbortController();
    activeController = controller;
    const wrapEvent = (evt) => {
      logEvent(step, evt);
      if (onEvent) {
        try {
          onEvent(evt);
        } catch (err) {
          log(`[engine:${step}] onEvent 回调异常（已忽略）：${err && err.message}`);
        }
      }
    };
    extraLog?.(runCwd);
    try {
      let result;
      try {
        result = await runHeadless({
          prompt,
          cwd: runCwd,
          dshHome,
          dshBin,
          timeoutMs: stepTimeoutMs || timeoutMs,
          pollMs,
          onEvent: wrapEvent,
          signal: controller.signal,
          log: (m) => log(`[engine:${step}] ${m}`),
          stdinPromptThreshold,
          patchFiles: patchFilesOverride || runPatchFiles,
          retry,
          maxSteps,
          maxToolCalls,
          idleTimeoutMs,
        });
      } catch (err) {
        // 启动阶段错误（如 dshBin 是 .cmd、找不到 CLI）：转成结构化失败，不向上抛
        result = {
          ok: false,
          text: '',
          events: [],
          finalEvent: null,
          code: null,
          timedOut: false,
          cancelled: false,
          loopDetected: false,
          spawnError: `${err && err.code ? `[${err.code}] ` : ''}${err && err.message ? err.message : String(err)}`,
          latencyMs: 0,
          stderr: '',
          errorText: err && err.message,
        };
        log(`[engine:${step}] 启动失败：${result.spawnError}`);
      }
      return { ...result, runCwd, effectiveTimeoutMs: stepTimeoutMs || timeoutMs };
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  function fail(step, result, code = null, message = null) {
    const detail = {
      code: result.code ?? null,
      timedOut: Boolean(result.timedOut),
      cancelled: Boolean(result.cancelled),
      loopDetected: Boolean(result.loopDetected),
      loopReason: result.loopReason ?? null,
      stepCount: result.stepCount ?? null,
      toolCallCount: result.toolCallCount ?? null,
      stderrTail: (result.stderr || '').slice(-2000),
      errorText: result.errorText ?? null,
      spawnError: result.spawnError ?? null,
      attempts: result.attempts ?? 1,
      runCwd: result.runCwd ?? null,
    };
    const effectiveTimeout = result.effectiveTimeoutMs || timeoutMs || DEFAULT_TIMEOUT_MS;
    const refusal = /stop reason refusal|MALFORMED_RESPONSE/i.test(
      `${result.stderr || ''} ${result.errorText || ''}`
    );
    const resolvedCode =
      code ||
      (result.loopDetected
        ? 'LOOP_DETECTED'
        : result.cancelled
          ? 'CANCELLED'
          : result.timedOut
            ? 'TIMEOUT'
            : refusal
              ? 'MODEL_REFUSED'
              : 'ENGINE_FAILED');
    const msg =
      message ||
      (result.spawnError
        ? `AI 引擎启动失败：${result.spawnError}`
        : result.loopDetected
          ? 'AI 检索陷入循环，已中止'
          : result.timedOut
            ? `AI 引擎调用超时（>${Math.round(effectiveTimeout / 1000)}s）`
            : result.cancelled
              ? 'AI 引擎调用已取消'
              : refusal
                ? '模型拒绝回答该批题目（内容审核 refusal），已跳过该批'
                : `AI 引擎调用失败（exit=${result.code}）`);
    log(`[engine:${step}] ${msg}${result.loopReason ? `（${result.loopReason}）` : ''}`);
    return { ok: false, error: { code: resolvedCode, message: msg, detail }, latencyMs: result.latencyMs ?? null };
  }

  return {
    // ---- 基础信息 ----
    get dshHome() {
      return dshHome;
    },
    get dshBin() {
      return dshBin;
    },
    get workRoot() {
      return resolvedWorkRoot;
    },
    /** 隐私隔离说明（禁用了哪些插件、补丁文件、环境开关） */
    get privacy() {
      return PRIVACY;
    },
    /** 当前生效的模型覆盖（未指定则为 null，即使用 DSH 默认 deepseek-official/deepseek-flash） */
    get model() {
      return normalizedModel;
    },
    /** 模型覆盖 overlay 文件路径（--patch 用） */
    get modelPatchPath() {
      return modelPatchPath;
    },
    /** 当前主模型标签（未指定为 default） */
    get modelLabel() {
      return primaryModelLabel;
    },
    /** 已配置的备用模型（主模型 refusal 时按顺序轮换；默认空 = 关闭） */
    get fallbackModels() {
      return fallbackModelEntries.map(({ label, provider, model }) => ({ label, provider, model }));
    },

    /** 写私有 DSH_HOME 的 .credentials.yaml + headless 隐私补丁（原子写；不返回/不打印 Key） */
    async ensureHome({ apiKey } = {}) {
      // 关键：必须先把 DSH 基础 profile 初始化出来，再写 privacy patch；
      // 否则全新机器上 patch-only 的 home 会让 DSH 启动失败（自检“AI 引擎不可用”）。
      let init = null;
      try {
        init = await initHome({ dshHome, dshBin, cwd: path.join(resolvedWorkRoot, `init-${stamp()}`), timeoutMs: 120_000, log });
      } catch (err) {
        log(`DSH_HOME 初始化检查失败（继续写凭据）：${err && err.message}`);
      }
      const result = credentials.ensureHome({ dshHome, apiKey, log, model: normalizedModel });
      if (apiKey) log(`AI Key 已配置（${credentials.maskKey(apiKey)}）`);
      if (result.privacy && result.privacy.privacyComplete) {
        log('隐私隔离已生效：session-log-deepseek 上传已关闭，session-telemetry-otel 已 DISABLED');
      }
      return { ...result, init };
    },

    /** 只返回「是否已配置 Key」 */
    keyStatus() {
      return credentials.readKeyRef(dshHome);
    },

    /** 隐私补丁现状（不含凭据） */
    privacyStatus() {
      return readPrivacyStatus(dshHome);
    },

    /** 健康检查：DSH 版本 + 一次真实 headless 调用（回 OK） */
    async check({ cwd, timeoutMs: checkTimeoutMs = Math.min(timeoutMs, 180_000), onEvent } = {}) {
      const runCwd = cwd || path.join(resolvedWorkRoot, `check-${stamp()}`);
      // 自检前也做一次 home 初始化/隐私补丁校验：修复 patch-only 坏 home，避免 DSH 启动即失败
      try {
        const init = await initHome({ dshHome, dshBin, cwd: runCwd, timeoutMs: 60_000, log });
        if (init && init.ok) {
          credentials.ensureHome({ dshHome, model: normalizedModel, log });
        } else {
          log(`自检前 DSH_HOME 初始化未完成：${JSON.stringify(init && init.stderr ? init.stderr.slice(-400) : init)}`);
        }
      } catch (err) {
        log(`自检前 DSH_HOME 初始化异常：${err && err.message}`);
      }
      const keyStatus = credentials.readKeyRef(dshHome);
      const result = await dshCheck({
        dshHome,
        dshBin,
        cwd: runCwd,
        timeoutMs: checkTimeoutMs,
        patchFiles: runPatchFiles,
        log,
      });
      // 让 onEvent 也能看到 check 的事件（check 内部未透传，这里补一次简化事件）
      if (onEvent) {
        try {
          onEvent({ type: 'check', text: result.text, ok: result.ok });
        } catch {
          /* ignore */
        }
      }
      return {
        ok: Boolean(result.ok),
        version: result.version,
        latencyMs: result.latencyMs,
        text: result.text,
        keyConfigured: keyStatus.configured,
        attempts: result.attempts ?? 1,
        detail: result.ok ? null : result.detail,
      };
    },

    /**
     * 批量求解客观题（**自动分片**：默认 20 题/批，单批提示词 ≤30k 字符，单批失败重试 1 次）。
     *
     * onEvent 额外推送分片进度：{type:'batch', phase:'start'|'done'|'failed', index, total, count, message, ...}
     * 返回：成功 {ok:true, answers, sources, needMaterials, missing, batches, batchStats}
     *       部分失败 {ok:false, error.code:'PARTIAL_ANSWERS', answers(已得答案保留), missing, failedBatches, batchStats}
     */
    async solveObjective({
      work,
      questions,
      cwd,
      onEvent,
      materials = '',
      maxPromptChars = 24_000,
      batchSize: batchSizeOverride = batchSize,
      batchMaxPromptChars: batchMaxPromptCharsOverride = batchMaxPromptChars,
      batchRetries: batchRetriesOverride = batchRetries,
      splitOnFailure: splitOnFailureOverride = splitOnFailure,
      splitCodes: splitCodesOverride = splitCodes,
      splitBatchRetries: splitBatchRetriesOverride = splitBatchRetries,
      searchFallback: searchFallbackOverride = searchFallback,
      searchFallbackCodes: searchFallbackCodesOverride = searchFallbackCodes,
      searchFallbackRetries: searchFallbackRetriesOverride = searchFallbackRetries,
      modelFallback: modelFallbackOverride = true,
      timeoutMs: stepTimeoutMs = Math.min(timeoutMs, 180_000),
    } = {}) {
      if (!Array.isArray(questions) || !questions.length) throw new Error('solveObjective：questions 不能为空');
      const size = Math.max(1, Number(batchSizeOverride) || DEFAULT_BATCH_SIZE);
      const maxPrompt = Math.max(5_000, Number(batchMaxPromptCharsOverride) || DEFAULT_BATCH_MAX_PROMPT_CHARS);
      const retries = Math.max(0, Number(batchRetriesOverride) || 0);
      const splitEnabled = splitOnFailureOverride !== false;
      const splitCodeSet = new Set(
        (Array.isArray(splitCodesOverride) ? splitCodesOverride : DEFAULT_SPLIT_CODES).map((c) =>
          String(c).toUpperCase()
        )
      );
      const singleRetries = Math.max(0, Number(splitBatchRetriesOverride) || 0);
      const searchEnabled = searchFallbackOverride !== false;
      const searchCodeSet = new Set(
        (Array.isArray(searchFallbackCodesOverride) ? searchFallbackCodesOverride : DEFAULT_SEARCH_FALLBACK_CODES).map(
          (c) => String(c).toUpperCase()
        )
      );
      const searchRetries = Math.max(0, Number(searchFallbackRetriesOverride) || 0);
      const objectiveQids = new Set(
        questions.filter((q) => OBJECTIVE_TYPES.has(q.type)).map((q) => String(q.qid))
      );
      const batches = chunkArray(questions, size);
      const total = batches.length;
      const startedAll = Date.now();
      const emitBatch = (payload) => {
        try {
          onEvent?.({
            type: 'batch',
            index: payload.index,
            total,
            count: payload.count,
            message: payload.message,
            phase: payload.phase,
            ...payload.extra,
          });
        } catch (err) {
          log(`[engine:solveObjective] onEvent(batch) 回调异常（已忽略）：${err && err.message}`);
        }
      };
      log(
        `[engine:solveObjective] 共 ${questions.length} 题，分 ${total} 批（每批≤${size} 题，单批提示词≤${maxPrompt} 字符，单批最多 ${retries} 次重试；` +
          `失败批次 ${splitEnabled ? `按 [${[...splitCodeSet].join('/')}] 自动拆单题（单题 ${singleRetries} 次重试）` : '不拆单题'}，超时 ${stepTimeoutMs}ms/批）`
      );

      const answers = {};
      const answerOrigin = {}; // qid -> 'direct' | 'split' | 'search'
      const missingSet = new Set();
      const sources = [];
      const sourceKeys = new Set();
      const needMaterials = [];
      const failedBatches = [];
      const batchStats = [];
      const refusedPool = new Map(); // qid -> question（内容审核拒绝、待检索兜底）
      const qidToQuestion = new Map(questions.map((q) => [String(q.qid), q]));
      const qidToIndex = new Map(questions.map((q, idx) => [String(q.qid), idx + 1]));
      const searchStats = {
        enabled: Boolean(searchEnabled),
        attempted: 0,
        recovered: 0,
        refusedQids: [],
        searchFailedQids: [],
      };
      const modelFallbackEnabled = modelFallbackOverride !== false && fallbackModelEntries.length > 0;
      const modelFallbackStats = {
        enabled: modelFallbackEnabled,
        attempted: 0,
        recovered: 0,
        usedModels: {},
        errors: [],
      };
      let confidenceSum = 0;
      let confidenceBatches = 0;

      const batchCwd = (suffix) => (cwd ? path.join(cwd, suffix) : undefined);

      /** 单次尝试（含内部重试）：返回 {ok, answers, meta, promptChars, latencyMs, error} */
      const attemptSolve = async (
        batchQuestions,
        { label, cwdSuffix, retries: attemptRetries, patchFiles: patchFilesOverride = null }
      ) => {
        let lastFailure = null;
        for (let attempt = 1; attempt <= 1 + attemptRetries; attempt++) {
          if (cancelled) {
            return { ok: false, error: { code: 'CANCELLED', message: 'AI 引擎调用已取消' }, latencyMs: 0, promptChars: 0 };
          }
          const prompt = prompts.buildObjectivePrompt({
            work,
            questions: batchQuestions,
            materials,
            maxChars: maxPrompt,
          });
          const t = Date.now();
          const runResult = await run({
            step: label,
            prompt,
            cwd: batchCwd(cwdSuffix),
            onEvent,
            timeoutMs: stepTimeoutMs,
            patchFiles: patchFilesOverride,
          });
          if (!runResult.ok) {
            lastFailure = { ...fail(label, runResult), promptChars: prompt.length };
            if (runResult.cancelled) return lastFailure;
            if (attempt < 1 + attemptRetries) {
              log(`[engine:solveObjective] ${label} 失败（${lastFailure.error.code}），重试 1 次`);
              continue;
            }
            return lastFailure;
          }
          try {
            const { json } = extractJson(runResult.text);
            const meta = normalizeMeta(json);
            // needMaterials 非空时允许部分题目缺答案（编排器会暂停该项）
            const validated = validateObjectiveAnswers(batchQuestions, json, {
              allowMissing: meta.needMaterials.length > 0,
              allowExtra: true,
            });
            return {
              ok: true,
              answers: validated.answers,
              meta,
              promptChars: prompt.length,
              latencyMs: Date.now() - t,
            };
          } catch (err) {
            const detail = err instanceof ParseError ? err.details : { message: err && err.message };
            lastFailure = {
              ok: false,
              error: { code: 'BAD_MODEL_OUTPUT', message: err && err.message, detail },
              text: runResult.text,
              latencyMs: runResult.latencyMs,
              promptChars: prompt.length,
            };
            if (attempt < 1 + attemptRetries) {
              log(`[engine:solveObjective] ${label} 输出不合法（${err && err.message}），重试 1 次`);
              continue;
            }
            return lastFailure;
          }
        }
        return lastFailure || { ok: false, error: { code: 'ENGINE_FAILED', message: '未知错误' }, promptChars: 0 };
      };

      /** 检索兜底：让模型联网搜题干/题库找标准答案（不自行分析、不展开内容） */
      const attemptSearch = async (question, { retries: searchAttempts = 0 } = {}) => {
        let lastFailure = null;
        for (let attempt = 1; attempt <= 1 + searchAttempts; attempt++) {
          if (cancelled) {
            return { ok: false, error: { code: 'CANCELLED', message: 'AI 引擎调用已取消' } };
          }
          const prompt = prompts.buildSearchAnswerPrompt({ work, question, materials, maxSearches: 2 });
          const label = `solveObjective[检索兜底 ${question.qid}]`;
          const runResult = await run({
            step: label,
            prompt,
            cwd: batchCwd(`search-${question.qid}`),
            onEvent,
            timeoutMs: stepTimeoutMs,
          });
          if (!runResult.ok) {
            lastFailure = fail(label, runResult);
            if (runResult.cancelled) return lastFailure;
            if (attempt < 1 + searchAttempts) continue;
            return lastFailure;
          }
          try {
            const { json } = extractJson(runResult.text);
            const meta = normalizeMeta(json);
            const validated = validateObjectiveAnswers([question], json, { allowMissing: true, allowExtra: true });
            if (!(String(question.qid) in validated.answers)) {
              return {
                ok: false,
                error: {
                  code: 'SEARCH_NO_ANSWER',
                  message: '联网检索未找到该题标准答案',
                  detail: { needMaterials: meta.needMaterials },
                },
                meta,
              };
            }
            return { ok: true, answers: validated.answers, meta };
          } catch (err) {
            const detail = err instanceof ParseError ? err.details : { message: err && err.message };
            lastFailure = {
              ok: false,
              error: { code: 'BAD_MODEL_OUTPUT', message: err && err.message, detail },
              text: runResult.text,
            };
            if (attempt < 1 + searchAttempts) continue;
            return lastFailure;
          }
        }
        return lastFailure || { ok: false, error: { code: 'SEARCH_NO_ANSWER', message: '联网检索未找到答案' } };
      };

      /** 合入一次成功结果（answers/sources/needMaterials/confidence） */
      const mergeSuccess = (success) => {
        Object.assign(answers, success.answers);
        for (const src of success.meta.sources) {
          const key = src.url || src.title;
          if (key && !sourceKeys.has(key)) {
            sourceKeys.add(key);
            sources.push(src);
          }
        }
        for (const item of success.meta.needMaterials) {
          if (!needMaterials.includes(item)) needMaterials.push(item);
        }
        confidenceSum += success.meta.confidence;
        confidenceBatches += 1;
      };

      for (let i = 0; i < total; i++) {
        if (cancelled) break;
        const batch = batches[i];
        const index = i + 1;
        const batchQids = batch.map((q) => String(q.qid));
        const t0 = Date.now();
        emitBatch({
          index,
          count: batch.length,
          phase: 'start',
          message: `第 ${index}/${total} 批：${batch.length} 题，开始求解`,
        });

        const success = await attemptSolve(batch, {
          label: `solveObjective[${index}/${total}]`,
          cwdSuffix: `batch-${String(index).padStart(2, '0')}`,
          retries,
        });

        let answeredInBatch = 0;
        let primaryPromptChars = success.promptChars ?? 0;
        let splitStats = null;
        let failure = null;

        if (success.ok) {
          mergeSuccess(success);
          for (const qid of Object.keys(success.answers)) answerOrigin[qid] = 'direct';
          answeredInBatch = Object.keys(success.answers).length;
        } else if (splitEnabled && batch.length > 1 && splitCodeSet.has(String(success.error?.code ?? '').toUpperCase())) {
          // 批次被内容审核拒绝 / 输出不可解析：拆成单题逐题再问（单题更容易通过）
          const reason = String(success.error?.code ?? 'ENGINE_FAILED');
          emitBatch({
            index,
            count: batch.length,
            phase: 'split',
            message: `第 ${index}/${total} 批 ${reason}（${success.error?.message || ''}），拆成 ${batch.length} 个单题逐题重试`,
            extra: { reason, splitCount: batch.length },
          });
          const splitFailures = [];
          for (let k = 0; k < batch.length; k++) {
            if (cancelled) {
              splitFailures.push({ qid: String(batch[k].qid), code: 'CANCELLED', message: 'AI 引擎调用已取消' });
              continue;
            }
            const single = await attemptSolve([batch[k]], {
              label: `solveObjective[${index}/${total}-单题${k + 1}/${batch.length}]`,
              cwdSuffix: `batch-${String(index).padStart(2, '0')}-q${String(k + 1).padStart(2, '0')}`,
              retries: singleRetries,
            });
            if (single.ok) {
              mergeSuccess(single);
              for (const qid of Object.keys(single.answers)) answerOrigin[qid] = 'split';
              if (String(batch[k].qid) in answers) answeredInBatch += 1;
            } else {
              splitFailures.push({
                qid: String(batch[k].qid),
                code: single.error?.code || 'ENGINE_FAILED',
                message: single.error?.message || '未知错误',
              });
            }
          }
          splitStats = {
            used: true,
            reason,
            recovered: answeredInBatch,
            stillFailed: splitFailures.length,
            failedQids: splitFailures.map((f) => f.qid),
            failures: splitFailures,
          };
          log(
            `[engine:solveObjective] 第 ${index}/${total} 批拆单题：恢复 ${answeredInBatch}/${batch.length}，仍失败 ${splitFailures.length}`
          );
          if (splitFailures.length) {
            const firstCode = splitFailures[0].code;
            failure = {
              error: {
                code: firstCode,
                message: `拆单题后仍有 ${splitFailures.length} 题失败：${splitFailures.map((f) => f.qid).join(',')}`,
                detail: { splitFailures },
              },
              qids: splitFailures.map((f) => f.qid),
            };
            if (searchEnabled || modelFallbackEnabled) {
              for (const f of splitFailures) {
                if (!searchCodeSet.has(String(f.code).toUpperCase())) continue;
                const q = qidToQuestion.get(f.qid);
                if (q && !(f.qid in answers)) refusedPool.set(f.qid, q);
              }
            }
          }
        } else {
          failure = {
            error: success.error || { code: 'ENGINE_FAILED', message: '未知错误' },
            qids: batchQids.filter((qid) => objectiveQids.has(qid)),
          };
          if ((searchEnabled || modelFallbackEnabled) && searchCodeSet.has(String(failure.error.code).toUpperCase())) {
            for (const qid of failure.qids) {
              const q = qidToQuestion.get(qid);
              if (q && !(qid in answers)) refusedPool.set(qid, q);
            }
          }
        }

        const elapsed = Date.now() - t0;
        if (!failure) {
          for (const qid of batchQids) {
            if (objectiveQids.has(qid) && !(qid in answers)) missingSet.add(qid);
          }
          batchStats.push({
            index,
            total,
            count: batch.length,
            ok: true,
            answered: answeredInBatch,
            latencyMs: elapsed,
            promptChars: primaryPromptChars,
            ...(splitStats ? { split: true, splitStats } : {}),
          });
          emitBatch({
            index,
            count: batch.length,
            phase: 'done',
            message: splitStats
              ? `第 ${index}/${total} 批拆单题完成：恢复 ${answeredInBatch}/${batch.length} 题，耗时 ${(elapsed / 1000).toFixed(1)}s`
              : `第 ${index}/${total} 批完成：${answeredInBatch}/${batch.length} 题，耗时 ${(elapsed / 1000).toFixed(1)}s`,
            extra: {
              answered: answeredInBatch,
              latencyMs: elapsed,
              promptChars: primaryPromptChars,
              ...(splitStats ? { split: true, recovered: splitStats.recovered } : {}),
            },
          });
        } else {
          const err = failure.error;
          for (const qid of failure.qids) if (objectiveQids.has(qid)) missingSet.add(qid);
          failedBatches.push({
            index,
            total,
            qids: failure.qids,
            error: { code: err.code, message: err.message, detail: err.detail ?? null },
            latencyMs: elapsed,
            ...(splitStats ? { split: true, splitStats } : {}),
          });
          batchStats.push({
            index,
            total,
            count: batch.length,
            ok: false,
            answered: answeredInBatch,
            latencyMs: elapsed,
            promptChars: primaryPromptChars,
            error: { code: err.code, message: err.message },
            ...(splitStats ? { split: true, splitStats } : {}),
          });
          emitBatch({
            index,
            count: batch.length,
            phase: 'failed',
            message: splitStats
              ? `第 ${index}/${total} 批拆单题后仍有 ${failure.qids.length} 题失败（${err.code}），跳过并继续后续批次`
              : `第 ${index}/${total} 批失败：${err.code}（${err.message}），跳过并继续后续批次`,
            extra: { error: { code: err.code, message: err.message }, ...(splitStats ? { split: true } : {}) },
          });
        }
      }

      // ---- 备用模型回退（可选，默认关闭）：主模型 refusal 的题换备用模型再问 ----
      if (modelFallbackEnabled) {
        for (const [qid, question] of refusedPool) {
          if (cancelled) break;
          if (qid in answers) continue;
          for (const entry of fallbackModelEntries) {
            modelFallbackStats.attempted += 1;
            const order = qidToIndex.get(qid) || 1;
            emitBatch({
              index: order,
              count: 1,
              phase: 'model-fallback',
              message: `题目 ${qid} 主模型拒绝，换用备用模型 ${entry.label} 重试`,
              extra: { qid, model: entry.label },
            });
            log(`[engine:solveObjective] 备用模型 ${entry.label} 重试 ${qid}`);
            const single = await attemptSolve([question], {
              label: `solveObjective[备用模型 ${entry.label} ${qid}]`,
              cwdSuffix: `fallback-${entry.label.replace(/[^a-z0-9]+/gi, '_')}-${qid}`,
              retries: 0,
              patchFiles: [...userPatchFiles, entry.patchPath],
            });
            if (single.ok && qid in single.answers) {
              mergeSuccess(single);
              answerOrigin[qid] = 'modelFallback';
              missingSet.delete(qid);
              modelFallbackStats.recovered += 1;
              modelFallbackStats.usedModels[entry.label] = (modelFallbackStats.usedModels[entry.label] || 0) + 1;
              log(`[engine:solveObjective] 备用模型 ${entry.label} 答出 ${qid}：${single.answers[qid]}`);
              break;
            }
            modelFallbackStats.errors.push({
              qid,
              model: entry.label,
              code: single.error?.code || 'UNKNOWN',
            });
          }
        }
      }

      // ---- 检索兜底：仅对「被内容审核拒绝」的题，让模型联网搜题干/题库找标准答案 ----
      if (searchEnabled) {
        for (const [qid, question] of refusedPool) {
          if (cancelled) break;
          if (qid in answers) continue;
          searchStats.attempted += 1;
          const order = qidToIndex.get(qid) || 1;
          emitBatch({
            index: order,
            count: 1,
            phase: 'search',
            message: `题目 ${qid} 被内容审核拒绝，改用联网检索标准答案（${order}/${questions.length}）`,
            extra: { qid },
          });
          log(`[engine:solveObjective] 检索兜底 ${qid}：联网搜题干/题库答案`);
          const searched = await attemptSearch(question, { retries: searchRetries });
          if (searched.ok && searched.answers && qid in searched.answers) {
            mergeSuccess(searched);
            answerOrigin[qid] = 'search';
            missingSet.delete(qid);
            searchStats.recovered += 1;
            log(`[engine:solveObjective] 检索兜底 ${qid} 成功：${searched.answers[qid]}`);
          } else if (String(searched.error?.code ?? '').toUpperCase() === 'MODEL_REFUSED') {
            searchStats.refusedQids.push(qid);
            log(`[engine:solveObjective] 检索兜底 ${qid} 仍被拒绝`);
          } else {
            searchStats.searchFailedQids.push(qid);
            log(`[engine:solveObjective] 检索兜底 ${qid} 未找到答案（${searched.error?.code || 'UNKNOWN'}）`);
          }
        }
      }

      // 检索兜底成功后：清理 missing / failedBatches，重算统计
      for (const batch of failedBatches) {
        batch.qids = batch.qids.filter((qid) => !(qid in answers));
        if (!batch.qids.length) {
          const stat = batchStats.find((s) => s.index === batch.index);
          if (stat) {
            stat.ok = true;
            stat.resolvedBySearch = true;
          }
        }
      }
      const activeFailedBatches = failedBatches.filter((b) => b.qids.length > 0);
      const missing = [...missingSet].filter((qid) => !(qid in answers));
      const originCounts = { direct: 0, split: 0, search: 0, modelFallback: 0 };
      for (const origin of Object.values(answerOrigin)) {
        originCounts[origin] = (originCounts[origin] || 0) + 1;
      }
      const confidence = confidenceBatches ? confidenceSum / confidenceBatches : 0.5;
      const answeredCount = Object.keys(answers).length;
      const base = {
        answers,
        answerOrigin,
        originCounts,
        confidence,
        sources,
        needMaterials,
        missing,
        searchFallback: searchStats,
        modelFallback: modelFallbackStats,
        batches: total,
        batchSize: size,
        batchStats,
        failedBatches: activeFailedBatches,
        latencyMs: Date.now() - startedAll,
        strategy: 'batched',
      };

      if (!activeFailedBatches.length) {
        return {
          ok: true,
          ...base,
          attempts: 1,
          raw: { batchStats, searchFallback: searchStats, modelFallback: modelFallbackStats },
        };
      }
      // 部分/全部失败：保留已得答案，交给编排器暂停并重试
      const firstErr = activeFailedBatches[0].error;
      const failureDetail = {
        failedBatches: activeFailedBatches,
        missing,
        answeredCount,
        refusedQids: searchStats.refusedQids,
        searchFailedQids: searchStats.searchFailedQids,
        searchFallback: searchStats,
        modelFallback: modelFallbackStats,
        originCounts,
      };
      if (answeredCount === 0 && needMaterials.length === 0) {
        return {
          ok: false,
          ...base,
          error: {
            code: firstErr.code,
            message: `全部 ${total} 批均失败：${firstErr.message}`,
            detail: failureDetail,
          },
        };
      }
      return {
        ok: false,
        ...base,
        error: {
          code: 'PARTIAL_ANSWERS',
          message:
            `部分题目未完成：已得 ${answeredCount} 题（直接 ${originCounts.direct} / 拆单题 ${originCounts.split} / 备用模型 ${originCounts.modelFallback} / 检索兜底 ${originCounts.search}），` +
            `失败 ${activeFailedBatches.length}/${total} 批（${missing.length} 题缺答案）；仍拒绝 ${searchStats.refusedQids.length} 题、检索未找到 ${searchStats.searchFailedQids.length} 题，已保留已得答案，可重试`,
          detail: failureDetail,
        },
      };
    },

    /** 附件型作业：生成提交文档（.docx） */
    async makeSubmissionDoc({
      work,
      questions = [],
      materials = '',
      templatePath = null,
      outDir,
      onEvent,
      maxPromptChars = 24_000,
      formatHint = 'Word（.docx）',
      timeoutMs: stepTimeoutMs = timeoutMs,
    } = {}) {
      if (!outDir) throw new Error('makeSubmissionDoc：缺少 outDir');
      ensureDir(outDir);
      // 有模板时把模板章节行 + 原文节选传给模型（否则模型不知道模板要求什么）
      let templateOutline = null;
      let templateText = '';
      if (templatePath && fs.existsSync(templatePath)) {
        try {
          const parsedTemplate = parseDocx(templatePath);
          templateOutline = parsedTemplate.paragraphs
            .map((p) => p.text.trim())
            .filter((t) => t && t.length <= 40 && /(习题|题目|练习|作业|实验|任务|第[一二三四五六七八九十\d]+)/.test(t));
          templateText = docxToText(templatePath).slice(0, 4000);
        } catch {
          templateOutline = null;
          templateText = '';
        }
      }
      const prompt = prompts.buildSubmissionPrompt({
        work,
        questions,
        materials,
        maxChars: maxPromptChars,
        formatHint,
        templateOutline,
        templateText,
      });
      log(`[engine:makeSubmissionDoc] 生成提交文档内容（模板：${templatePath || '无'}），提示词 ${prompt.length} 字符，超时 ${stepTimeoutMs}ms`);
      const runResult = await run({ step: 'makeSubmissionDoc', prompt, cwd: outDir, onEvent, timeoutMs: stepTimeoutMs });
      if (!runResult.ok) return fail('makeSubmissionDoc', runResult);

      let parsed;
      try {
        const { json, strategy } = extractJson(runResult.text);
        const submission = validateSubmission(json);
        parsed = { ...submission, strategy, raw: json };
      } catch (err) {
        const detail = err instanceof ParseError ? err.details : { message: err && err.message };
        log(`[engine:makeSubmissionDoc] 解析/校验失败：${err && err.message}`);
        return {
          ok: false,
          error: { code: 'BAD_MODEL_OUTPUT', message: err && err.message, detail },
          text: runResult.text,
          latencyMs: runResult.latencyMs,
          runCwd: runResult.runCwd,
        };
      }

      if (parsed.needMaterials.length) {
        // 缺资料（含「模板只有标题、拿不到原题」）：不生成文档，交给编排器暂停该项等用户补资料。
        // 注：即使模型写了部分 content，也不提交半成品，避免缺题文档被误交。
        return {
          ok: true,
          generated: false,
          filePath: null,
          format: 'docx',
          title: parsed.title,
          summary: { reason: 'needMaterials', contentChars: parsed.content ? parsed.content.length : 0 },
          sources: parsed.sources,
          needMaterials: parsed.needMaterials,
          confidence: parsed.confidence,
          strategy: parsed.strategy,
          text: runResult.text,
          latencyMs: runResult.latencyMs,
          runCwd: runResult.runCwd,
        };
      }

      const title = parsed.title || (work && (work.name || work.workName)) || '作业';
      let blocks = markdownToBlocks(parsed.content);
      // 模型常把「文档标题」写成第一个一级标题：若与 title 高度相似则去掉，避免与模板标题行重复
      const norm = (s) => String(s ?? '').replace(/[\s#*`>]|[:：·・,，.。、()（）\-]/g, '').toLowerCase();
      if (
        blocks.length &&
        (blocks[0].type === 'title' || blocks[0].type === 'h1') &&
        norm(blocks[0].text) &&
        (norm(blocks[0].text).includes(norm(title)) || norm(title).includes(norm(blocks[0].text)))
      ) {
        blocks = blocks.slice(1);
      }
      if (!blocks.length) {
        return {
          ok: false,
          error: { code: 'EMPTY_CONTENT', message: '模型返回的 content 为空，无法生成文档', detail: { title } },
          latencyMs: runResult.latencyMs,
        };
      }

      const outPath = path.join(outDir, `${safeFileName(title)}-${stamp()}.docx`);
      let docResult;
      try {
        if (templatePath && fs.existsSync(templatePath)) {
          const templateParsed = parseDocx(templatePath);
          const placeholders = listPlaceholders(templatePath);
          const ops = [];
          for (const ph of placeholders) {
            const name = ph.replace(/[{}]/g, '').trim().toLowerCase();
            if (name === 'title' || name === '标题') ops.push({ find: ph, replace: title });
            else if (name === 'content' || name === '正文' || name === 'answer')
              ops.push({ find: ph, replace: parsed.content });
          }
          const { ops: templateOps, matchedAnchors, unmatched } = buildTemplateOps(templateParsed, blocks, {
            excludeAnchors: [title, (work && (work.name || work.workName)) || '', '学生自检表'],
          });
          ops.push(...templateOps);
          const filled = fillDocxTemplate(templatePath, ops, outPath);
          docResult = {
            filePath: outPath,
            format: 'docx',
            templateUsed: true,
            placeholders,
            matchedAnchors,
            unmatchedBlocks: unmatched.length,
            warnings: filled.warnings,
            applied: filled.applied,
            paragraphs: filled.paragraphs,
          };
        } else {
          const created = newDocx({ title, blocks, outPath });
          docResult = { filePath: outPath, format: 'docx', templateUsed: false, paragraphs: created.paragraphs };
        }
      } catch (err) {
        log(`[engine:makeSubmissionDoc] 文档生成失败：${err && err.message}`);
        return {
          ok: false,
          error: { code: 'DOCGEN_FAILED', message: `文档生成失败：${err && err.message}`, detail: { outPath } },
          latencyMs: runResult.latencyMs,
        };
      }

      // 生成后自检：文档必须能读回，且正文有内容落在文档里（抽样多处片段，避免误报）
      let docText = '';
      try {
        docText = docxToText(outPath);
        const plain = parsed.content.replace(/[\s#*`>\-|]/g, '');
        const squashDoc = docText.replace(/[\s#*`>\-|]/g, '');
        const samples = [];
        const window = 16;
        for (let i = 0; i < Math.min(5, Math.max(1, Math.floor(plain.length / 80))); i++) {
          const start = Math.floor((plain.length - window) * (i / 4));
          if (start >= 0) samples.push(plain.slice(start, start + window));
        }
        const hit = samples.filter((s) => s.length >= 8 && squashDoc.includes(s)).length;
        if (!hit) {
          log('[engine:makeSubmissionDoc] 警告：生成文档中未匹配到正文片段（可能是模板兜底/截断差异）');
        }
      } catch (err) {
        return {
          ok: false,
          error: { code: 'DOCGEN_VERIFY_FAILED', message: `生成文档读回失败：${err && err.message}`, detail: { outPath } },
          latencyMs: runResult.latencyMs,
        };
      }

      return {
        ok: true,
        generated: true,
        ...docResult,
        title,
        summary: {
          title,
          blocks: blocks.length,
          contentChars: parsed.content.length,
          paragraphs: docResult.paragraphs,
          templateUsed: Boolean(docResult.templateUsed),
        },
        sources: parsed.sources,
        needMaterials: parsed.needMaterials,
        confidence: parsed.confidence,
        strategy: parsed.strategy,
        latencyMs: runResult.latencyMs,
        attempts: runResult.attempts ?? 1,
        runCwd: runResult.runCwd,
      };
    },

    /** 单道主观题作答 */
    async answerShort({
      work,
      question,
      materials = '',
      cwd,
      onEvent,
      maxPromptChars = 20_000,
      timeoutMs: stepTimeoutMs = Math.min(timeoutMs, 180_000),
    } = {}) {
      if (!question) throw new Error('answerShort：缺少 question');
      const prompt = prompts.buildShortAnswerPrompt({ work, question, materials, maxChars: maxPromptChars });
      const runResult = await run({ step: 'answerShort', prompt, cwd, onEvent, timeoutMs: stepTimeoutMs });
      if (!runResult.ok) return fail('answerShort', runResult);
      try {
        const { json, strategy } = extractJson(runResult.text);
        const validated = validateShortAnswer(json);
        return {
          ok: true,
          text: validated.text,
          content: validated.text,
          title: validated.title,
          sources: validated.sources,
          needMaterials: validated.needMaterials,
          confidence: validated.confidence,
          strategy,
          raw: json,
          latencyMs: runResult.latencyMs,
          attempts: runResult.attempts ?? 1,
          runCwd: runResult.runCwd,
        };
      } catch (err) {
        const detail = err instanceof ParseError ? err.details : { message: err && err.message };
        log(`[engine:answerShort] 解析/校验失败：${err && err.message}`);
        return {
          ok: false,
          error: { code: 'BAD_MODEL_OUTPUT', message: err && err.message, detail },
          text: runResult.text,
          latencyMs: runResult.latencyMs,
          runCwd: runResult.runCwd,
        };
      }
    },

    /** 为填空题生成“看起来合理但错误”的答案（目标正确率功能用，不返回正确答案）。 */
    async makeWrongAnswers({
      work,
      questions = [],
      correctAnswers = {},
      cwd,
      onEvent,
      maxPromptChars = 20_000,
      timeoutMs: stepTimeoutMs = Math.min(timeoutMs, 120_000),
    } = {}) {
      if (!Array.isArray(questions) || !questions.length) return { ok: true, answers: {}, latencyMs: 0 };
      const prompt = prompts.buildWrongAnswersPrompt({
        work,
        questions,
        correctAnswers,
        maxChars: maxPromptChars,
      });
      const runResult = await run({ step: 'makeWrongAnswers', prompt, cwd, onEvent, timeoutMs: stepTimeoutMs });
      if (!runResult.ok) return fail('makeWrongAnswers', runResult);
      try {
        const { json } = extractJson(runResult.text);
        const src = (json && json.answers && typeof json.answers === 'object') ? json.answers : json;
        const answers = {};
        for (const q of questions) {
          const qid = String(q.qid);
          const value = src && src[qid];
          if (value == null) continue;
          if (Array.isArray(value)) {
            const arr = value.map((x) => String(x ?? '').trim()).filter(Boolean);
            if (arr.length) answers[qid] = arr;
          } else {
            const text = String(value).trim();
            if (text) answers[qid] = text;
          }
        }
        if (!Object.keys(answers).length) {
          return { ok: false, error: { code: 'EMPTY_CONTENT', message: 'AI 未返回错误答案' }, latencyMs: runResult.latencyMs, runCwd: runResult.runCwd };
        }
        return { ok: true, answers, latencyMs: runResult.latencyMs, attempts: runResult.attempts ?? 1, runCwd: runResult.runCwd, raw: json };
      } catch (err) {
        const detail = err instanceof ParseError ? err.details : { message: err && err.message };
        log(`[engine:makeWrongAnswers] 解析失败：${err && err.message}`);
        return {
          ok: false,
          error: { code: 'BAD_MODEL_OUTPUT', message: err && err.message, detail },
          text: runResult.text,
          latencyMs: runResult.latencyMs,
          runCwd: runResult.runCwd,
        };
      }
    },

    /** 图片识题/OCR：调用 DeepSeek Messages 图像输入（默认 deepseek-flash），按文件哈希缓存。 */
    async ocrImages({ files = [], cacheDir = '', prompt, timeoutMs: t = 120_000, onEvent } = {}) {
      const started = Date.now();
      const r = await vision.ocrImages({
        files,
        dshHome,
        model: visionModel,
        baseURL: visionBaseURL,
        prompt,
        maxTokens: visionMaxTokens,
        timeoutMs: t,
        cacheDir,
        log,
        onEvent: (ev) => { try { if (onEvent) onEvent(ev); } catch {} },
      });
      return { ...r, latencyMs: Date.now() - started };
    },

    /** 取消当前调用（杀进程树） */
    async cancel() {
      cancelled = true;
      if (activeController) {
        log('[engine] 收到取消请求，终止当前 headless 调用');
        activeController.abort();
        activeController = null;
        return { ok: true, cancelled: true };
      }
      return { ok: true, cancelled: false };
    },

    /** 恢复可调用状态（取消后可重新使用同一实例） */
    reset() {
      cancelled = false;
      return { ok: true };
    },

    /** 版本信息 */
    async version() {
      const info = await getVersion({
        dshBin,
        dshHome,
        cwd: path.join(resolvedWorkRoot, `version-${stamp()}`),
      });
      return { ...info, version: (info.stdout || '').trim() };
    },

    /** 组合后的 profile 配置（--dump-config 文本；用于自检隐私补丁/模型覆盖是否生效） */
    async dumpConfig({ patchFiles: extra = [] } = {}) {      const cwd = ensureDir(path.join(resolvedWorkRoot, `dump-${stamp()}`));
      return dshDumpConfig({
        dshBin,
        dshHome,
        cwd,
        patchFiles: [...runPatchFiles, ...extra],
        timeoutMs: Math.min(timeoutMs, 120_000),
      });
    },
  };
}

export default createEngine;
