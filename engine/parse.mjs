/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * parse.mjs — 从模型输出中稳健提取 JSON 并校验答案
 *
 * 覆盖三种真实形态：
 *   1) ```json 代码块
 *   2) 前后有解释文字的裸 JSON
 *   3) 纯 JSON 文本
 *
 * 校验（客观题）：
 *   - qid 全覆盖（可配置 allowMissing）
 *   - 单选/判断：单个合法选项字母
 *   - 多选：字母集合合法、非空
 *   - 填空：数组长度与 blanks 匹配（每空一个元素）
 * 失败抛 ParseError（带 details 明细），不做静默容错。
 */

/** 解析/校验错误（带明细，便于日志与 UI 提示） */
export class ParseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ParseError';
    this.details = details;
  }
}

/* ------------------------------------------------------------------ *
 * 1. JSON 提取
 * ------------------------------------------------------------------ */

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

/** 收集 ``` / ```json 代码块内容 */
function fencedBlocks(text) {
  const blocks = [];
  const re = /```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) blocks.push({ lang: (m[1] || '').toLowerCase(), body: m[2].trim() });
  return blocks;
}

/** 扫描所有平衡的 {...} 子串（正确处理字符串与转义） */
function balancedObjects(text) {
  const found = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          found.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return found;
}

/** 去掉「被其它候选完整包含」的嵌套对象，只保留最外层候选（保持出现顺序） */
function outermostCandidates(objects) {
  return objects.filter(
    (o, i) => !objects.some((p, j) => i !== j && p.length > o.length && p.includes(o))
  );
}

/**
 * 从任意文本提取第一个「可解析的」JSON 对象。
 * 优先级：带 json 标记的代码块（取最后一个，模型常把最终答案放最后）
 *        → 任意代码块 → 整段文本 → 文本中的平衡对象（取最后一个成功解析的）。
 *
 * @param {string} text
 * @returns {{json:any, strategy:string, source:string}}
 */
export function extractJson(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) throw new ParseError('模型输出为空', { raw: '' });

  const fenced = fencedBlocks(raw);
  const jsonFenced = fenced.filter((b) => b.lang === 'json' || b.lang === 'json5' || b.lang === '');
  const orderedFenced = [...jsonFenced.reverse(), ...fenced.filter((b) => !jsonFenced.includes(b)).reverse()];
  for (const block of orderedFenced) {
    const parsed = tryParse(block.body);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
      return { json: parsed.value, strategy: 'fenced', source: block.body };
    }
    // 代码块里可能还包了一层解释，用平衡对象兜底
    const inner = outermostCandidates(balancedObjects(block.body));
    for (let i = inner.length - 1; i >= 0; i--) {
      const p = tryParse(inner[i]);
      if (p.ok && p.value && typeof p.value === 'object') {
        return { json: p.value, strategy: 'fenced-inner', source: inner[i] };
      }
    }
  }

  const whole = tryParse(raw.trim());
  if (whole.ok && whole.value && typeof whole.value === 'object') {
    return { json: whole.value, strategy: 'plain', source: raw.trim() };
  }

  const objects = outermostCandidates(balancedObjects(raw));
  for (let i = objects.length - 1; i >= 0; i--) {
    const p = tryParse(objects[i]);
    if (p.ok && p.value && typeof p.value === 'object') {
      return { json: p.value, strategy: 'embedded', source: objects[i] };
    }
  }

  throw new ParseError('无法从模型输出中提取 JSON', {
    rawHead: raw.slice(0, 600),
    fencedCount: fenced.length,
    objectCandidates: objects.length,
  });
}

/* ------------------------------------------------------------------ *
 * 2. 归一化
 * ------------------------------------------------------------------ */

/** 统一字母：去空白/标点、转大写、去重、按字母升序。合法字母之外直接报错由校验负责 */
export function normalizeLetters(value) {
  if (value === null || value === undefined) return '';
  let arr;
  if (Array.isArray(value)) arr = value.map((v) => String(v ?? ''));
  else arr = [String(value)];
  const letters = [];
  for (const item of arr) {
    for (const ch of item) {
      if (/[A-Za-z]/.test(ch)) letters.push(ch.toUpperCase());
    }
  }
  return [...new Set(letters)].sort().join('');
}

/** 归一化「答案值」为可写入学习通的格式 */

