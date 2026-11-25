#!/usr/bin/env node
/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * selftest.mjs — AI 引擎自测
 *
 * 覆盖（对应 task-1 验收标准）：
 *   ① 真实 headless 调用（回应 OK），至少 1 次；优先用「本引擎 ensureHome 生成的测试 DSH_HOME」，
 *      失败则回退到只读的 probe-dsh-home（不复制、不打印凭据）。
 *   ② 3 道 mock 题（单选/多选/填空）真实求解，并用 parse.validateObjectiveAnswers 校验合法性。
 *   ③ newDocx → docxToText 往返。
 *   ④ 真实模板 第6次作业模板.docx 用 fillDocxTemplate 填充，python-docx 读回校验。
 *   ⑤ 解析器三种形态：```json 代码块 / 前后有解释文字 / 纯 JSON。
 *   ⑥ credentials.ensureHome 原子写 + readKeyRef 只返回是否已配置。
 *
 * 用法：
 *   node selftest.mjs               # 全量（含真实 headless）
 *   node selftest.mjs --offline     # 跳过真实 headless（只测纯本地逻辑）
 *   node selftest.mjs --dsh-home=<dir> --dsh-bin=<bin.js>
 *
 * 注意：本脚本不会把 API Key / Cookie 打印到 stdout。复制 Key 只发生在内存 → 原子写入测试 home。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createEngine } from './index.mjs';
import { credentials, privacy as privacyModule, PRIVACY } from './index.mjs';
import { buildObjectivePrompt, buildSubmissionPrompt, buildShortAnswerPrompt } from './prompts.mjs';
import { extractJson, validateObjectiveAnswers, ParseError } from './parse.mjs';
import { newDocx, docxToText, parseDocx, fillDocxTemplate, markdownToBlocks, buildTemplateOps } from './docgen.mjs';
import {
  runHeadless,
  resolveDshBin,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} from './dsh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const TMP = path.join(HERE, '_tmp', 'selftest');
const OUT = path.join(TMP, 'out');
const PROBE_HOME = path.join(APP_DIR, 'probe-dsh-home');
const TEMPLATE = path.join(APP_DIR, '..', '学习通_作业自动化', '第6次作业模板.docx');

const argv = process.argv.slice(2);
const offline = argv.includes('--offline');
const arg = (name, def = undefined) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const dshBin = arg('dsh-bin', process.env.DSH_BIN || undefined);

/* ---------------- 测试框架（极简） ---------------- */
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('返回 false');
    passed++;
    console.log(`  \u2714 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err && err.stack ? err.stack : String(err) });
    console.log(`  \u2718 ${name}\n      ${err && err.message ? err.message : err}`);
  }
}
async function testAsync(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('返回 false');
    passed++;
    console.log(`  \u2714 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err && err.stack ? err.stack : String(err) });
    console.log(`  \u2718 ${name}\n      ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------- 文件型 stdio 子进程（本机沙箱禁管道） ---------------- */
function spawnCapture(cmd, args, { cwd = TMP, timeoutMs = 30_000 } = {}) {
  fs.mkdirSync(cwd, { recursive: true });
  const id = crypto.randomBytes(4).toString('hex');
  const outPath = path.join(cwd, `spawn-${id}.out`);
  const errPath = path.join(cwd, `spawn-${id}.err`);
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const child = spawn(cmd, args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    stdio: ['ignore', outFd, errFd],
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.closeSync(outFd);
        fs.closeSync(errFd);
      } catch {
        /* ignore */
      }
      resolve({
        code,
        stdout: fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '',
        stderr: fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '',
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      try {
        fs.closeSync(outFd);
        fs.closeSync(errFd);
      } catch {
        /* ignore */
      }
      resolve({ code: -1, stdout: '', stderr: String(err && err.message) });
    });
  });
}

/* ---------------- 隐私：只在内存里读取探针 Key，绝不打印 ---------------- */
function readProbeKeyInMemory() {
  const credPath = path.join(PROBE_HOME, '.credentials.yaml');
  if (!fs.existsSync(credPath)) return { key: null, reason: `probe home 缺少凭据文件：${credPath}` };
  const text = fs.readFileSync(credPath, 'utf8');
  const parsed = credentials.parseCredentialsYaml(text);
  const key = parsed.refs.DEEPSEEK_API_KEY || null;
  return { key, reason: key ? null : 'probe home 凭据中无 DEEPSEEK_API_KEY' };
}

/* ---------------- 主流程 ---------------- */
const startedAll = Date.now();
console.log('== AI 引擎 selftest ==');
console.log(`node ${process.version}  cwd=${process.cwd()}`);
console.log(`engine=${HERE}`);
console.log(`probeHome=${PROBE_HOME}${fs.existsSync(PROBE_HOME) ? '' : '（不存在）'}`);
console.log(`template=${TEMPLATE}${fs.existsSync(TEMPLATE) ? '' : '（不存在）'}`);
console.log(offline ? '模式：OFFLINE（跳过真实 headless）' : '模式：FULL（含真实 headless）');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* ===== ⑤ 解析器三种形态 ===== */
console.log('\n[1/9] 解析器：代码块 / 解释文字 / 纯 JSON');
const sampleQuestions = [
  { qid: 'q1', type: 'single', stem: '示例单选', opts: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] },
  {
    qid: 'q2',
    type: 'multi',
    stem: '示例多选',
    opts: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }, { key: 'C', text: '丙' }, { key: 'D', text: '丁' }],
  },
  { qid: 'q3', type: 'blank', stem: '示例填空', blanks: ['第1空', '第2空'] },
];
const answerJson = {
  answers: { q1: 'A', q2: 'abd', q3: ['2', '6'] },
  sources: [{ title: '示例来源', url: 'https://example.com' }],
  needMaterials: [],
  confidence: 0.93,
};

test('形态1：```json 代码块', () => {
  const text = `我先检索一下。\n\n\`\`\`json\n${JSON.stringify(answerJson, null, 2)}\n\`\`\`\n\n以上。`;
  const { json, strategy } = extractJson(text);
  assert(strategy === 'fenced', `strategy=${strategy}`);
  assert(json.answers.q2 === 'abd', 'q2 内容不对');
});

test('形态2：前后有解释文字的裸 JSON', () => {
  const text = `好的，答案如下：\n${JSON.stringify(answerJson)}\n以上结论仅供参考。`;
  const { json, strategy } = extractJson(text);
  assert(strategy === 'embedded', `strategy=${strategy}`);
  assert(json.answers.q3.length === 2, 'q3 内容不对');
});

test('形态3：纯 JSON', () => {
  const { json, strategy } = extractJson(JSON.stringify(answerJson));
  assert(strategy === 'plain', `strategy=${strategy}`);
  assert(json.confidence === 0.93, 'confidence 不对');
});

test('嵌套/字符串里的花括号不影响提取', () => {
  const payload = `{ "answers": { "q1": "A" }, "sources": [], "note": "包含 { 和 } 的文本", "confidence": 1 }`;
  const { json } = extractJson(`解释 ${payload} 尾巴`);
  assert(json.note.includes('{'), 'note 丢失');
});

test('校验：qid 全覆盖 / 多选归一化 / 填空长度', () => {
  const parsed = extractJson(`\`\`\`json\n${JSON.stringify(answerJson)}\n\`\`\``).json;
  const r = validateObjectiveAnswers(sampleQuestions, parsed);
  assert(r.answers.q1 === 'A', 'q1 应为 A');
  assert(r.answers.q2 === 'ABD', `q2 应归一化为 ABD，实际 ${r.answers.q2}`);
  assert(JSON.stringify(r.answers.q3) === '["2","6"]', 'q3 归化错误');
  assert(r.missing.length === 0, '不应缺答案');
});

test('校验失败：单选给了两个字母 → 抛 ParseError', () => {
  try {
    validateObjectiveAnswers(sampleQuestions, { answers: { q1: 'AB', q2: 'AB', q3: ['1', '2'] } });
  } catch (err) {
    assert(err instanceof ParseError, '应抛 ParseError');
    assert(/单个选项字母/.test(err.message), `错误信息不匹配：${err.message}`);
    return;
  }
  throw new Error('未抛错');
});

test('校验失败：多选含不存在的选项 → 抛 ParseError', () => {
  try {
    validateObjectiveAnswers(sampleQuestions, { answers: { q1: 'A', q2: 'AE', q3: ['1', '2'] } });
  } catch (err) {
    assert(/不存在的选项/.test(err.message), `错误信息不匹配：${err.message}`);
    return;
  }
  throw new Error('未抛错');
});

test('校验失败：填空数量不匹配 → 抛 ParseError', () => {
  try {
    validateObjectiveAnswers(sampleQuestions, { answers: { q1: 'A', q2: 'AB', q3: ['1'] } });
  } catch (err) {
    assert(/填空数量不匹配/.test(err.message), `错误信息不匹配：${err.message}`);
    return;
  }
  throw new Error('未抛错');
});

