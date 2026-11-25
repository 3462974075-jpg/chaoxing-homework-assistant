/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * dsh.mjs — 封装 `dsh --profile headless --json` 子进程调用
 *
 * 为什么不用管道（重要）：
 *   本机 DSH workspace-write 沙箱下，Node 用管道 stdio（spawn 默认 'pipe'）会
 *   报 `spawn EPERM`；但**文件型 stdio 可用**。因此本模块：
 *     - stdout/stderr 重定向到 cwd 下的 engine-out.ndjson / engine-err.log（fs.openSync 的 fd）
 *     - onEvent：每 pollMs 轮询文件增量、按行 JSON.parse、实时派发（不攒到最后）
 *     - 进程结束后再读完整文件取 `final.text`
 *     - 超长提示词通过「提示词文件 + stdin fd」传入（headless 支持 task 为 `-` 读 stdin）
 *     - 超时 Windows 用 `taskkill /PID <pid> /T /F` 杀进程树
 *
 * 事件类型（已实测）：session / status / thinking / text / final / error
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 本机已安装的 DSH CLI 入口（可用 dshBin 参数覆盖） */
export const DEFAULT_DSH_BIN =
  'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';

/** 判断某个路径是否是 Windows 命令脚本（.cmd/.bat） */
export function isCmdShim(filePath) {
  return /\.(cmd|bat)$/i.test(String(filePath ?? ''));
}