const JUDGE_TRUE_WORDS = new Set(['true', 't', '1', '对', '正确', '是', '√', 'yes', 'y', '对的', '正确的']);
const JUDGE_FALSE_WORDS = new Set(['false', 'f', '0', '错', '错误', '否', '×', 'no', 'n', '错的', '错误的']);

/**
 * 判断题答案归一化：
 *   - 学习通判断题的 opts.key 常见为 `true`/`false`（文本"对"/"错"），隐藏域需要的就是 true/false；
 *   - 也可能是 A/B 字母选项，则返回对应字母；
 *   - 兼容模型输出 true/false/对/错/A/B/正确/错误/√/× 等。
 * @returns {string|null} 'true'|'false'|字母；无法判定返回 null
 */
export function normalizeJudgeAnswer(question, value) {
  const rawKeys = (question.opts || []).map((o) => String(o.key ?? '').trim()).filter(Boolean);
  const lowerKeys = rawKeys.map((k) => k.toLowerCase());
  const hasTrueFalseKeys = lowerKeys.includes('true') && lowerKeys.includes('false');
  const letterKeys = rawKeys.map((k) => k.toUpperCase()).filter((k) => /^[A-Z]$/.test(k));

  let truth = null;
  if (typeof value === 'boolean') truth = value;
  else if (typeof value === 'number') truth = value !== 0;
  else if (value && typeof value === 'object' && 'value' in value) return normalizeJudgeAnswer(question, value.value);
  else {
    const s = String(value ?? '').trim().toLowerCase();
    if (JUDGE_TRUE_WORDS.has(s)) truth = true;
    else if (JUDGE_FALSE_WORDS.has(s)) truth = false;
    else if (/^[a-z]$/.test(s)) {
      const letter = s.toUpperCase();
      if (!hasTrueFalseKeys && letterKeys.length) return letter; // 字母选项判断：直接给字母
      // 键是 true/false 但模型给了 A/B：按选项文本判断语义
      const opt = (question.opts || []).find((o) => String(o.key ?? '').toUpperCase() === letter);
      const text = String(opt?.text ?? '').trim();
      if (/正确|对|是|√|true/i.test(text)) truth = true;
      else if (/错误|错|否|×|false/i.test(text)) truth = false;
      else truth = letter === 'A';
    }
  }
  if (truth === null) return null;
  if (hasTrueFalseKeys) return truth ? 'true' : 'false';
  if (letterKeys.length) {
    const matched = (question.opts || []).find((o) => {
      const text = String(o?.text ?? '');
      return truth ? /正确|对|是|√|true/i.test(text) : /错误|错|否|×|false/i.test(text);
    });
    if (matched && String(matched.key ?? '').trim()) return String(matched.key).trim().toUpperCase();
    return truth ? letterKeys[0] : letterKeys[1] || letterKeys[0];
  }
  // 无 opts 信息：学习通判断隐藏域默认 true/false
  return truth ? 'true' : 'false';
}

export function normalizeAnswerValue(question, value) {
  const type = question.type || 'other';
  if (type === 'judge') {
    const judge = normalizeJudgeAnswer(question, value);
    if (judge === null) {
      throw new ParseError(
        `题目 ${question.qid}（judge）答案无法识别为 true/false：${JSON.stringify(value)}`,
        { qid: question.qid, type, value }
      );
    }
    return judge;
  }
  if (type === 'single') {
    const letters = normalizeLetters(value);
    if (letters.length !== 1) {
      throw new ParseError(`题目 ${question.qid}（${type}）答案必须是单个选项字母，实际：${JSON.stringify(value)}`, {
        qid: question.qid,
        type,
        value,
      });
    }
    return letters;
  }
  if (type === 'multi') {
    const letters = normalizeLetters(value);
    if (!letters.length) {
      throw new ParseError(`题目 ${question.qid}（multi）答案为空`, { qid: question.qid, value });
    }
    return letters;
  }
  if (type === 'blank') {
    const blankCount = Array.isArray(question.blanks) ? question.blanks.length : 0;
    let arr;
    if (Array.isArray(value)) arr = value.map((v) => trimBlank(v));
    else if (typeof value === 'string') {
      if (blankCount > 1) {
        // 兼容 "a; b" / "a；b" / "a|b" 这类模型输出
        const parts = value.split(/\s*[;；|]\s*/).filter((s) => s.length);
        arr = parts.length > 1 ? parts.map(trimBlank) : [trimBlank(value)];
      } else {
        arr = [trimBlank(value)];
      }
    } else if (value && typeof value === 'object') {
      // 兼容 {"1":"x","2":"y"} 或 {"空1":"x"}
      arr = Object.keys(value)
        .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
        .map((k) => trimBlank(value[k]));
    } else {
      throw new ParseError(`题目 ${question.qid}（blank）答案格式不支持：${JSON.stringify(value)}`, {
        qid: question.qid,
        value,
      });
    }
    if (blankCount > 0 && arr.length !== blankCount) {
      throw new ParseError(
        `题目 ${question.qid}（blank）填空数量不匹配：需要 ${blankCount} 个，实际 ${arr.length} 个`,
        { qid: question.qid, need: blankCount, got: arr.length, value }
      );
    }
    if (arr.some((s) => !String(s).trim())) {
      throw new ParseError(`题目 ${question.qid}（blank）存在空答案`, { qid: question.qid, value });
    }
    return arr;
  }
  // 其它题型：原样返回
  return value;
}

