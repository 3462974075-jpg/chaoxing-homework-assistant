/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 测试/演示用的学习通核心假实现：遵循 cx/index.mjs 契约（设计说明 5.1）。
// 仅用于 tests/smoke.mjs 与 CX_FAKE=1 的本地演示，不访问真实站点。
export async function createCx({ dataDir, edgeProfileDir, log } = {}) {
  const submitted = new Set();
  const works = [
    { workId: '1001', name: '第5次作业 循环结构', status: '未交', kind: 'quiz', url: 'fake://work/1001' },
    { workId: '1002', name: '第6次作业 函数调用', status: '未交', kind: 'attach', url: 'fake://work/1002' },
    { workId: '1003', name: '第7章 前测', status: '已完成', kind: 'quiz', url: 'fake://work/1003' },
  ];
  const say = (...a) => { try { log && log(...a); } catch {} };
  return {
    async status() {
      return { loggedIn: true, uid: 'fake-uid-10086', savedAt: new Date().toISOString() };
    },
    async login() { say('fake login'); return { ok: true, uid: 'fake-uid-10086' }; },
    async logout() { return { ok: true }; },
    async listCourses() {
      return [{ name: '高级语言程序设计', courseId: 'c1', classId: 'cl1', cpi: 'cpi1', enc: 'enc1', entryUrl: 'fake://course/c1' }];
    },
    async listWorks() {
      return works.map((w) => ({ ...w, status: submitted.has(w.workId) ? '已完成' : w.status }));
    },
    async openWork(work) {
      if (work.kind === 'attach') {
        return {
          workId: work.workId,
          taskUrl: 'fake://dowork/1002',
          questions: [{ qid: 'q100', type: 'other', stem: '请按模板完成第6次作业并上传', opts: [], blanks: [] }],
          attachments: [{ name: '第6次作业模板.docx', url: 'fake://tpl/6.docx' }],
        };
      }
      return {
        workId: work.workId,
        taskUrl: `fake://dowork/${work.workId}`,
        questions: [
          { qid: 'q1', type: 'single', stem: '以下哪个是 C 语言的循环语句？', opts: [{ key: 'A', text: 'for' }, { key: 'B', text: 'if' }, { key: 'C', text: 'switch' }], blanks: [] },
          { qid: 'q2', type: 'multi', stem: '以下哪些是循环语句？', opts: [{ key: 'A', text: 'for' }, { key: 'B', text: 'while' }, { key: 'C', text: 'do-while' }], blanks: [] },
          { qid: 'q3', type: 'blank', stem: 'for(;;) 的三个部分用____分隔', opts: [], blanks: ['分隔符'] },
        ],
        attachments: [],
      };
    },
    async downloadAttachments(work, dir) { return []; },
    async fillAnswers(work, answers) { say('fake fill', work.workId, Object.keys(answers.answers || {}).length); return { ok: true, raw: { status: 1 } }; },
    async submitAnswers(work, answers) { submitted.add(work.workId); say('fake submit', work.workId); return { ok: true, raw: { status: 1, msg: '提交成功' } }; },
    async uploadAttachment(work, filePath) { say('fake upload', work.workId, filePath); return { ok: true, raw: { status: 1 } }; },
    async close() {},
  };
}