/** 从 dsh.cmd 所在目录推导真正的 CLI 入口 lib/bin.js（npm/npm-global/便携安装通用） */
function binJsFromCmdShim(cmdPath) {
  const dir = path.dirname(cmdPath);
  const candidates = [
    path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(dir, 'lib', 'bin.js'),
    path.join(dir, '..', 'lib', 'bin.js'),
    path.join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 定位 DSH CLI 的 node 入口（lib/bin.js），**绝不返回 .cmd/.bat**：
 * 查找顺序：显式 dshBin → 环境变量 DSH_BIN → <root>\dsh\... → 系统 npm global → DEFAULT_DSH_BIN。
 * 若某候选是 `dsh.cmd`/`.bat`，先在同目录找 `node_modules/@deepseek-ai/dsh/lib/bin.js`；
 * 找不到时返回该 .cmd 路径，由 runOnce 报清晰错误（不会用 node 去执行 .cmd）。
 *
 * @param {{dshBin?:string, appRoot?:string, env?:Record<string,string>}} opts
 * @returns {string} 找到的 bin.js 绝对路径（可能不存在或为无解的 .cmd，调用方需校验）
 */
export function resolveDshBin({ dshBin, appRoot, env = process.env } = {}) {
  const candidates = [];
  if (dshBin) candidates.push(dshBin);
  if (env.DSH_BIN) candidates.push(env.DSH_BIN);
  const root = appRoot || env.CX_APP_ROOT || env.DSH_APP_ROOT || null;
  if (root) {
    const r = path.resolve(root);
    candidates.push(path.join(r, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    candidates.push(path.join(r, 'dsh', 'lib', 'bin.js'));
    candidates.push(path.join(r, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    // 便携 npm --prefix 安装产出的命令垫片：<root>\dsh\dsh.cmd
    candidates.push(path.join(r, 'dsh', 'dsh.cmd'));
  }
  const appData = env.APPDATA || '';
  if (appData) {
    candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    candidates.push(path.join(appData, 'npm', 'dsh.cmd'));
  }
  candidates.push(DEFAULT_DSH_BIN);

  let cmdFallback = null;
  const consider = (candidate) => {
    try {
      if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
      if (isCmdShim(candidate)) {
        if (!cmdFallback) cmdFallback = path.resolve(candidate);
        const bin = binJsFromCmdShim(candidate);
        if (bin) return bin;
        return null; // 只有 .cmd：继续找别的候选
      }
      return path.resolve(candidate);
    } catch {
      return null;
    }
  };
  for (const candidate of candidates) {
    const found = consider(candidate);
    if (found) return found;
  }
  // 全部候选都没有 bin.js：若曾遇到 .cmd，返回它让 runOnce 给出明确报错；否则返回最后候选
  if (cmdFallback) return cmdFallback;
  return candidates[candidates.length - 1];
}

/** 把「JS 入口 / .exe / .cmd」统一转换为可 spawn 的 { command, argv } */
export function buildLaunchCommand(resolvedBin, args = []) {
  const bin = String(resolvedBin ?? '');
  if (!bin) throw new Error('DSH 入口为空，无法启动（请提供 lib/bin.js 路径）');
  if (isCmdShim(bin)) {
    // 防御：绝不能用 node 执行 .cmd（会报 SyntaxError: Invalid or unexpected token）
    const binJs = binJsFromCmdShim(bin);
    if (binJs) return { command: process.execPath, argv: [binJs, ...args] };
    const err = new Error(
      `DSH 入口是 .cmd/.bat 命令垫片（${bin}），无法直接启动；请改用其同目录 node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`
    );
    err.code = 'DSH_BIN_IS_CMD';
    throw err;
  }
  if (/\.exe$/i.test(bin)) return { command: bin, argv: [...args] };
  return { command: process.execPath, argv: [bin, ...args] };
}

/** 单次调用默认超时 5 分钟（设计说明 5.2 / 联调后从 600s 收紧为 300s） */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** 循环保护：最多允许的 agent step 数（status.step_start 计数） */
export const DEFAULT_MAX_STEPS = 60;

/** 循环保护：最多允许的工具调用数（tool_call 事件计数） */
export const DEFAULT_MAX_TOOL_CALLS = 60;

/** 循环保护：连续多久没有 text/thinking 产出增量即判定卡死（毫秒） */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/** 提示词超过该长度改用 stdin（避免 Windows 命令行 32767 字符上限） */
export const STDIN_PROMPT_THRESHOLD = 6000;

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 构造干净的子进程环境变量：
 *   - 保留系统环境（PATH 等）
 *   - 清掉继承来的 DSH_*（尤其 DSH_SESSION_ID / DSH_PROFILE / DSH_WEB_URL，
 *     否则 nested headless 可能误用当前 GUI 会话）
 *   - 只设置我们自己的 DSH_HOME
 *   - `DSH_TELEMETRY_DISABLED=1`：启动器级硬禁用 OTel 遥测（隐私双保险；
 *     profile 层另有 session-telemetry-otel: mode DISABLED 的持久补丁）
 */
export function buildChildEnv(dshHome, extraEnv = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'DSH_HOME') continue;
    if (key.startsWith('DSH_')) continue;
    env[key] = value;
  }
  env.DSH_HOME = dshHome;
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.DSH_TELEMETRY_DISABLED = '1';
  Object.assign(env, extraEnv);
  return env;
}

function killTree(child, log) {
  if (!child || child.killed || child.exitCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  // 1) 先直接 SIGKILL 自己 spawn 的子进程：最可靠，不受 taskkill 权限/沙箱限制影响
  try {
    process.kill(pid, 'SIGKILL');
    log?.(`已 SIGKILL pid=${pid}`);
  } catch {
    /* ignore */
  }
  // 2) 再尽力杀整个进程树（Windows taskkill /T /F；失败则由上一步兜底）
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        /* 已由 SIGKILL 兜底 */
      });
      killer.unref?.();
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* 已由 SIGKILL 兜底 */
      }
    }
  } catch (err) {
    log?.(`终止子进程树失败（已由 SIGKILL 兜底）：${err && err.message}`);
  }
}

function makeRunPaths(cwd) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    outPath: path.join(cwd, `engine-out-${stamp}.ndjson`),
    errPath: path.join(cwd, `engine-err-${stamp}.log`),
    promptPath: path.join(cwd, `engine-prompt-${stamp}.txt`),
  };
}