function trimBlank(v) {
  return String(v ?? '').trim();
}

function optionKeySet(question) {
  const keys = new Set();
  for (const opt of question.opts || []) {
    const k = String(opt.key ?? '').trim().toUpperCase();
    if (k) keys.add(k);
    // 兼容 opts 只有文本、key 是 "A. 文本" 的情况
    const first = /^([A-Za-z])[.、:：)）\s]/.exec(String(opt.text ?? ''));
    if (first) keys.add(first[1].toUpperCase());
  }
  return keys;
}

function validateLettersAgainstOptions(question, value) {
  const letters = String(value ?? '');
  // 判断题的 true/false 不是选项字母，跳过字母集合校验
  if (question.type === 'judge' && /^(true|false)$/i.test(letters)) return;
  const keys = optionKeySet(question);
  if (!keys.size) return; // 无选项信息（如判断/ latex 题），只校验字形
  const bad = [...letters].filter((ch) => !keys.has(ch));
  if (bad.length) {
    throw new ParseError(
      `题目 ${question.qid}（${question.type}）答案包含不存在的选项：${bad.join(',')}；合法选项：${[...keys].sort().join(',')}`,
      { qid: question.qid, letters, keys: [...keys] }
    );
  }
}

/** 归一化 sources / needMaterials / confidence */
export function normalizeMeta(parsed) {
  const sources = Array.isArray(parsed?.sources)
    ? parsed.sources
        .filter((s) => s && (s.url || s.title))
        .map((s) => ({ title: String(s.title ?? '').trim(), url: String(s.url ?? '').trim() }))
        .filter((s) => s.url || s.title)
    : [];
  const needMaterials = Array.isArray(parsed?.needMaterials)
    ? parsed.needMaterials.map((m) => String(m ?? '').trim()).filter(Boolean)
    : typeof parsed?.needMaterials === 'string' && parsed.needMaterials.trim()
      ? [parsed.needMaterials.trim()]
      : [];
  let confidence = Number(parsed?.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));
  return { sources, needMaterials, confidence };
}

/* ------------------------------------------------------------------ *
 * 3. 客观题校验
 * ------------------------------------------------------------------ */

export const OBJECTIVE_TYPES = new Set(['single', 'multi', 'judge', 'blank']);

/**
 * 校验并归一化客观题答案。
 *
 * @param {any[]} questions 题目数组（含 qid/type/opts/blanks）
 * @param {any} parsed 模型 JSON（可为 {answers:{...},...} 或直接的 answers 对象）
 * @param {{allowMissing?:boolean, allowExtra?:boolean, extraPartialCreditTypes?:string[]}} [opts]
 *        allowMissing=true 时：缺失的 qid 不报错，但会在返回值.missing 里列出
 * @returns {{answers:Object, missing:string[], extras:string[], normalized:boolean}}
 */