test('校验失败：缺 qid → 抛 ParseError；allowMissing 时只记录', () => {
  let threw = false;
  try {
    validateObjectiveAnswers(sampleQuestions, { answers: { q1: 'A', q2: 'AB' } });
  } catch (err) {
    threw = /缺少/.test(err.message);
  }
  assert(threw, '应因缺答案抛错');
  const r = validateObjectiveAnswers(sampleQuestions, { answers: { q1: 'A', q2: 'AB' } }, { allowMissing: true });
  assert(r.missing.length === 1, 'allowMissing 应记录缺失');
});

test('判断题：学习通 true/false 键 + 自然语言答案归一化', () => {
  // 学习通判断题真实结构：opts.key = true/false，文本 对/错
  const judgeQuestions = [
    { qid: 'j1', type: 'judge', stem: '示例判断1', opts: [{ key: 'true', text: '对' }, { key: 'false', text: '错' }] },
    { qid: 'j2', type: 'judge', stem: '示例判断2', opts: [{ key: 'true', text: '对' }, { key: 'false', text: '错' }] },
    { qid: 'j3', type: 'judge', stem: '示例判断3', opts: [{ key: 'true', text: '对' }, { key: 'false', text: '错' }] },
    { qid: 'j4', type: 'judge', stem: '示例判断4', opts: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }] },
    { qid: 'j5', type: 'judge', stem: '示例判断5', opts: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }] },
  ];
  const parsed = {
    answers: { j1: 'true', j2: false, j3: '对', j4: 'true', j5: 'B' },
    sources: [],
    needMaterials: [],
    confidence: 0.9,
  };
  const r = validateObjectiveAnswers(judgeQuestions, parsed);
  assert(r.answers.j1 === 'true', `j1=${r.answers.j1}`);
  assert(r.answers.j2 === 'false', `j2=${r.answers.j2}`);
  assert(r.answers.j3 === 'true', `j3=${r.answers.j3}`);
  assert(r.answers.j4 === 'A', `j4=${r.answers.j4}`); // true → A（"正确"）
  assert(r.answers.j5 === 'B', `j5=${r.answers.j5}`);
});

/* ===== ⑥ 凭据管理 ===== */
/* ===== 提示词构造 ===== */
console.log('\n[2/9] 提示词：联网检索 / 严格 JSON / 禁工具 / 模板原文');
test('客观题提示词：含 web_search 要求、严格 JSON、禁 shell·写文件、字段齐全', () => {
  const prompt = buildObjectivePrompt({
    work: { name: '自测作业' },
    questions: sampleQuestions,
  });
  assert(prompt.includes('web_search'), '缺少 web_search 要求');
  assert(prompt.includes('```json'), '缺少 ```json 输出要求');
  assert(/禁止调用\s*shell|禁止调用 shell/.test(prompt), '缺少禁止 shell 的约束');
  assert(prompt.includes('不要尝试写文件'), '缺少禁止写文件的约束');
  for (const key of ['answers', 'sources', 'needMaterials', 'confidence']) {
    assert(prompt.includes(`"${key}"`) || prompt.includes(key), `缺少字段 ${key}`);
  }
  assert(prompt.includes('q1') && prompt.includes('q2') && prompt.includes('q3'), '题目 qid 未进入提示词');
  assert(/type=multi/.test(prompt) && /升序/.test(prompt), '多选规则缺失');
  assert(/type=blank/.test(prompt) && /数组/.test(prompt), '填空规则缺失');
});

test('附件作业提示词：注入模板章节行 + 模板原文节选 + 字段齐全', () => {
  const templateText = fs.existsSync(TEMPLATE) ? docxToText(TEMPLATE).slice(0, 4000) : '模板原文占位';
  const prompt = buildSubmissionPrompt({
    work: { name: '第6次作业 函数调用' },
    questions: [{ qid: 'd1', type: 'short', stem: '习题三：编写求和函数。' }],
    materials: '课程：C 语言程序设计。',
    templateOutline: ['课本习题三', '课本习题四：13、15'],
    templateText,
  });
  assert(prompt.includes('模板原文节选'), '缺少模板原文节选段');
  assert(prompt.includes('课本习题三'), '模板章节行未注入');
  assert(prompt.includes('课本习题四：13、15'), '模板章节行未注入（四）');
  for (const key of ['"title"', '"content"', '"sources"', '"needMaterials"']) {
    assert(prompt.includes(key), `输出 schema 缺少 ${key}`);
  }
  assert(prompt.includes('web_search'), '缺少联网检索要求');
  assert(prompt.includes('禁止调用'), '缺少禁工具约束');
});

test('简答提示词：字段 content/sources/needMaterials + 禁工具', () => {
  const prompt = buildShortAnswerPrompt({
    work: { name: '自测作业' },
    question: { qid: 's1', type: 'short', stem: '简述指针与数组的关系。' },
  });
  assert(prompt.includes('"content"'), '缺少 content 字段');
  assert(prompt.includes('sources') && prompt.includes('needMaterials'), '缺少 sources/needMaterials');
  assert(prompt.includes('web_search'), '缺少联网检索要求');
  assert(prompt.includes('禁止调用'), '缺少禁工具约束');
  assert(prompt.includes('指针与数组'), '题干未进入提示词');
});

test('超长题目按字符预算截断（<= 24000）', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    qid: `q${i}`,
    type: 'single',
    stem: `题干${i}：` + '很长的题干文字'.repeat(200),
    opts: [
      { key: 'A', text: '选项甲' },
      { key: 'B', text: '选项乙' },
    ],
  }));
  const prompt = buildObjectivePrompt({ questions: many, maxChars: 24_000 });
  assert(prompt.length <= 24_500, `提示词过长：${prompt.length}`);
  assert(prompt.includes('q59'), '截断后丢失题目');
});

console.log('\n[3/9] 循环保护（mock CLI）：step 超限 / 无产出卡死');
async function runMockCli(scriptBody, { pollMs = 100, idleTimeoutMs = 90_000 } = {}) {
  const scriptPath = path.join(TMP, `mock-${crypto.randomBytes(4).toString('hex')}.mjs`);
  fs.writeFileSync(scriptPath, scriptBody, 'utf8');
  const dshHome = path.join(TMP, 'mock-home');
  fs.mkdirSync(dshHome, { recursive: true });
  const dshBin = path.resolve(scriptPath);
  return runHeadless({
    prompt: 'mock',
    cwd: path.join(TMP, 'mock-cwd'),
    dshHome,
    dshBin,
    timeoutMs: 30_000,
    pollMs,
    idleTimeoutMs,
    retry: false,
    log: () => {},
  });
}