function readFrom(fd, state, chunkSize = 64 * 1024) {
  const buf = Buffer.allocUnsafe(chunkSize);
  for (;;) {
    let bytes;
    try {
      bytes = fs.readSync(fd, buf, 0, chunkSize, state.pos);
    } catch (err) {
      if (err && err.code === 'EAGAIN') return;
      throw err;
    }
    if (!bytes) return;
    state.pos += bytes;
    state.pending += buf.toString('utf8', 0, bytes);
  }
}

function takeLines(state) {
  const lines = [];
  let idx;
  while ((idx = state.pending.indexOf('\n')) >= 0) {
    const line = state.pending.slice(0, idx).replace(/\r$/, '');
    state.pending = state.pending.slice(idx + 1);
    if (line.trim()) lines.push(line);
  }
  return lines;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // NDJSON：正常以 { 开头；兼容极端情况下混入的非 JSON 行
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readWhole(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

const TRANSIENT_RE =
  /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|rate.?limit|429|500|502|503|504|overloaded|temporarily|timeout)/i;

function isTransientFailure(result) {
  if (result.timedOut || result.cancelled || result.loopDetected) return false;
  if (result.spawnError) return true;
  const haystack = `${result.stderr || ''}\n${result.errorText || ''}`;
  return TRANSIENT_RE.test(haystack);
}

/**
 * 循环保护判定：step 数 / tool_call 数 / 无产出时长任一超限即返回原因。
 * @returns {string|null} 命中原因（null = 正常）
 */
function detectLoop({ stepCount, toolCallCount, lastProgressAt, maxSteps, maxToolCalls, idleTimeoutMs }) {
  if (maxSteps > 0 && stepCount > maxSteps) return `step 数超过上限 ${maxSteps}（实际 ${stepCount}）`;
  if (maxToolCalls > 0 && toolCallCount > maxToolCalls)
    return `工具调用数超过上限 ${maxToolCalls}（实际 ${toolCallCount}）`;
  if (idleTimeoutMs > 0 && Date.now() - lastProgressAt > idleTimeoutMs)
    return `连续 ${Math.round(idleTimeoutMs / 1000)}s 没有 text/thinking 产出（疑似检索卡死）`;
  return null;
}

/**
 * 执行一次 headless 调用（含重试策略由 runHeadless 控制）。
 * @param {{
 *   prompt: string,
 *   cwd: string,
 *   dshHome: string,
 *   dshBin?: string,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   onEvent?: (evt:any)=>void,
 *   env?: Record<string,string>,
 *   log?: (msg:string)=>void,
 *   signal?: AbortSignal,
 *   stdinPromptThreshold?: number,
 *   patchFiles?: string[],   // 额外 --patch 覆盖层（如模型覆盖），必须在 app 参数之前
 *   extraArgs?: string[],
 *   maxSteps?: number,        // 循环保护：step 上限（默认 60，0=关闭）
 *   maxToolCalls?: number,    // 循环保护：tool_call 上限（默认 60，0=关闭）
 *   idleTimeoutMs?: number,   // 循环保护：无 text/thinking 产出的最长毫秒（默认 90000，0=关闭）
 * }} opts
 * @returns {Promise<{
 *   ok:boolean, text:string, events:any[], finalEvent:any|null, code:number|null,
 *   signal:string|null, timedOut:boolean, cancelled:boolean, latencyMs:number,
 *   loopDetected:boolean, loopReason:string|null, stepCount:number, toolCallCount:number,
 *   stderr:string, errorText:string|null, spawnError:string|null,
 *   outPath:string, errPath:string, promptViaStdin:boolean, pid:number|null,
 * }>}
 */
export async function runOnce(opts) {
  const {
    prompt,
    cwd,
    dshHome,
    dshBin = DEFAULT_DSH_BIN,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = 400,
    onEvent,
    env: extraEnv,
    log,
    signal,
    stdinPromptThreshold = STDIN_PROMPT_THRESHOLD,
    patchFiles = [],
    extraArgs = [],
    maxSteps = DEFAULT_MAX_STEPS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  } = opts || {};

  if (!prompt || typeof prompt !== 'string') throw new Error('runOnce：prompt 不能为空');
  if (!dshHome) throw new Error('runOnce：缺少 dshHome');
  fs.mkdirSync(cwd, { recursive: true });
  if (!fs.existsSync(dshHome)) throw new Error(`runOnce：DSH_HOME 不存在：${dshHome}`);

  const started = Date.now();
  const paths = makeRunPaths(cwd);
  const useStdin = prompt.length > stdinPromptThreshold;
  let resolvedBin = dshBin || DEFAULT_DSH_BIN;
  // 防御：传入 .cmd/.bat（如 dsh.cmd）时，先解析为其同目录的 lib/bin.js
  if (isCmdShim(resolvedBin)) {
    const binJs = binJsFromCmdShim(resolvedBin);
    if (binJs) {
      log?.(`dshBin 是 .cmd 垫片，已改用真实的 lib/bin.js：${binJs}`);
      resolvedBin = binJs;
    }
  }
  if (typeof resolvedBin !== 'string' || !resolvedBin) {
    throw new Error(`runOnce：dshBin 无效（${JSON.stringify(dshBin)}）`);
  }
  if (!isCmdShim(resolvedBin) && !fs.existsSync(resolvedBin)) {
    throw new Error(`runOnce：找不到 DSH CLI：${resolvedBin}`);
  }

  const args = ['--profile', 'headless'];
  for (const patchFile of patchFiles) {
    if (!patchFile) continue;
    if (!fs.existsSync(patchFile)) throw new Error(`runOnce：--patch 文件不存在：${patchFile}`);
    args.push('--patch', path.resolve(patchFile));
  }
  args.push('--json');
  if (useStdin) {
    fs.writeFileSync(paths.promptPath, prompt, 'utf8');
    args.push('-');
  } else {
    args.push(prompt);
  }
  args.push(...extraArgs);

  const launch = buildLaunchCommand(resolvedBin, args);

  const outFd = fs.openSync(paths.outPath, 'w');
  const errFd = fs.openSync(paths.errPath, 'w');
  const promptFd = useStdin ? fs.openSync(paths.promptPath, 'r') : 'ignore';

  const child = spawn(launch.command, launch.argv, {
    cwd,
    env: buildChildEnv(dshHome, extraEnv),
    windowsHide: true,
    detached: false,
    stdio: [promptFd, outFd, errFd],
  });

  const events = [];
  let finalEvent = null;
  let errorText = null;
  let spawnError = null;
  let timedOut = false;
  let cancelled = false;
  let code = null;
  let sig = null;
  let settled = false;
  let pollTimer = null;
  let killTimer = null;
  let deadlineTimer = null;
  const outState = { pos: 0, pending: '' };
  let outFdRead = null;
  let errFdRead = null;

  // ---- 循环保护状态 ----
  let loopDetected = false;
  let loopReason = null;
  let stepCount = 0;
  let toolCallCount = 0;
  let lastProgressAt = Date.now();

  const tripLoop = (reason, where) => {
    if (loopDetected) return;
    loopDetected = true;
    loopReason = reason;
    log?.(`检测到检索循环/卡死（${where}）：${reason}，终止进程树`);
    killTree(child, log);
    killTimer = setTimeout(finish, 4000);
  };

  const checkLoop = (where) => {
    if (loopDetected) return;
    const reason = detectLoop({ stepCount, toolCallCount, lastProgressAt, maxSteps, maxToolCalls, idleTimeoutMs });
    if (reason) tripLoop(reason, where);
  };

  const dispatch = (evt) => {
    if (!evt) return;
    events.push(evt);
    if (evt.type === 'final' && typeof evt.text === 'string') finalEvent = evt;
    if (evt.type === 'error') {
      const msg = typeof evt.error === 'string' ? evt.error : evt.message || JSON.stringify(evt);
      errorText = msg;
    }
    // 循环保护计数：agent step / 工具调用 / 产出活跃度
    if (evt.type === 'status' && evt.phase === 'step_start') stepCount++;
    else if (evt.type === 'tool_call') toolCallCount++;
    else if (evt.type === 'text' || evt.type === 'thinking') lastProgressAt = Date.now();
    try {
      onEvent?.(evt);
    } catch (err) {
      log?.(`onEvent 回调异常（已忽略）：${err && err.message}`);
    }
  };

  const poll = () => {
    try {
      if (!outFdRead) outFdRead = fs.openSync(paths.outPath, 'r');
      readFrom(outFdRead, outState);
      for (const line of takeLines(outState)) dispatch(parseLine(line));
    } catch (err) {
      log?.(`轮询 stdout 文件失败：${err && err.message}`);
    }
    if (!settled) checkLoop('poll');
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    try {
      pollTimer && clearInterval(pollTimer);
      deadlineTimer && clearTimeout(deadlineTimer);
      killTimer && clearTimeout(killTimer);
    } catch {
      /* ignore */
    }
    // 最终把文件尾部读完
    try {
      poll();
      const tail = outState.pending.trim();
      if (tail) {
        outState.pending = '';
        dispatch(parseLine(tail));
      }
    } catch {
      /* ignore */
    }
    // 进程已退出时也补一次循环判定（例如 mock/极快时序下 poll 尚未触发）
    if (!loopDetected) {
      const reason = detectLoop({ stepCount, toolCallCount, lastProgressAt, maxSteps, maxToolCalls, idleTimeoutMs });
      if (reason) {
        loopDetected = true;
        loopReason = reason;
      }
    }
    try {
      if (outFdRead) fs.closeSync(outFdRead);
    } catch {
      /* ignore */
    }
    // 防止极端情况下子进程未真正退出时把父进程事件循环挂住
    try {
      child.unref?.();
    } catch {
      /* ignore */
    }
    const stderr = stripAnsi(readWhole(paths.errPath));
    const stdoutText = readWhole(paths.outPath);
    let text = finalEvent && typeof finalEvent.text === 'string' ? finalEvent.text : '';
    if (!text) {
      // 兜底 1：最后一个 text 事件
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'text' && typeof events[i].text === 'string' && events[i].text) {
          text = events[i].text;
          break;
        }
      }
    }
    if (!text) {
      // 兜底 2：stdout 原样（可能不是 --json 格式）
      const plainLines = stdoutText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('{'));
      if (plainLines.length) text = plainLines.join('\n');
    }
    const result = {
      ok: code === 0 && !timedOut && !cancelled && !loopDetected && (!!text || !!finalEvent),
      text: text || '',
      events,
      finalEvent,
      code,
      signal: sig,
      timedOut,
      cancelled,
      loopDetected,
      loopReason,
      stepCount,
      toolCallCount,
      latencyMs: Date.now() - started,
      stderr,
      errorText,
      spawnError,
      outPath: paths.outPath,
      errPath: paths.errPath,
      promptViaStdin: useStdin,
      pid: child.pid ?? null,
    };
    resolveFn(result);
  };

  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  pollTimer = setInterval(poll, pollMs);
  if (timeoutMs > 0) {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      log?.(`headless 调用超时（${timeoutMs}ms），终止进程树`);
      killTree(child, log);
      // 给 taskkill 一点时间，最多再等 5s 强制结束
      killTimer = setTimeout(finish, 5000);
    }, timeoutMs);
  }

  const onAbort = () => {
    cancelled = true;
    killTree(child, log);
    killTimer = setTimeout(finish, 5000);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  child.on('error', (err) => {
    spawnError = err && err.message ? err.message : String(err);
    log?.(`子进程启动/运行错误：${spawnError}`);
    finish();
  });
  child.on('close', (exitCode, exitSignal) => {
    code = exitCode;
    sig = exitSignal;
    // 关闭父进程持有的写端 fd（子进程已退出）
    for (const fd of [outFd, errFd]) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (useStdin && typeof promptFd === 'number') {
      try {
        fs.closeSync(promptFd);
      } catch {
        /* ignore */
      }
    }
    finish();
  });

  return promise;
}