export function validateObjectiveAnswers(questions, parsed, opts = {}) {
  const { allowMissing = false, allowExtra = true } = opts;
  if (!Array.isArray(questions) || !questions.length) {
    throw new ParseError('validateObjectiveAnswers：questions 为空');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ParseError('validateObjectiveAnswers：parsed 不是对象', { parsed });
  }
  const answersIn = parsed.answers && typeof parsed.answers === 'object' ? parsed.answers : parsed;
  if (!answersIn || typeof answersIn !== 'object' || Array.isArray(answersIn)) {
    throw new ParseError('validateObjectiveAnswers：缺少 answers 对象', { parsed });
  }

  const objective = questions.filter((q) => OBJECTIVE_TYPES.has(q.type));
  if (!objective.length) return { answers: {}, missing: [], extras: [], normalized: false };

  const answers = {};
  const problems = [];
  const missing = [];

  for (const q of objective) {
    const qid = String(q.qid);
    const present = Object.prototype.hasOwnProperty.call(answersIn, qid);
    if (!present) {
      // 兼容数字 key（如答案对象用数字题号做键）
      const numericKey = Object.keys(answersIn).find((k) => String(k) === qid);
      if (numericKey === undefined) {
        missing.push(qid);
        continue;
      }
      answersIn[qid] = answersIn[numericKey];
    }
    try {
      const value = normalizeAnswerValue(q, answersIn[qid]);
      if (q.type === 'single' || q.type === 'judge' || q.type === 'multi') {
        validateLettersAgainstOptions(q, value);
      }
      answers[qid] = value;
    } catch (err) {
      problems.push({ qid, message: err.message, details: err.details || null });
    }
  }

  if (problems.length) {
    // 单题失败直接把具体原因作为 message，便于 UI 展示与用户排查；多题时聚合。
    const message =
      problems.length === 1
        ? problems[0].message
        : `客观题答案校验失败（${problems.length} 题）`;
    throw new ParseError(message, { problems, missing });
  }
  if (missing.length && !allowMissing) {
    throw new ParseError(`答案缺少 ${missing.length} 道题：${missing.join(',')}`, { missing, questions: objective.map((q) => q.qid) });
  }

  const knownQids = new Set(questions.map((q) => String(q.qid)));
  const extras = Object.keys(answersIn).filter((k) => !knownQids.has(String(k)));
  if (extras.length && !allowExtra) {
    throw new ParseError(`答案包含未知 qid：${extras.join(',')}`, { extras });
  }

  return { answers, missing, extras, normalized: true };
}

/* ------------------------------------------------------------------ *
 * 4. 主观题 / 附件作业校验
 * ------------------------------------------------------------------ */

function coerceContent(parsed) {
  if (typeof parsed === 'string') return parsed.trim();
  if (!parsed || typeof parsed !== 'object') return '';
  const candidate =
    parsed.content ?? parsed.text ?? parsed.answer ?? parsed.markdown ?? parsed.body ?? parsed.html ?? '';
  return typeof candidate === 'string' ? candidate.trim() : '';
}

/**
 * 校验「简答题」模型输出。
 * @returns {{text:string, title:string, sources:any[], needMaterials:string[], confidence:number}}
 */
export function validateShortAnswer(parsed, { allowEmptyWithMaterials = true } = {}) {
  const meta = normalizeMeta(parsed);
  const text = coerceContent(parsed);
  if (!text && meta.needMaterials.length === 0) {
    throw new ParseError('简答题输出缺少 content 正文', { parsedHead: JSON.stringify(parsed).slice(0, 400) });
  }
  if (!text && !allowEmptyWithMaterials) {
    throw new ParseError('简答题正文为空', { needMaterials: meta.needMaterials });
  }
  return {
    text,
    title: String(parsed?.title ?? '').trim(),
    sources: meta.sources,
    needMaterials: meta.needMaterials,
    confidence: meta.confidence,
  };
}

/**
 * 校验「附件作业正文」模型输出。
 * @returns {{title:string, content:string, sources:any[], needMaterials:string[], confidence:number}}
 */
export function validateSubmission(parsed, { allowEmptyWithMaterials = true } = {}) {
  const meta = normalizeMeta(parsed);
  const content = coerceContent(parsed);
  if (!content && meta.needMaterials.length === 0) {
    throw new ParseError('附件作业输出缺少 content 正文', { parsedHead: JSON.stringify(parsed).slice(0, 400) });
  }
  if (!content && !allowEmptyWithMaterials) {
    throw new ParseError('附件作业正文为空', { needMaterials: meta.needMaterials });
  }
  return {
    title: String(parsed?.title ?? '').trim(),
    content,
    sources: meta.sources,
    needMaterials: meta.needMaterials,
    confidence: meta.confidence,
  };
}

/** 一站式：提取 JSON + 归一化 meta（不校验具体题型） */
export function parseModelJson(text) {
  const { json, strategy, source } = extractJson(text);
  return { json, strategy, source, meta: normalizeMeta(json) };
}