await testAsync('step 数超过 60 → LOOP_DETECTED 且杀进程', async () => {
  const script = [
    'const lines = [];',
    "for (let i = 1; i <= 65; i++) lines.push(JSON.stringify({ type: 'status', phase: 'step_start', turn: 1, step: i }));",
    "lines.push(JSON.stringify({ type: 'thinking', text: 'searching...' }));",
    "process.stdout.write(lines.join('\\n') + '\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const r = await runMockCli(script, { pollMs: 100 });
  assert(r.loopDetected === true, `应判定为循环，实际 loopDetected=${r.loopDetected}`);
  assert(r.ok === false, '循环时 ok 必须为 false');
  assert(r.stepCount > 60, `stepCount=${r.stepCount}`);
  assert((r.loopReason || '').includes('step'), `loopReason=${r.loopReason}`);
  console.log(`    · stepCount=${r.stepCount} reason=${r.loopReason} latency=${r.latencyMs}ms`);
});

await testAsync('连续无 text/thinking 产出超阈值 → LOOP_DETECTED', async () => {
  const script = [
    "process.stdout.write(JSON.stringify({ type: 'status', phase: 'step_start', turn: 1, step: 1 }) + '\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const r = await runMockCli(script, { pollMs: 100, idleTimeoutMs: 1200 });
  assert(r.loopDetected === true, `应判定为卡死，实际 loopDetected=${r.loopDetected}`);
  assert((r.loopReason || '').includes('没有 text/thinking'), `loopReason=${r.loopReason}`);
  assert(r.ok === false, '卡死时 ok 必须为 false');
  console.log(`    · reason=${r.loopReason} latency=${r.latencyMs}ms`);
});

test('循环保护默认阈值已下降（README/联调约定）', () => {
  assert(DEFAULT_MAX_STEPS === 60, `DEFAULT_MAX_STEPS=${DEFAULT_MAX_STEPS}`);
  assert(DEFAULT_MAX_TOOL_CALLS === 60, `DEFAULT_MAX_TOOL_CALLS=${DEFAULT_MAX_TOOL_CALLS}`);
  assert(DEFAULT_IDLE_TIMEOUT_MS === 90_000, `DEFAULT_IDLE_TIMEOUT_MS=${DEFAULT_IDLE_TIMEOUT_MS}`);
  assert(DEFAULT_TIMEOUT_MS === 300_000, `DEFAULT_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS}`);
});

await testAsync('engine 层把循环映射为 error.code=LOOP_DETECTED', async () => {
  const script = [
    'const lines = [];',
    "for (let i = 1; i <= 65; i++) lines.push(JSON.stringify({ type: 'status', phase: 'step_start', turn: 1, step: i }));",
    "process.stdout.write(lines.join('\\n') + '\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const scriptPath = path.join(TMP, `mock-engine-${crypto.randomBytes(4).toString('hex')}.mjs`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  const mockHome = path.join(TMP, 'mock-engine-home');
  fs.mkdirSync(mockHome, { recursive: true });
  const mockEngine = createEngine({
    dshHome: mockHome,
    dshBin: path.resolve(scriptPath),
    workRoot: path.join(TMP, 'mock-engine-work'),
    pollMs: 100,
    timeoutMs: 30_000,
    log: () => {},
  });
  const result = await mockEngine.solveObjective({
    work: { name: 'mock-loop' },
    questions: [{ qid: 'x1', type: 'single', stem: 'mock', opts: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }] }],
    cwd: path.join(TMP, 'mock-engine-cwd'),
  });
  assert(result.ok === false, '循环时应 ok:false');
  assert(result.error.code === 'LOOP_DETECTED', `error.code=${result.error.code}`);
  console.log(`    · code=${result.error.code} message=${result.error.message} stepCount=${result.error.detail.stepCount}`);
});

console.log('\n[4/9] 分片求解 + DSH .cmd 入口防御（mock CLI）');

/** 生成一个「按 prompt 里的 qid 全部答 A」的 mock CLI */
function makeAnswerMockScript({ promptLenFile = null, counterFile = null, failInvocations = [] } = {}) {
  const lines = [
    "import fs from 'node:fs';",
    'const argv = process.argv.slice(2);',
    'const last = argv[argv.length - 1];',
    "let prompt = last === '-' ? fs.readFileSync(0, 'utf8') : String(last || '');",
    promptLenFile ? `fs.appendFileSync(${JSON.stringify(promptLenFile)}, prompt.length + '\\n');` : '',
    counterFile
      ? [
          `const counterFile = ${JSON.stringify(counterFile)};`,
          "let n = 0;",
          "try { n = Number(fs.readFileSync(counterFile, 'utf8')) || 0; } catch {}",
          'n += 1;',
          `fs.writeFileSync(counterFile, String(n));`,
          failInvocations.length ? `if (${JSON.stringify(failInvocations)}.includes(n)) { process.stderr.write('mock batch failure n=' + n + '\\n'); process.exit(1); }` : '',
        ].join('\n')
      : '',
    'const qids = [...prompt.matchAll(/"qid":\\s*"([^"]+)"/g)].map((m) => m[1]);',
    'const answers = {};',
    "for (const q of qids) answers[q] = 'A';",
    "const text = '```json\\n' + JSON.stringify({ answers, sources: [{ title: 'mock', url: 'https://example.com/mock' }], needMaterials: [], confidence: 0.9 }) + '\\n```';",
    'const emit = (o) => process.stdout.write(JSON.stringify(o) + \'\\n\');',
    "emit({ type: 'session', sessionId: 'mock' });",
    "emit({ type: 'status', phase: 'turn_start', turn: 1 });",
    "emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });",
    "emit({ type: 'thinking', text: 'mock' });",
    'emit({ type: \'text\', text });',
    'emit({ type: \'final\', text });',
  ].filter(Boolean);
  return lines.join('\n');
}

/** 生成「多题成批时拒绝/乱输出，单题时正常作答；检索任务单独处理」的 mock（测拆单题+检索兜底） */
function makeSplitMockScript({
  mode = 'refuse',
  permanentRefuseQids = [],
  searchFailQids = [],
  searchRefuseQids = [],
} = {}) {
  const answerText =
    "'```json\\n' + JSON.stringify({ answers, sources: [{ title: 'mock', url: 'https://example.com/split' }], needMaterials: [], confidence: 0.9 }) + '\\n```'";
  const lines = [
    "import fs from 'node:fs';",
    'const argv = process.argv.slice(2);',
    'const last = argv[argv.length - 1];',
    "let prompt = last === '-' ? fs.readFileSync(0, 'utf8') : String(last || '');",
    'const qids = [...prompt.matchAll(/"qid":\\s*"([^"]+)"/g)].map((m) => m[1]);',
    `const mode = ${JSON.stringify(mode)};`,
    `const permanent = ${JSON.stringify(permanentRefuseQids)};`,
    `const searchFail = ${JSON.stringify(searchFailQids)};`,
    `const searchRefuse = ${JSON.stringify(searchRefuseQids)};`,
    "const isSearchTask = prompt.includes('【检索找答案任务】');",
    'if (isSearchTask) {',
    '  if (qids.some((q) => searchRefuse.includes(q))) {',
    "    process.stderr.write('dsh: MALFORMED_RESPONSE: DeepSeek Messages stream: unsupported stop reason refusal\\n');",
    '    process.exit(1);',
    '  }',
    '  if (qids.some((q) => searchFail.includes(q))) {',
    "    const text = '```json\\n' + JSON.stringify({ answers: {}, sources: [], needMaterials: ['未检索到该题标准答案'] }) + '\\n```';",
    "    process.stdout.write(JSON.stringify({ type: 'final', text }) + '\\n');",
    '    process.exit(0);',
    '  }',
    '} else {',
    "  const refused = qids.length > 1 || qids.some((q) => permanent.includes(q)) || mode === 'search' || mode === 'searchfail';",
    '  if (refused) {',
    "    if (mode === 'refuse' || mode === 'search' || mode === 'searchfail') {",
    "      process.stderr.write('dsh: MALFORMED_RESPONSE: DeepSeek Messages stream: unsupported stop reason refusal\\n');",
    "      process.stderr.write('mock: 模型拒绝回答（测试用 refusal）\\n');",
    '      process.exit(1);',
    '    }',
    "    process.stdout.write(JSON.stringify({ type: 'final', text: 'mock-bad-json-output' }) + '\\n');",
    '    process.exit(0);',
    '  }',
    '}',
    'const answers = {};',
    "for (const q of qids) answers[q] = 'A';",
    `const text = ${answerText};`,
    "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "emit({ type: 'session', sessionId: 'mock' });",
    "emit({ type: 'status', phase: 'turn_start', turn: 1 });",
    "emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });",
    "emit({ type: 'thinking', text: 'mock' });",
    "emit({ type: 'text', text });",
    "emit({ type: 'final', text });",
  ];
  return lines.join('\n');
}

/** 生成「只有带备用模型 --patch 时才作答」的 mock（测主模型 refusal → 备用模型回退） */
function makeModelFallbackMockScript() {
  return [
    "import fs from 'node:fs';",
    'const argv = process.argv.slice(2);',
    'const last = argv[argv.length - 1];',
    "let prompt = last === '-' ? fs.readFileSync(0, 'utf8') : String(last || '');",
    'const qids = [...prompt.matchAll(/"qid":\\s*"([^"]+)"/g)].map((m) => m[1]);',
    "const isFallbackModel = process.argv.join(' ').includes('model-patch-fallback');",
    'if (!isFallbackModel) {',
    "  process.stderr.write('dsh: MALFORMED_RESPONSE: DeepSeek Messages stream: unsupported stop reason refusal\\n');",
    '  process.exit(1);',
    '}',
    'const answers = {};',
    "for (const q of qids) answers[q] = 'B';",
    "const text = '```json\\n' + JSON.stringify({ answers, sources: [{ title: 'mock-fallback', url: 'https://example.com/fallback' }], needMaterials: [], confidence: 0.8 }) + '\\n```';",
    "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "emit({ type: 'session', sessionId: 'mock' });",
    "emit({ type: 'status', phase: 'turn_start', turn: 1 });",
    "emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });",
    "emit({ type: 'thinking', text: 'mock' });",
    "emit({ type: 'text', text });",
    "emit({ type: 'final', text });",
  ].join('\n');
}

const mockDir = path.join(TMP, 'mock-batch');
fs.mkdirSync(mockDir, { recursive: true });
const promptLenFile = path.join(mockDir, 'prompt-len.txt');
const answerMockPath = path.join(mockDir, 'answer-mock.mjs');
fs.writeFileSync(answerMockPath, makeAnswerMockScript({ promptLenFile }), 'utf8');

test('resolveDshBin：传入 dsh.cmd 时自动改用同目录 lib/bin.js', () => {
  const fakeDir = path.join(mockDir, 'fake-cmd');
  const binJs = path.join(fakeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(binJs), { recursive: true });
  fs.copyFileSync(answerMockPath, binJs);
  const cmdPath = path.join(fakeDir, 'dsh.cmd');
  fs.writeFileSync(cmdPath, '@ECHO off\r\nnode "%~dp0node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n', 'utf8');
  const resolved = resolveDshBin({ dshBin: cmdPath, env: {} });
  assert(resolved.endsWith('bin.js'), `未解析到 bin.js：${resolved}`);
  assert(resolved === binJs, `解析结果不对：${resolved}`);
  console.log(`    · dsh.cmd → ${resolved}`);
});

await testAsync('runOnce：dsh.cmd 入参也能正常跑（绝不是 node dsh.cmd）', async () => {
  const fakeDir = path.join(mockDir, 'fake-cmd');
  const cmdPath = path.join(fakeDir, 'dsh.cmd');
  const home = path.join(mockDir, 'home-cmd');
  fs.mkdirSync(home, { recursive: true });
  const r = await runHeadless({
    prompt: '```json\n{"qid":"cmd1","type":"single"}\n```',
    cwd: path.join(mockDir, 'cwd-cmd'),
    dshHome: home,
    dshBin: cmdPath,
    timeoutMs: 20_000,
    pollMs: 50,
    retry: false,
    log: () => {},
  });
  assert(r.ok, `运行失败：${JSON.stringify({ code: r.code, stderr: r.stderr.slice(-400) })}`);
  assert(r.text.includes('cmd1'), `回复未包含 qid：${r.text.slice(0, 200)}`);
});

await testAsync('runOnce：.cmd 找不到 lib/bin.js → 明确报错，不用 node 执行 .cmd', async () => {
  const fakeDir = path.join(mockDir, 'fake-bad-cmd');
  fs.mkdirSync(fakeDir, { recursive: true });
  const cmdPath = path.join(fakeDir, 'dsh.cmd');
  fs.writeFileSync(cmdPath, '@ECHO off\r\n', 'utf8');
  let caught = null;
  try {
    await runHeadless({
      prompt: 'x',
      cwd: path.join(mockDir, 'cwd-bad'),
      dshHome: path.join(mockDir, 'home-cmd'),
      dshBin: cmdPath,
      timeoutMs: 8000,
      retry: false,
      log: () => {},
    });
  } catch (err) {
    caught = err;
  }
  assert(caught, '应抛出明确错误');
  assert(caught.code === 'DSH_BIN_IS_CMD', `error.code=${caught.code}`);
  assert(/lib[\\/]bin\.js/.test(caught.message), `错误信息未提示 bin.js：${caught.message}`);
});

function makeBatchQuestions(count) {
  return Array.from({ length: count }, (_, i) => ({
    qid: `bq${i}`,
    type: 'single',
    stem: `批量 mock 题 ${i}`,
    opts: [
      { key: 'A', text: '选项甲' },
      { key: 'B', text: '选项乙' },
    ],
  }));
}

await testAsync('solveObjective 自动分片：45 题按 20/批 → 3 批全部成功', async () => {
  fs.rmSync(promptLenFile, { force: true });
  const home = path.join(mockDir, 'home-batch');
  fs.mkdirSync(home, { recursive: true });
  const engine = createEngine({
    dshHome: home,
    dshBin: answerMockPath,
    workRoot: path.join(mockDir, 'work-batch'),
    pollMs: 50,
    timeoutMs: 60_000,
    log: () => {},
  });
  const events = [];
  const result = await engine.solveObjective({
    work: { name: 'mock-batch' },
    questions: makeBatchQuestions(45),
    cwd: path.join(mockDir, 'cwd-batch'),
    batchSize: 20,
    onEvent: (evt) => events.push(evt),
  });
  assert(result.ok === true, `应成功：${JSON.stringify(result.error || result).slice(0, 800)}`);
  assert(result.batches === 3, `batches=${result.batches}`);
  assert(Object.keys(result.answers).length === 45, `answers=${Object.keys(result.answers).length}`);
  assert(JSON.stringify(result.batchStats.map((b) => b.count)) === '[20,20,5]', `batchStats=${JSON.stringify(result.batchStats.map((b) => b.count))}`);
  const starts = events.filter((e) => e.type === 'batch' && e.phase === 'start');
  const dones = events.filter((e) => e.type === 'batch' && e.phase === 'done');
  assert(starts.length === 3 && dones.length === 3, `batch 事件数：start=${starts.length} done=${dones.length}`);
  assert(starts.every((e) => e.index >= 1 && e.total === 3 && typeof e.message === 'string'), 'batch 事件字段不完整');
  const lens = fs.readFileSync(promptLenFile, 'utf8').trim().split('\n').map(Number);
  assert(lens.length === 3 && lens.every((n) => n > 0 && n <= 30_000), `单批提示词长度：${JSON.stringify(lens)}`);
  console.log(`    · batches=${result.batches} answers=${Object.keys(result.answers).length} promptChars=${JSON.stringify(lens)} batchMs=${JSON.stringify(result.batchStats.map((b) => b.latencyMs))}`);
});

await testAsync('单批失败重试 1 次仍失败 → PARTIAL_ANSWERS 且保留已得答案', async () => {
  const counterFile = path.join(mockDir, 'partial-counter.txt');
  fs.rmSync(counterFile, { force: true });
  const partialMock = path.join(mockDir, 'partial-mock.mjs');
  // 第 2、3 次调用失败（= 第 2 批的两次尝试），第 1、4 次成功 → 批次 1/3 成功、批次 2 失败
  fs.writeFileSync(partialMock, makeAnswerMockScript({ counterFile, failInvocations: [2, 3] }), 'utf8');
  const home = path.join(mockDir, 'home-partial');
  fs.mkdirSync(home, { recursive: true });
  const engine = createEngine({
    dshHome: home,
    dshBin: partialMock,
    workRoot: path.join(mockDir, 'work-partial'),
    pollMs: 50,
    timeoutMs: 60_000,
    log: () => {},
  });
  const events = [];
  const result = await engine.solveObjective({
    work: { name: 'mock-partial' },
    questions: makeBatchQuestions(45),
    cwd: path.join(mockDir, 'cwd-partial'),
    batchSize: 20,
    batchRetries: 1,
    onEvent: (evt) => events.push(evt),
  });
  assert(result.ok === false, '部分失败应 ok:false');
  assert(result.error.code === 'PARTIAL_ANSWERS', `error.code=${result.error.code}`);
  assert(Object.keys(result.answers).length === 25, `已得答案应保留 25 题，实际 ${Object.keys(result.answers).length}`);
  assert(result.failedBatches.length === 1 && result.failedBatches[0].index === 2, `failedBatches=${JSON.stringify(result.failedBatches)}`);
  assert(result.missing.length === 20, `missing=${result.missing.length}`);
  assert(result.missing.includes('bq20') && result.missing.includes('bq39'), 'missing 应覆盖第 2 批');
  assert(result.answers.bq0 === 'A' && result.answers.bq40 === 'A', '批次 1/3 的答案丢失');
  const failedEvents = events.filter((e) => e.type === 'batch' && e.phase === 'failed');
  assert(failedEvents.length === 1 && failedEvents[0].index === 2, `failed 事件：${JSON.stringify(failedEvents)}`);
  console.log(`    · code=PARTIAL_ANSWERS answers=${Object.keys(result.answers).length} missing=${result.missing.length} failedBatches=${result.failedBatches.map((b) => b.index)}`);
});

await testAsync('批次 MODEL_REFUSED → 自动拆单题：恢复成功题、仍拒绝的进 missing', async () => {
  const splitMock = path.join(mockDir, 'split-refuse-mock.mjs');
  // 成批 >1 题时一律 refusal；单题时 bq2 仍拒绝，其余正常作答
  fs.writeFileSync(splitMock, makeSplitMockScript({ mode: 'refuse', permanentRefuseQids: ['bq2'] }), 'utf8');
  const home = path.join(mockDir, 'home-split-refuse');
  fs.mkdirSync(home, { recursive: true });
  const engine = createEngine({
    dshHome: home,
    dshBin: splitMock,
    workRoot: path.join(mockDir, 'work-split-refuse'),
    pollMs: 50,
    timeoutMs: 60_000,
    log: () => {},
  });
  const events = [];
  const result = await engine.solveObjective({
    work: { name: 'mock-split-refuse' },
    questions: makeBatchQuestions(6),
    cwd: path.join(mockDir, 'cwd-split-refuse'),
    batchSize: 5,
    batchRetries: 1,
    searchFallback: false, // 本用例只验证拆单题（检索兜底单独用例覆盖）
    onEvent: (evt) => events.push(evt),
  });
  assert(result.ok === false, '仍有拒绝题时 ok:false');
  assert(result.error.code === 'PARTIAL_ANSWERS', `error.code=${result.error.code}`);
  assert(Object.keys(result.answers).length === 5, `应恢复 5 题，实际 ${Object.keys(result.answers).length}`);
  assert(result.missing.length === 1 && result.missing[0] === 'bq2', `missing=${JSON.stringify(result.missing)}`);
  assert(result.failedBatches.length === 1, `failedBatches=${JSON.stringify(result.failedBatches)}`);
  assert(JSON.stringify(result.failedBatches[0].qids) === '["bq2"]', `failedBatches.qids=${JSON.stringify(result.failedBatches[0].qids)}`);
  assert(result.failedBatches[0].split === true, 'failedBatches 应标记 split=true');
  const splitEvents = events.filter((e) => e.type === 'batch' && e.phase === 'split');
  assert(splitEvents.length === 1 && splitEvents[0].splitCount === 5, `split 事件=${JSON.stringify(splitEvents)}`);
  const splitStat = result.batchStats[0];
  assert(splitStat.split === true, 'batchStats[0] 应标记 split');
  assert(splitStat.splitStats.recovered === 4 && splitStat.splitStats.stillFailed === 1, `splitStats=${JSON.stringify(splitStat.splitStats)}`);
  assert(result.batchStats[1].ok === true, '第 2 批（单题）应成功');
  console.log(`    · answers=${Object.keys(result.answers).length} missing=${JSON.stringify(result.missing)} splitRecovered=${splitStat.splitStats.recovered} stillFailed=${splitStat.splitStats.stillFailed}`);
});

await testAsync('批次 BAD_MODEL_OUTPUT → 自动拆单题，全部恢复后 ok:true', async () => {
  const badJsonMock = path.join(mockDir, 'split-badjson-mock.mjs');
  fs.writeFileSync(badJsonMock, makeSplitMockScript({ mode: 'badjson' }), 'utf8');
  const home = path.join(mockDir, 'home-split-badjson');
  fs.mkdirSync(home, { recursive: true });
  const engine = createEngine({
    dshHome: home,
    dshBin: badJsonMock,
    workRoot: path.join(mockDir, 'work-split-badjson'),
    pollMs: 50,
    timeoutMs: 60_000,
    log: () => {},
  });
  const events = [];
  const result = await engine.solveObjective({
    work: { name: 'mock-split-badjson' },
    questions: makeBatchQuestions(6),
    cwd: path.join(mockDir, 'cwd-split-badjson'),
    batchSize: 5,
    batchRetries: 1,
    onEvent: (evt) => events.push(evt),
  });
  assert(result.ok === true, `拆单题后应全部成功：${JSON.stringify(result.error || {}).slice(0, 600)}`);
  assert(Object.keys(result.answers).length === 6, `answers=${Object.keys(result.answers).length}`);
  assert(result.batchStats[0].split === true && result.batchStats[0].splitStats.recovered === 5, `batchStats0=${JSON.stringify(result.batchStats[0])}`);
  const splitEvents = events.filter((e) => e.type === 'batch' && e.phase === 'split');
  assert(splitEvents.length === 1 && splitEvents[0].reason === 'BAD_MODEL_OUTPUT', `split 事件=${JSON.stringify(splitEvents)}`);
  console.log(`    · answers=6 splitRecovered=5 batches=${result.batches}`);
});

await testAsync('检索兜底：拆单题仍被 refusal → 联网检索找到答案（全部恢复 ok:true）', async () => {
  const searchMock = path.join(mockDir, 'search-ok-mock.mjs');
  // 非检索任务一律 refusal；检索任务（提示词含【检索找答案任务】）返回答案
  fs.writeFileSync(searchMock, makeSplitMockScript({ mode: 'search' }), 'utf8');
  const home = path.join(mockDir, 'home-search-ok');
  fs.mkdirSync(home, { recursive: true });
  const engine = createEngine({
    dshHome: home,
    dshBin: searchMock,
    workRoot: path.join(mockDir, 'work-search-ok'),
    pollMs: 50,
    timeoutMs: 60_000,
    log: () => {},
  });
  const events = [];
  const result = await engine.solveObjective({
    work: { name: 'mock-search-ok' },
    questions: makeBatchQuestions(6),
    cwd: path.join(mockDir, 'cwd-search-ok'),
    batchSize: 5,
    batchRetries: 1,
    onEvent: (evt) => events.push(evt),
  });
  assert(result.ok === true, `检索兜底后应成功：${JSON.stringify(result.error || {}).slice(0, 800)}`);
  assert(Object.keys(result.answers).length === 6, `answers=${Object.keys(result.answers).length}`);
  assert(result.originCounts.search === 6, `originCounts=${JSON.stringify(result.originCounts)}`);
  assert(result.searchFallback.attempted === 6 && result.searchFallback.recovered === 6, `searchFallback=${JSON.stringify(result.searchFallback)}`);
  const searchEvents = events.filter((e) => e.type === 'batch' && e.phase === 'search');
  assert(searchEvents.length === 6 && searchEvents.every((e) => typeof e.qid === 'string'), `search 事件=${JSON.stringify(searchEvents)}`);
  console.log(`    · answers=6 originCounts=${JSON.stringify(result.originCounts)} searchAttempted=${result.searchFallback.attempted}`);
});

await testAsync('检索兜底也失败：区分 searchFailedQids 与 refusedQids，其余答案保留', async () => {
  const searchFailMock = path.join(mockDir, 'search-fail-mock.mjs');
  // 非检索任务 refusal；检索任务里 bq2 返回"没找到"，bq3 仍被 refusal，其余返回答案
  fs.writeFileSync(
    searchFailMock,
    makeSplitMockScript({ mode: 'search', searchFailQids: ['bq2'], searchRefuseQids: ['bq3'] }),
    'utf8'
  );
  const home = path.join(mockDir, 'home-search-fail');
  fs.mkdirSync(home, { recursive: true });
  const engine = createEngine({
    dshHome: home,
    dshBin: searchFailMock,
    workRoot: path.join(mockDir, 'work-search-fail'),
    pollMs: 50,
    timeoutMs: 60_000,
    log: () => {},
  });
  const result = await engine.solveObjective({
    work: { name: 'mock-search-fail' },
    questions: makeBatchQuestions(6),
    cwd: path.join(mockDir, 'cwd-search-fail'),
    batchSize: 5,
    batchRetries: 1,
    onEvent: () => {},
  });
  assert(result.ok === false, '仍有未解题时应 ok:false');
  assert(result.error.code === 'PARTIAL_ANSWERS', `error.code=${result.error.code}`);
  assert(Object.keys(result.answers).length === 4, `answers=${Object.keys(result.answers).length}（应保留 4 题）`);
  assert(result.missing.length === 2 && result.missing.includes('bq2') && result.missing.includes('bq3'), `missing=${JSON.stringify(result.missing)}`);
  assert(JSON.stringify(result.error.detail.searchFailedQids) === '["bq2"]', `searchFailedQids=${JSON.stringify(result.error.detail.searchFailedQids)}`);
  assert(JSON.stringify(result.error.detail.refusedQids) === '["bq3"]', `refusedQids=${JSON.stringify(result.error.detail.refusedQids)}`);
  console.log(`    · answers=4 missing=${JSON.stringify(result.missing)} searchFailed=${JSON.stringify(result.error.detail.searchFailedQids)} refused=${JSON.stringify(result.error.detail.refusedQids)}`);
});

await testAsync('备用模型回退：主模型 refusal → 换用 fallbackModels 答出（默认关闭）', async () => {
  const fbMock = path.join(mockDir, 'model-fallback-mock.mjs');
  fs.writeFileSync(fbMock, makeModelFallbackMockScript(), 'utf8');
  const home = path.join(mockDir, 'home-model-fallback');
  fs.mkdirSync(home, { recursive: true });
  const engine = createEngine({
    dshHome: home,
    dshBin: fbMock,
    workRoot: path.join(mockDir, 'work-model-fallback'),
    pollMs: 50,
    timeoutMs: 60_000,
    // 备用模型：仅在显式配置时启用
    fallbackModels: [{ provider: 'deepseek-official', model: 'mock-alt-model' }],
    log: () => {},
  });
  assert(engine.fallbackModels.length === 1 && engine.fallbackModels[0].model === 'mock-alt-model', 'fallbackModels 未生效');
  const events = [];
  const result = await engine.solveObjective({
    work: { name: 'mock-model-fallback' },
    questions: makeBatchQuestions(2),
    cwd: path.join(mockDir, 'cwd-model-fallback'),
    batchSize: 2,
    splitOnFailure: false,
    searchFallback: false,
    onEvent: (evt) => events.push(evt),
  });
  assert(result.ok === true, `备用模型回退后应成功：${JSON.stringify(result.error || {}).slice(0, 800)}`);
  assert(Object.keys(result.answers).length === 2, `answers=${Object.keys(result.answers).length}`);
  assert(result.answers.bq0 === 'B' && result.answers.bq1 === 'B', `answers=${JSON.stringify(result.answers)}`);
  assert(result.originCounts.modelFallback === 2, `originCounts=${JSON.stringify(result.originCounts)}`);
  assert(result.modelFallback.recovered === 2 && result.modelFallback.attempted === 2, `modelFallback=${JSON.stringify(result.modelFallback)}`);
  const fbEvents = events.filter((e) => e.type === 'batch' && e.phase === 'model-fallback');
  assert(fbEvents.length === 2 && fbEvents.every((e) => e.model === 'deepseek-official/mock-alt-model'), `model-fallback 事件=${JSON.stringify(fbEvents)}`);
  // 未配置 fallbackModels 时应为空（默认关闭）
  const plain = createEngine({ dshHome: home, dshBin: fbMock, workRoot: path.join(mockDir, 'work-model-fallback-plain'), log: () => {} });
  assert(plain.fallbackModels.length === 0, '默认不应启用备用模型');
  console.log(`    · answers=2 originCounts=${JSON.stringify(result.originCounts)} usedModels=${JSON.stringify(result.modelFallback.usedModels)}`);
});

console.log('\n[5/9] 凭据：ensureHome 原子写 + readKeyRef');test('非法 key 被拒绝', () => {
  const home = path.join(TMP, 'home-badkey');
  let threw = false;
  try {
    credentials.ensureHome({ dshHome: home, apiKey: 'not-a-key' });
  } catch (err) {
    threw = /合法/.test(err.message);
  }
  assert(threw, '应拒绝非法 key');
  assert(!fs.existsSync(path.join(home, '.credentials.yaml')), '非法 key 不应写文件');
});

test('ensureHome 写入 version:1 / refs / records，readKeyRef 只返回是否配置', () => {
  const home = path.join(TMP, 'home-fake');
  const fakeKey = `sk-selftest-${crypto.randomBytes(16).toString('hex')}`;
  const r = credentials.ensureHome({ dshHome: home, apiKey: fakeKey });
  assert(r.ok && r.configured, '应配置成功');
  const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  assert(/^version: 1$/m.test(text), '缺少 version: 1');
  assert(/^refs:$/m.test(text), '缺少 refs');
  assert(/^ {2}DEEPSEEK_API_KEY: sk-/m.test(text), '缺少 refs.DEEPSEEK_API_KEY');
  assert(/^records:/m.test(text), '缺少 records');
  assert(!text.includes('\n\n\n'), '不应有多余空行');
  const status = credentials.readKeyRef(home);
  assert(status.configured === true, 'readKeyRef 应为 configured');
  assert(JSON.stringify(status).includes('sk-selftest') === false, 'readKeyRef 不得返回 Key 值');
  assert(status.refNames.length === 1 && status.refNames[0] === 'DEEPSEEK_API_KEY', 'refNames 不对');
  // 幂等：再调一次不破坏
  const before = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  credentials.ensureHome({ dshHome: home });
  assert(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8') === before, '无 key 时不应改写文件');
});

test('保留已有 records（模拟已有登录态）', () => {
  const home = path.join(TMP, 'home-merge');
  fs.mkdirSync(home, { recursive: true });
  const seed = `version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\nrefs:\n  OTHER_TOKEN: abc123\n`;
  fs.writeFileSync(path.join(home, '.credentials.yaml'), seed, 'utf8');
  credentials.ensureHome({ dshHome: home, apiKey: 'sk-merge-0123456789abcdefgh' });
  const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  assert(/client-connection\/browser-session/.test(text), 'records 丢失');
  assert(/OTHER_TOKEN: abc123/.test(text), '已有 refs 丢失');
  assert(/DEEPSEEK_API_KEY: sk-merge-/.test(text), '新 key 未写入');
});

test('ensureHome 同时写入 headless 隐私补丁（session-log / telemetry 双禁用）', () => {
  const home = path.join(TMP, 'home-privacy');
  const fakeKey = `sk-privacy-${crypto.randomBytes(16).toString('hex')}`;
  const r = credentials.ensureHome({ dshHome: home, apiKey: fakeKey });
  assert(r.privacy && r.privacy.privacyComplete, '隐私补丁不完整');
  const profileDir = path.join(home, 'profiles', 'headless');
  for (const f of ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    assert(fs.existsSync(path.join(profileDir, f)), `缺少 profile 文件：${f}`);
  }
  const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert(/- id: session-log-deepseek/.test(patch), '缺少 session-log-deepseek 行');
  assert(/- id: session-log-deepseek[\s\S]{0,120}?enabled: false/.test(patch), 'session-log-deepseek 未关闭');
  assert(/- id: session-telemetry-otel/.test(patch), '缺少 session-telemetry-otel 行');
  assert(/- id: session-telemetry-otel[\s\S]{0,120}?mode: DISABLED/.test(patch), 'telemetry 未 DISABLED');
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert(
    JSON.stringify(manifest.dsh.profile.bundles) ===
      JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']),
    'bundle 列表与官方模板不一致'
  );
  const status = credentials.ensureHome({ dshHome: home }).privacy;
  assert(status.privacyComplete === true, '重复调用后隐私补丁状态异常');
  // 幂等：再调一次 patch 文本不变
  const before = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  credentials.ensureHome({ dshHome: home });
  assert(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8') === before, '隐私补丁应幂等');
});

test('已有用户层 patch 时：只追加受管块，不破坏原配置', () => {
  const home = path.join(TMP, 'home-patch-merge');
  fs.mkdirSync(path.join(home, 'profiles', 'headless'), { recursive: true });
  const userPatch = `# 用户自己的设置\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n`;
  fs.writeFileSync(path.join(home, 'profiles', 'headless', 'cordis.patch.yml'), userPatch, 'utf8');
  credentials.ensureHome({ dshHome: home, apiKey: `sk-merge2-${crypto.randomBytes(16).toString('hex')}` });
  const patch = fs.readFileSync(path.join(home, 'profiles', 'headless', 'cordis.patch.yml'), 'utf8');
  assert(patch.includes('用户自己的设置'), '用户层配置被删除');
  assert(patch.includes('- id: agent-default-model'), '用户层模型配置被删除');
  assert(/- id: session-log-deepseek/.test(patch), '未追加隐私补丁');
  // 受管块只能出现一次
  assert(patch.split('- id: session-log-deepseek').length - 1 === 1, '受管块重复写入');
  // 两个模型 row 并存时后写的受管块生效，不报错
  const status = privacyModule.readPrivacyStatus(home);
  assert(status.privacyComplete, '隐私补丁状态不完整');
});

/* ===== ③ docgen 往返 + Python 校验 ===== */
console.log('\n[6/9] docgen：newDocx → docxToText 往返 + python-docx 校验');
let roundtripPath = null;
test('newDocx 生成并读回', () => {
  const outPath = path.join(OUT, 'selftest-new.docx');
  newDocx({
    title: '自测文档标题',
    blocks: [
      { type: 'h1', text: '一、选择题' },
      { type: 'p', text: '1. Node.js 事件循环属于哪种模型？\n答案：A' },
      { type: 'p', text: '**加粗片段** 与 `code` 片段' },
      { type: 'table', rows: [['题号', '答案'], ['1', 'A'], ['2', 'ABD']] },
    ],
    outPath,
  });
  const parsed = parseDocx(outPath);
  assert(parsed.paragraphs.length >= 4, `段落数偏少：${parsed.paragraphs.length}`);
  assert(parsed.tables.length === 1, '表格数应为 1');
  const text = docxToText(outPath);
  assert(text.includes('自测文档标题'), '标题未读回');
  assert(text.includes('一、选择题'), '一级标题未读回');
  assert(text.includes('答案：A'), '段落未读回');
  assert(text.includes('加粗片段'), '行内加粗文字未读回');
  assert(parsed.tables[0].rows[2][1] === 'ABD', '表格内容未读回');
  roundtripPath = outPath;
});

/* ===== ④ 真实模板填充 ===== */
console.log('\n[7/9] 真实模板：fillDocxTemplate（占位符替换 + 锚点插入 + 兜底追加）');
let filledPath = null;
test('模板存在且可解析（18 段 + 1 表格）', () => {
  assert(fs.existsSync(TEMPLATE), `模板不存在：${TEMPLATE}`);
  const parsed = parseDocx(TEMPLATE);
  assert(parsed.paragraphs.length === 18, `期望 18 段，实际 ${parsed.paragraphs.length}`);
  assert(parsed.tables.length === 1 && parsed.tables[0].rows.length === 6, '表格应为 6 行');
  assert(parsed.paragraphs[9].text.includes('第6次作业'), '第 10 段文字不符');
});

test('fillDocxTemplate 填充真实模板并读回校验', () => {
  const outPath = path.join(OUT, 'selftest-第6次作业-filled.docx');
  filledPath = outPath;
  const result = fillDocxTemplate(
    TEMPLATE,
    [
      { find: '第6次作业 函数调用', replace: '第6次作业 函数调用（自测填充）' },
      {
        after: { text: '课本习题三' },
        insert: [
          { type: 'h3', text: '三、习题解答（自测）' },
          { type: 'p', text: '3.1 自测答案：输出 1 到 10 的和为 55。' },
          { type: 'table', rows: [['题目', '答案'], ['3.1', '55']] },
        ],
      },
      {
        after: { text: '课本习题四' },
        insert: [{ type: 'p', text: '四.13 自测答案：使用递归实现阶乘。' }],
      },
      { after: { text: '此锚点必然不存在' }, insert: [{ type: 'p', text: '兜底追加内容 OK-FALLBACK' }] },
    ],
    outPath
  );
  assert(fs.existsSync(outPath), '输出文件未生成');
  const text = docxToText(outPath);
  // 模板原文保留
  assert(text.includes('广州南方学院工学院'), '模板原文丢失');
  assert(text.includes('学生自检表'), '模板原文丢失（学生自检表）');
  assert(text.includes('第6次作业 函数调用（自测填充）'), '占位符/文字替换未生效');
  assert(text.includes('自测答案'), '锚点插入内容未找到');
  assert(text.includes('输出 1 到 10 的和为 55'), '插入段落内容未找到');
  assert(text.includes('OK-FALLBACK'), '兜底追加内容未找到');
  assert(text.includes('四.13 自测答案'), '第二个锚点插入失败');
  assert(result.warnings.some((w) => w.includes('此锚点必然不存在')), '应记录锚点未找到 warning');
  const parsedFilled = parseDocx(outPath);
  assert(parsedFilled.tables.length === 2, `期望 2 个表格（模板 1 + 插入 1），实际 ${parsedFilled.tables.length}`);
  assert(parsedFilled.paragraphs.length > 18, '插入后段落数应增加');
});

test('buildTemplateOps：Markdown 标题 → 模板段落锚点', () => {
  const templateParsed = parseDocx(TEMPLATE);
  const markdown = [
    '# 第6次作业 函数调用',
    '',
    '## 习题三 编写函数求 1 到 n 的和',
    '',
    '三的答案内容：使用循环累加。',
    '',
    '## 四.13 递归计算阶乘',
    '',
    '十三的答案内容。',
    '',
    '## 四.15 判断素数',
    '',
    '十五的答案内容。',
  ].join('\n');
  const blocks = markdownToBlocks(markdown).slice(1); // 去掉与文档标题重复的一级标题（与 index.mjs 行为一致）
  const { ops, unmatched, matchedAnchors } = buildTemplateOps(templateParsed, blocks, {
    excludeAnchors: ['第6次作业 函数调用', '学生自检表'],
  });
  assert(matchedAnchors.includes('课本习题三'), `未匹配到课本习题三：${JSON.stringify(matchedAnchors)}`);
  assert(
    matchedAnchors.some((a) => a.startsWith('课本习题四')),
    `四.13/四.15 未匹配到课本习题四：${JSON.stringify(matchedAnchors)}`
  );
  assert(ops.length >= 2, `ops 数量不足：${ops.length}`);
  const insertedText = JSON.stringify(ops.map((o) => (o.insert || []).map((b) => b.text)));
  assert(insertedText.includes('三的答案内容'), '习题三正文未归入对应 op');
  assert(insertedText.includes('十三的答案内容'), '四.13 正文未归入对应 op');
  assert(insertedText.includes('十五的答案内容'), '四.15 正文未归入对应 op');
  assert(unmatched.length === 0, `不应有未匹配块：${JSON.stringify(unmatched.map((b) => b.text))}`);
});

test('同一锚点多次插入保持内容顺序（不被反向插入）', () => {
  const outPath = path.join(OUT, 'selftest-order.docx');
  const r = fillDocxTemplate(
    TEMPLATE,
    [
      { after: { text: '课本习题三' }, insert: [{ type: 'p', text: 'ORDER-FIRST-111' }] },
      { after: { text: '课本习题三' }, insert: [{ type: 'p', text: 'ORDER-SECOND-222' }] },
      { after: { text: '课本习题三' }, insert: [{ type: 'p', text: 'ORDER-THIRD-333' }] },
    ],
    outPath
  );
  const text = r.docxText;
  const i1 = text.indexOf('ORDER-FIRST-111');
  const i2 = text.indexOf('ORDER-SECOND-222');
  const i3 = text.indexOf('ORDER-THIRD-333');
  assert(i1 >= 0 && i2 > i1 && i3 > i2, `插入顺序错误：${i1},${i2},${i3}`);
});

/* python-docx 校验（系统 python 可用时；产品运行时不依赖它） */
async function pythonVerify() {
  const py = `import json, sys
import docx

items = json.loads(sys.argv[1])
out = {}
for key, p in items.items():
    d = docx.Document(p)
    out[key] = {
        "paragraphs": len(d.paragraphs),
        "tables": len(d.tables),
        "texts": [x.text for x in d.paragraphs],
        "table_rows": [[c.text for c in r.cells] for t in d.tables for r in t.rows],
    }
print(json.dumps(out, ensure_ascii=False))
`;
  const scriptPath = path.join(TMP, 'py_verify.py');
  fs.writeFileSync(scriptPath, py, 'utf8');
  const payload = JSON.stringify({ new: roundtripPath, filled: filledPath });
  const r = await spawnCapture('python', [scriptPath, payload], { cwd: TMP, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`python 执行失败（code=${r.code}）：${(r.stderr || '').slice(0, 500)}`);
  return JSON.parse(r.stdout.trim());
}

console.log('\n[8/9] python-docx 独立校验（系统 python 3.12 + python-docx）');
let pyResult = null;
await testAsync('python -c "import docx" 读回两个生成的 docx', async () => {
  pyResult = await pythonVerify();
  const filler = pyResult.filled;
  assert(filler.paragraphs >= 19, `python 读到段落数 ${filler.paragraphs} 偏少`);
  assert(filler.tables === 2, `python 读到表格数 ${filler.tables}，应为 2`);
  const joined = filler.texts.join('\n');
  assert(joined.includes('自测答案'), 'python 未读到插入文本');
  assert(joined.includes('OK-FALLBACK'), 'python 未读到兜底文本');
  assert(joined.includes('广州南方学院工学院'), 'python 未读到模板原文');
  assert(pyResult.new.paragraphs >= 4, 'python 读 newDocx 段落数偏少');
  assert(pyResult.new.table_rows.some((row) => row.includes('ABD')), 'python 未读到 newDocx 表格内容');
});

/* ===== ①② 真实 headless ===== */
console.log('\n[9/9] 真实 headless（DSH CLI）');
const engineDirReal = path.join(TMP, 'home-real');
const probeKey = readProbeKeyInMemory();
let realHome = null;
let realHomeSource = null;

if (offline) {
  console.log('  已指定 --offline：跳过真实 headless 调用');
} else {
  // 优先：用 ensureHome 自建 DSH_HOME（Key 只在内存中传递，不打印）
  if (probeKey.key) {
    await testAsync('ensureHome 用真实 Key 自建测试 DSH_HOME（不打印 Key）', async () => {
      const r = credentials.ensureHome({ dshHome: engineDirReal, apiKey: probeKey.key });
      assert(r.ok && r.configured, 'ensureHome 失败');
      assert(!JSON.stringify(r).includes(probeKey.key), '返回对象泄漏 Key');
      realHome = engineDirReal;
      realHomeSource = 'ensureHome(自建 home)';
    });
  } else {
    console.log(`  ! 未能从 probe home 读取 Key（${probeKey.reason}），将直接使用 probe-dsh-home`);
  }
  if (!realHome) {
    realHome = PROBE_HOME;
    realHomeSource = 'probe-dsh-home(只读)';
  }

  const engine = createEngine({
    dshHome: realHome,
    dshBin,
    workRoot: path.join(TMP, 'engine-work'),
    timeoutMs: 240_000,
    model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    log: (m) => console.log(`    · ${m}`),
  });

  await testAsync('私有 DSH_HOME 隐私补丁进入 composition（--dump-config 实证）', async () => {
    if (realHome === PROBE_HOME) {
      console.log('    · 当前为只读 probe-dsh-home（无本引擎隐私补丁），跳过该项');
      return;
    }
    const dump = await engine.dumpConfig();
    assert(dump.ok, `--dump-config 失败（code=${dump.code}）：${(dump.stderr || '').slice(0, 500)}`);
    const text = dump.stdout;
    assert(
      /- id: session-log-deepseek[\s\S]{0,240}?enabled: false/.test(text),
      '组合配置中 session-log-deepseek 未显示 enabled:false'
    );
    assert(
      /- id: session-telemetry-otel[\s\S]{0,240}?mode: DISABLED/.test(text),
      '组合配置中 session-telemetry-otel 未显示 mode:DISABLED'
    );
    if (text.includes('enabled: true')) {
      // 其它插件也可能有 enabled 字段，仅提示不失败
      console.log('    · 注意：组合配置中存在其它 enabled: true 字段（非 session-log-deepseek）');
    }
    console.log('    · dump-config 已确认：session-log-deepseek enabled:false；session-telemetry-otel mode:DISABLED');
  });

  await testAsync('createEngine({ model }) 通过 --patch 覆盖默认模型', async () => {
    assert(engine.modelPatchPath && fs.existsSync(engine.modelPatchPath), '模型覆盖 overlay 文件未生成');
    const content = fs.readFileSync(engine.modelPatchPath, 'utf8');
    assert(/- id: agent-default-model/.test(content), 'overlay 缺少 agent-default-model 行');
    assert(/model: deepseek-flash/.test(content), 'overlay 缺少 model');
    assert(/reasoningEffort: high/.test(content), 'overlay 缺少 reasoningEffort');
    const dump = await engine.dumpConfig();
    assert(dump.ok, `--dump-config（含 --patch）失败：${(dump.stderr || '').slice(0, 500)}`);
    assert(
      /- id: agent-default-model[\s\S]{0,300}?reasoningEffort: high/.test(dump.stdout),
      '--patch 模型覆盖未进入组合配置'
    );
    console.log(`    · 模型覆盖 overlay：${engine.modelPatchPath}`);
  });

  await testAsync(`headless 健康检查（回 OK；home=${realHomeSource}，隐私+模型补丁同时加载）`, async () => {
    const result = await engine.check({ cwd: path.join(TMP, 'engine-work', 'check') });
    assert(
      result.ok,
      `健康检查失败（home=${realHomeSource}）：${JSON.stringify({ text: result.text, detail: result.detail }).slice(0, 1500)}`
    );
    assert(/OK/i.test(result.text), `期望回复 OK，实际：${JSON.stringify(result.text)}`);
    console.log(`    · 版本 ${result.version}，延迟 ${result.latencyMs}ms，回复 ${JSON.stringify(result.text)}`);
    console.log(`    · 最终 home=${realHomeSource}`);
  });

  const mockQuestions = [
    {
      qid: 'm1',
      type: 'single',
      stem: '在 JavaScript 中，数组的 length 属性表示什么？',
      opts: [
        { key: 'A', text: '数组中元素的个数' },
        { key: 'B', text: '数组的数据类型' },
        { key: 'C', text: '数组第一个元素的下标' },
        { key: 'D', text: '数组占用的内存字节数' },
      ],
    },
    {
      qid: 'm2',
      type: 'multi',
      stem: '下列哪些是 Node.js 的内置模块？（多选）',
      opts: [
        { key: 'A', text: 'fs' },
        { key: 'B', text: 'http' },
        { key: 'C', text: 'jquery' },
        { key: 'D', text: 'path' },
      ],
    },
    {
      qid: 'm3',
      type: 'blank',
      stem: '填空：1 + 1 = ____；2 × 3 = ____。',
      blanks: ['第1空', '第2空'],
    },
    {
      qid: 'm4',
      type: 'judge',
      stem: '判断题：在 JavaScript 中，`const` 声明的变量不能被重新赋值。',
      opts: [
        { key: 'A', text: '正确' },
        { key: 'B', text: '错误' },
      ],
    },
  ];

  const solveEngine = createEngine({
    dshHome: realHome,
    dshBin,
    workRoot: path.join(TMP, 'engine-work'),
    timeoutMs: 300_000,
    log: (m) => console.log(`    · ${m}`),
  });

  await testAsync('4 道 mock 题（单选/多选/填空/判断）真实求解并通过校验（分片路径）', async () => {
    const seen = [];
    const batchEvents = [];
    const result = await solveEngine.solveObjective({
      work: { workId: 'selftest-mock', name: '引擎自测 mock 作业' },
      questions: mockQuestions,
      cwd: path.join(TMP, 'engine-work', 'solve-mock'),
      batchSize: 20,
      onEvent: (evt) => {
        if (evt.type === 'status' && evt.phase) seen.push(evt.phase);
        if (evt.type === 'batch') batchEvents.push(evt);
      },
    });
    const errInfo = result && result.error ? JSON.stringify(result.error).slice(0, 1200) : JSON.stringify(result).slice(0, 1200);
    assert(result && result.ok, `求解失败：${errInfo}`);
    assert(seen.length >= 2, `onEvent 未收到事件（${JSON.stringify(seen)}）`);
    assert(batchEvents.length >= 2, `onEvent 未收到 batch 事件（${JSON.stringify(batchEvents)}）`);
    assert(result.batches === 1, `4 题应为 1 批，实际 ${result.batches}`);
    console.log(`    · answers=${JSON.stringify(result.answers)} confidence=${result.confidence} sources=${result.sources.length} latency=${result.latencyMs}ms batches=${result.batches}`);
    if (result.needMaterials.length) console.log(`    · needMaterials=${JSON.stringify(result.needMaterials)}`);
    // 合法性（不强制正确性，但基础常识答案应当合理）
    assert(result.answers.m1 === 'A', `m1 期望 A，实际 ${result.answers.m1}`);
    const m2 = result.answers.m2 || '';
    assert(m2.length >= 2 && [...m2].every((ch) => 'ABD'.includes(ch)), `m2 非法：${m2}`);
    assert(Array.isArray(result.answers.m3) && result.answers.m3.length === 2, `m3 应为 2 元素数组：${JSON.stringify(result.answers.m3)}`);
    assert(result.answers.m3[0].includes('2') && result.answers.m3[1].includes('6'), `m3 答案可疑：${JSON.stringify(result.answers.m3)}`);
    assert(['A', 'B'].includes(result.answers.m4), `m4 应为 A/B，实际：${result.answers.m4}`);
    // 再跑一遍纯解析校验，确保返回值符合学习通写入格式
    const again = validateObjectiveAnswers(mockQuestions, { answers: result.answers });
    assert(JSON.stringify(again.answers) === JSON.stringify(result.answers), '归一化结果不稳定');
  });

  await testAsync('模板只有标题/题号、无资料 → 必须返回 needMaterials 或 LOOP_DETECTED（不无限检索）', async () => {
    const needEngine = createEngine({
      dshHome: realHome,
      dshBin,
      workRoot: path.join(TMP, 'engine-work-need'),
      timeoutMs: 120_000,
      log: (m) => console.log(`    · ${m}`),
    });
    const outDir = path.join(TMP, 'doc-need-out');
    const t0 = Date.now();
    const sub = await needEngine.makeSubmissionDoc({
      work: { workId: 'need-test', name: '第6次作业 函数调用' },
      questions: [
        { qid: 'n1', type: 'short', stem: '课本习题三：完成该习题。' },
        { qid: 'n2', type: 'short', stem: '课本习题四.13：完成该习题。' },
      ],
      materials: '', // 关键：没有任何资料，模板只有章节标题
      templatePath: fs.existsSync(TEMPLATE) ? TEMPLATE : null,
      outDir,
    });
    const elapsed = Date.now() - t0;
    console.log(`    · elapsed=${elapsed}ms ok=${sub.ok} generated=${sub.generated} code=${sub.error ? sub.error.code : '-'}`);
    if (sub.ok) {
      assert(sub.generated === false, '缺资料时不应生成并提交文档');
      assert(Array.isArray(sub.needMaterials) && sub.needMaterials.length > 0, `应返回 needMaterials：${JSON.stringify(sub)}`);
      console.log(`    · needMaterials=${JSON.stringify(sub.needMaterials)}`);
    } else {
      assert(
        ['LOOP_DETECTED', 'TIMEOUT'].includes(sub.error.code),
        `未按预期返回 needMaterials 或循环保护：${JSON.stringify(sub.error).slice(0, 800)}`
      );
    }
    assert(elapsed < 130_000, `耗时过长：${elapsed}ms（应 <=120s 内返回）`);
    const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.docx')) : [];
    if (sub.generated === false) assert(files.length === 0, '缺资料时不应产生 docx');
  });
}

/* ---------------- 汇总 ---------------- */
const total = passed + failed;
const seconds = ((Date.now() - startedAll) / 1000).toFixed(1);
console.log('\n================ 结果 ================');
console.log(`通过 ${passed}/${total}，失败 ${failed}，耗时 ${seconds}s`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`- ${f.name}\n${f.error}\n`);
  process.exitCode = 1;
} else {
  console.log('全绿 ✔');
  console.log(`产物目录：${OUT}`);
  if (!offline) console.log(`真实调用 home：${realHomeSource}`);
}