/**
 * 带「临时错误重试 1 次」的 headless 调用。
 * @returns 同 runOnce，额外包含 attempts
 */
export async function runHeadless(opts) {
  const { retry: doRetry = true, retryDelayMs = 1500, log } = opts || {};
  const first = await runOnce(opts);
  if (first.ok || !doRetry || !isTransientFailure(first)) return { ...first, attempts: 1 };
  log?.(`检测到临时性失败，1 次重试：${(first.stderr || first.errorText || '').slice(0, 200)}`);
  await sleep(retryDelayMs);
  const second = await runOnce(opts);
  return { ...second, attempts: 2, firstFailure: { code: first.code, timedOut: first.timedOut, stderr: first.stderr.slice(-2000) } };
}

/** 运行 `node <dsh> --version`（文件型 stdio 抓输出） */
export async function getVersion({ dshBin = DEFAULT_DSH_BIN, dshHome, cwd, timeoutMs = 30_000 } = {}) {
  return runSimpleCli({ dshBin, dshHome, cwd, timeoutMs, args: ['--version'] });
}

/**
 * 运行 `node <dsh> --profile headless --dump-config`，返回组合后的 profile 配置文本。
 * 用于自检「隐私补丁 / 模型覆盖」是否真的进了 composition（不启动 agent）。
 */
