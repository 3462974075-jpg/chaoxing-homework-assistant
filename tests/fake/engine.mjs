/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 测试/演示用的 AI 引擎假实现：遵循 engine/index.mjs 契约（设计说明 5.2）。
// 附件作业在“没有任何资料”时返回 needMaterials，用于验证编排器的暂停/继续逻辑。
import fs from 'node:fs';
import path from 'node:path';

export async function createEngine({ dshHome, dshBin, log } = {}) {
  const say = (...a) => { try { log && log(...a); } catch {} };
  return {
    async ensureHome() { return { ok: true }; },
    async check() { return { ok: true, version: 'fake', latencyMs: 1 }; },
    async ocrImages({ files = [] } = {}) {
      return {
        ok: true,
        texts: (files || []).map((f) => ({ file: f, text: 'FAKE OCR：这里是图片中的题目文字（测试桩）' })),
        combined: '',
        errors: [],
      };
    },
    async solveObjective({ work, questions }) {
      say('fake solve', work.workId, questions.length);
      const answers = {};
      for (const q of questions) {
        if (q.type === 'single') answers[q.qid] = (q.opts[0] && q.opts[0].key) || 'A';
        else if (q.type === 'multi') answers[q.qid] = q.opts.map((o) => o.key).join('');
        else if (q.type === 'blank') answers[q.qid] = (q.blanks || []).map((b) => String(b || '答案'));
        else answers[q.qid] = 'A';
      }
      return { answers, sources: [{ title: 'fake source', url: 'https://example.com' }], confidence: 0.9, needMaterials: [], raw: '' };
    },
    async answerShort({ question }) {
      say('fake short', question.qid);
      return { text: '这是简答题的示例答案。', sources: [], needMaterials: [] };
    },
    async makeWrongAnswers({ questions = [], correctAnswers = {} }) {
      const answers = {};
      for (const q of questions) {
        const qid = String(q.qid);
        const cur = correctAnswers[qid];
        if (cur == null) continue;
        answers[qid] = Array.isArray(cur) ? cur.map((x) => `${x}-错`) : `${cur}-错`;
      }
      return { ok: true, answers, latencyMs: 1 };
    },
    async makeSubmissionDoc({ work, materials, outDir }) {
      say('fake doc', work.workId, 'materials=', materials.length);
      if (!materials || materials.length === 0) {
        return { needMaterials: ['作业模板 / 参考资料'], filePath: null, summary: '缺少模板' };
      }
      fs.mkdirSync(outDir, { recursive: true });
      const filePath = path.join(outDir, `${work.workId}_fake_submission.docx`);
      fs.writeFileSync(filePath, 'FAKE DOCX CONTENT', 'utf8');
      return { filePath, format: 'docx', summary: 'fake doc', sources: [], needMaterials: [] };
    },
    async cancel() {},
  };
}
