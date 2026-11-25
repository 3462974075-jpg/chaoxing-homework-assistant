/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 目标正确率（近似）：仅对选择题/填空题按题数比例故意改错。
// 注意：这不是“真实正确率保证”，而是“保留 AI 答案的比例”，实际正确率仍取决于题目难度与模型。

export const ACCURACY_LEVELS = [0.99, 0.9, 0.8, 0.6, 0.3];
export const ACCURACY_LABELS = ['99%', '90%', '80%', '60%', '30%'];
export const ACCURACY_TYPES = new Set(['single', 'multi', 'judge', 'blank', 'choice', 'truefalse']);

export function normalizeTargetAccuracy(value, fallback = 0.99) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let best = ACCURACY_LEVELS[0];
  let diff = Infinity;
  for (const level of ACCURACY_LEVELS) {
    const d = Math.abs(level - n);
    if (d < diff) { diff = d; best = level; }
  }
  return best;
}

function stableHash(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function optionKeys(question) {
  const opts = Array.isArray(question && question.opts) ? question.opts
    : (Array.isArray(question && question.options) ? question.options : []);
  const keys = [];
  for (const o of opts) {
    if (typeof o === 'string') {
      const m = o.match(/^\s*([A-Za-z])[\s.、:：]/);
      if (m) keys.push(m[1].toUpperCase());
    } else if (o && typeof o === 'object') {
      const k = o.key || o.value || o.name;
      if (k) keys.push(String(k).toUpperCase());
    }
  }
  return [...new Set(keys)];
}

function choiceKeys(question) {
  const keys = optionKeys(question);
  return keys.length ? keys : ['A', 'B', 'C', 'D'];
}

function answerText(value) {
  if (Array.isArray(value)) return value.map((x) => String(x ?? '')).join('');
  return String(value ?? '');
}

function mutateChoice(question, answer) {
  const type = String(question.type || '').toLowerCase();
  const keys = choiceKeys(question);
  const current = answerText(answer).trim();

  if (type === 'judge' || type === 'truefalse') {
    const low = current.toLowerCase();
    if (low === 'true' || current === '对') return current === '对' ? '错' : 'false';
    if (low === 'false' || current === '错') return current === '错' ? '对' : 'true';
    if (/^[ab]$/i.test(current)) return current.toUpperCase() === 'A' ? 'B' : 'A';
    return current ? (low === 'true' ? 'false' : 'true') : 'false';
  }

  if (type === 'multi') {
    const letters = [...new Set(current.toUpperCase().replace(/[^A-Z]/g, '').split(''))];
    if (letters.length > 1) return letters.slice(0, -1).join('');
    const other = keys.find((k) => !letters.includes(k));
    if (other) return [...letters, other].join('');
    return null;
  }

  // single / choice
  const cur = current.toUpperCase().replace(/[^A-Z]/g, '');
  const other = keys.find((k) => k !== cur);
  if (other) return other;
  if (cur) {
    const fallback = [...'ABCD'].find((k) => k !== cur);
    return fallback || null;
  }
  return null;
}

/** 只能给填空题用一个“看起来像答案但错误”的兜底文本；优先使用模型生成的错误答案。 */
export function fallbackWrongBlank(answer) {
  const text = answerText(answer);
  if (!text.trim()) return '未知';
  if (/^-?\d+(?:\.\d+)?$/.test(text.trim())) {
    const n = Number(text.trim());
    if (Number.isFinite(n)) return String(n + (n >= 0 ? 1 : -1));
  }
  return `${text}（错误）`;
}

/**
 * 选出要故意改错的题目（按题数比例）。
 * @param {{questions:Array, answers:Object, excludeQids?:Iterable, target?:number, seed?:string}} opts
 */
export function planTargetAccuracy({ questions, answers, excludeQids = [], target = 0.99, seed = '' } = {}) {
  const normalizedTarget = normalizeTargetAccuracy(target);
  const excluded = new Set([...(excludeQids || [])].map(String));
  const map = answers && answers.answers && typeof answers.answers === 'object' ? answers.answers : answers || {};
  const eligible = [];
  (questions || []).forEach((q, idx) => {
    const qid = String(q && q.qid);
    const type = String(q && q.type || '').toLowerCase();
    if (!ACCURACY_TYPES.has(type)) return;
    if (excluded.has(qid)) return;
    const value = map[qid];
    if (value == null || (Array.isArray(value) ? !value.length : !String(value).trim())) return;
    eligible.push({ index: idx + 1, qid, type, stem: String(q.stem || q.title || ''), answer: value });
  });
  const n = eligible.length;
  if (!n || normalizedTarget >= 0.99) {
    return { target: normalizedTarget, eligibleCount: n, wrongCount: 0, selected: [] };
  }
  const wrongCount = Math.min(n, Math.max(1, Math.round(n * (1 - normalizedTarget))));
  const rand = seededRandom(stableHash(`${seed}|${normalizedTarget}`));
  const shuffled = eligible
    .map((item) => ({ item, order: rand() }))
    .sort((a, b) => a.order - b.order)
    .map((x) => x.item);
  // 优先选择题，填空题放后面（填空需要额外生成错误答案）
  const selected = shuffled
    .slice(0, wrongCount)
    .map((item) => ({ ...item, kind: item.type === 'blank' ? 'blank' : 'choice' }));
  return { target: normalizedTarget, eligibleCount: n, wrongCount, selected };
}

/**
 * 应用改错；blankWrong 为 qid -> 错误答案（可由 AI 生成）。
 * 返回 { answers, changed, failed }，不会修改 manual/非客观题。
 */
// applyTargetAccuracy 需要题目选项：plan 的 selected 项没有 opts。
// 调用方通过 bindQuestions 注入；为保持 API 简单，提供包装器。
export function applyTargetAccuracyFor({ plan, answers, questions, blankWrong = {} } = {}) {
  const qmap = new Map((questions || []).map((q) => [String(q.qid), q]));
  const enriched = {
    ...plan,
    selected: (plan && plan.selected || []).map((item) => {
      const q = qmap.get(item.qid) || {};
      return { ...item, opts: q.opts || q.options || [] };
    }),
  };
  const map = answers && answers.answers && typeof answers.answers === 'object' ? answers.answers : answers || {};
  const changed = [];
  const failed = [];
  for (const item of enriched.selected) {
    let wrong = null;
    if (item.kind === 'blank') {
      const w = blankWrong[item.qid];
      const candidate = w != null && String(Array.isArray(w) ? w.join('') : w).trim() ? w : fallbackWrongBlank(item.answer);
      const candidateText = String(Array.isArray(candidate) ? candidate.join('') : candidate).trim();
      const correctText = String(Array.isArray(item.answer) ? item.answer.join('') : item.answer).trim();
      wrong = candidateText && candidateText !== correctText ? candidate : fallbackWrongBlank(item.answer);
    } else {
      wrong = mutateChoice({ type: item.type, opts: item.opts }, item.answer);
    }
    if (wrong == null || String(Array.isArray(wrong) ? wrong.join('') : wrong).trim() === '') {
      failed.push(item.qid);
      continue;
    }
    map[item.qid] = wrong;
    changed.push({ qid: item.qid, index: item.index, type: item.type, kind: item.kind, before: item.answer, after: wrong });
  }
  return { answers: map, changed, failed };
}