export async function dumpConfig({
  dshBin = DEFAULT_DSH_BIN,
  dshHome,
  cwd,
  patchFiles = [],
  timeoutMs = 120_000,
} = {}) {
  const args = ['--profile', 'headless'];
  for (const file of patchFiles) {
    if (file) args.push('--patch', path.resolve(file));
  }
  args.push('--dump-config');
  return runSimpleCli({ dshBin, dshHome, cwd, timeoutMs, args });
}

/** 通用：跑一个短命 CLI 子命令，文件型 stdio 收集 stdout/stderr */
async function runSimpleCli({ dshBin, dshHome, cwd, timeoutMs, args }) {
  const work = cwd || process.cwd();
  fs.mkdirSync(work, { recursive: true });
  let bin = dshBin || DEFAULT_DSH_BIN;
  if (isCmdShim(bin)) {
    const binJs = binJsFromCmdShim(bin);
    if (binJs) bin = binJs;
  }
  if (!isCmdShim(bin) && !fs.existsSync(bin)) throw new Error(`找不到 DSH CLI：${bin}`);
  const launch = buildLaunchCommand(bin, args);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const out = path.join(work, `dsh-cli-${id}.out.txt`);
  const err = path.join(work, `dsh-cli-${id}.err.txt`);
  const outFd = fs.openSync(out, 'w');
  const errFd = fs.openSync(err, 'w');
  const env = dshHome ? buildChildEnv(dshHome) : buildChildEnv(process.env.DSH_HOME || '');
  const child = spawn(launch.command, launch.argv, {
    cwd: work,
    env,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
  });
  const [code] = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      killTree(child);
      resolve([null]);
    }, timeoutMs);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve([exitCode]);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve([null]);
    });
  });
  try {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  } catch {
    /* ignore */
  }
  return {
    ok: code === 0,
    code,
    stdout: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '',
    stderr: stripAnsi(fs.existsSync(err) ? fs.readFileSync(err, 'utf8') : ''),
  };
}

/**
 * 确保 DSH_HOME 已有基础 profile（cordis.yml 等）再写隐私 patch。
 *
 * 背景（v1.4 修复）：全新机器上如果先保存 API Key，会由 ensureHome 直接创建
 * `profiles/headless/cordis.patch.yml`，但此时 DSH 还没生成基础 profile（cordis.yml）。
 * DSH 启动时加载 overlay patch 会报错，表现为“AI 引擎自检失败/不可用”。
 * 这里先用一次 `dsh --profile headless --help` 让 DSH 初始化基础 profile（不会调用模型），
 * 再允许写入隐私补丁；若发现 patch-only 的坏 home，会先备份 patch、初始化后再恢复。
 */
export async function initHome({ dshHome, dshBin = DEFAULT_DSH_BIN, cwd, timeoutMs = 120_000, log } = {}) {
  if (!dshHome) throw new Error('initHome：缺少 dshHome');
  fs.mkdirSync(dshHome, { recursive: true });
  const profileDir = path.join(dshHome, 'profiles', 'headless');
  const baseFile = path.join(profileDir, 'cordis.yml');
  if (fs.existsSync(baseFile)) return { ok: true, initialized: false, repaired: false };
  fs.mkdirSync(profileDir, { recursive: true });

  // 坏 home：只有 privacy patch，没有基础 profile → 先备份 patch，避免 DSH 启动时加载失败
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const backupFile = patchFile + '.bak-' + Date.now();
  let moved = false;
  if (fs.existsSync(patchFile)) {
    try {
      fs.renameSync(patchFile, backupFile);
      moved = true;
    } catch {
      /* ignore */
    }
  }

  const work = cwd || path.join(dshHome, 'init');
  const args = ['--profile', 'headless', '--help'];
  let result = null;
  try {
    result = await runSimpleCli({ dshBin, dshHome, cwd: work, timeoutMs, args });
    log?.(`DSH_HOME 初始化：exit=${result.code}${result.stderr ? ' stderr=' + result.stderr.slice(-400) : ''}`);
  } catch (err) {
    log?.(`DSH_HOME 初始化失败：${err && err.message}`);
  }

  const initialized = fs.existsSync(baseFile);
  if (initialized) {
    // 初始化成功：旧的坏 patch 已备份/由后续 credentials.ensureHome 重写，删掉备份
    if (moved) {
      try {
        fs.rmSync(backupFile, { force: true });
      } catch {
        /* ignore */
      }
    }
    return { ok: true, initialized: true, repaired: moved, code: result ? result.code : null };
  }
  // 初始化失败：恢复原 patch，至少保持原状
  if (moved) {
    try {
      fs.renameSync(backupFile, patchFile);
    } catch {
      /* ignore */
    }
  }
  return { ok: false, initialized: false, repaired: false, code: result ? result.code : null, stderr: result ? result.stderr.slice(-1000) : '' };
}

/** 健康检查：让模型只回 OK，返回 { ok, version, latencyMs, text, detail } */
export async function check({
  dshHome,
  dshBin = DEFAULT_DSH_BIN,
  cwd,
  timeoutMs = 180_000,
  patchFiles = [],
  log,
} = {}) {
  if (!cwd) throw new Error('check：需要 cwd（独立工作目录）');
  const versionInfo = await getVersion({ dshBin, dshHome, cwd }).catch((err) => ({
    ok: false,
    stdout: '',
    stderr: err && err.message,
  }));
  const run = await runHeadless({
    prompt: '只回复两个大写字母：OK。不要调用任何工具，不要输出其它文字。',
    cwd,
    dshHome,
    dshBin,
    timeoutMs,
    patchFiles,
    log,
  });
  let text = (run.text || '').trim();
  let ok = run.ok && /OK/i.test(text);
  let finalRun = run;
  // 模型偶尔会回一段话而不是严格 OK：再试一次（健康检查只关心「能跑通并回话」）
  if (run.ok && !ok && text) {
    log?.(`健康检查回复不是 OK（${JSON.stringify(text.slice(0, 80))}），重试一次`);
    finalRun = await runHeadless({
      prompt: '只回复两个大写字母：OK。不要调用任何工具，不要输出其它文字。',
      cwd,
      dshHome,
      dshBin,
      timeoutMs,
      patchFiles,
      log,
      retry: false,
    });
    text = (finalRun.text || '').trim();
    ok = finalRun.ok && /OK/i.test(text);
  }
  return {
    ok,
    version: ((versionInfo && versionInfo.stdout) || '').trim() || 'unknown',
    latencyMs: run.latencyMs,
    text,
    attempts: run.attempts ?? 1,
    detail: ok ? null : { code: finalRun.code, stderr: finalRun.stderr.slice(-2000), errorText: finalRun.errorText },
  };
}

export { TRANSIENT_RE };
