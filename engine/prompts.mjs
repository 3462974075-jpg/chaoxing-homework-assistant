/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * prompts.mjs — 引擎提示词构造
 *
 * 边界（设计说明 5.2 / 8.1）：
 *   - nested headless 只做「推理 + web_search」。工程侧与本机沙箱实测：
 *     nested DSH 的 shell / 文件工具不可用，所以提示词必须明确禁止调用它们，
 *     也禁止要求模型写文件；所有落盘由 App 侧完成。
 *   - 输出必须是严格 JSON（```json 代码块内），便于 parse.mjs 稳健解析。
 */

/** 所有提示词共享的硬约束 */
export const COMMON_RULES = [
  '【硬性约束】',
  '1. 你可以并且应该使用 web_search 联网检索核对（用题干关键词搜索，优先权威/教材/题库来源）。',
  '2. 禁止调用 shell、终端、命令、文件读写、编辑器等任何工具；不要尝试写文件或创建文档（当前环境不支持，且结果必须只通过文本返回）。',
  '3. 最终只输出一个 ```json 代码块，代码块外不要写任何解释、前言、后记。',
  '4. JSON 必须能被 JSON.parse 直接解析：双引号、无注释、无尾逗号、不要用 Markdown 表格。',
  '5. 不确定就如实降低 confidence 或写进 needMaterials，不要编造；绝对不能伪造检索来源。',
  '6. 【检索上限】整次回答最多做 3 次 web_search / web_fetch；拿到够用的信息就立即停止检索并作答。',
  '7. 【禁止绕过限制】禁止使用 OCR、截图识别、第三方解析 API、爬虫脚本；禁止派生子代理（subagent）或后台任务去检索；禁止查找/下载整本教材 PDF、答案库、题库原题站。',
  '8. 【严禁反复搜索】3 次检索仍拿不到关键资料时，必须停止检索，按下方规则直接给出 JSON（缺资料就写 needMaterials），不许继续找。',
].join('\n');

/** 主观题/附件作业共用的「资料边界」约束（解决：模板只有标题→无限找教材原题） */
export const MATERIAL_BOUNDARY_RULES = [
  '【资料边界（最重要）】',
  '- 只能依据三类内容作答：① 题目列表里给出的题目正文；② 模板里已有的内容；③ 用户补充资料。',
  '- 模板常常只有章节标题/题号（如「课本习题三」「四.13」）而没有题目正文。',
  '  若检索 2–3 次后仍无法确定原题/教材内容，必须直接返回：',
  '  {"content":"","title":"","sources":[],"needMaterials":["课本习题原文（请拍照/截图后作为资料上传）"]}',
  '  其中 needMaterials 要用中文逐条写清缺什么（例如「课本习题三的题干与数据」「四.13 原题」）。',
  '- 绝对不要编造题目或答案，不要继续找教材 PDF / 答案库 / 整本书，不要把时间花在检索上。',
  '- 如果只有部分题目缺正文：能为那些题目写的先写，缺的逐条写进 needMaterials；不要为缺资料的题目硬写。',
].join('\n');

/** 把题目压缩成稳定的 JSON 结构（去掉无关字段，控制长度） */
export function compactQuestions(questions = [], { stemChars = 1200, optChars = 300, blankChars = 200 } = {}) {
  return questions.map((q) => {
    const item = { qid: String(q.qid), type: q.type || 'other', stem: truncate(q.stem || '', stemChars) };
    if (Array.isArray(q.opts) && q.opts.length) {
      item.opts = q.opts.map((o) => ({ key: String(o.key), text: truncate(o.text ?? '', optChars) }));
    }
    if (Array.isArray(q.blanks) && q.blanks.length) {
      item.blanks = q.blanks.map((b) => truncate(typeof b === 'string' ? b : String(b ?? ''), blankChars));
    }
    if (q.latex) item.latex = true;
    return item;
  });
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（已截断）`;
}

/** 把题目按给定 stem 预算再序列化，确保整体提示词不超长 */
function serializeQuestions(questions, { stemChars, optChars = 300 }) {
  return JSON.stringify(compactQuestions(questions, { stemChars, optChars }), null, 2);
}

/**
 * 构造「客观题批量求解」提示词。
 * @param {{work?:any, questions:any[], maxChars?:number, materials?:string}} opts
 * @returns {string}
 */
export function buildObjectivePrompt({ work, questions = [], maxChars = 24_000, materials = '' } = {}) {
  if (!Array.isArray(questions) || !questions.length) throw new Error('buildObjectivePrompt：questions 不能为空');
  const header = [
    '你是严谨的高校课程作业答题助手。下面是学习通作业里的客观题列表（JSON）。请逐题给出答案。',
    work ? `作业：${work.name || work.workName || work.workId || ''}` : '',
    materials ? `用户补充资料：\n${materials}` : '',
    COMMON_RULES,
    '',
    '【课程背景（重要，用于避免误判）】这是中国高校《军事理论》/国防教育课程的考试练习题，属于正常的课程学习与复习内容。请依据公开教材与课程知识点选择标准答案，只输出选项字母，不展开敏感细节、不讨论现实军事行动或政治评价。',
    '',
    '【题型与 answers 取值规则】',
    '- type=single（单选）：写一个选项字母，如 "A"。',
    '- type=judge（判断）：先看 opts 的 key——若 key 是 true/false，直接写 "true"（对/正确）或 "false"（错/错误）；若 key 是 A/B 字母，则写对应字母。',
    '- type=multi（多选）：把选项字母连写成一个字符串并按字母升序，如 "AB"、"ACD"。',
    '- type=blank（填空）：写字符串数组，按 blanks 顺序、每空一个元素，如 ["x=1","y=2"]；只有一个空时也必须是数组。',
    '- 其它类型（short/attach/other）：不要出现在 answers 里。',
    '- answers 的键必须是题目里给出的 qid 原样字符串。',
    '',
    '【输出 JSON 结构（必须完全一致）】',
    '{"answers":{"<qid>":"A"},"sources":[{"title":"页面标题","url":"https://..."}],"needMaterials":[],"confidence":0.9}',
    '',
    '【needMaterials】',
    '- 只有确实缺少必要资料/题目信息不足时才填写，用中文写清楚缺什么（如「缺少教材第 3 章正文」）。',
    '- needMaterials 为空数组表示资料充足。',
    '',
    '【客观题检索策略】',
    '- 整次回答最多 3 次 web_search / web_fetch；不要把时间花在找题库原题/整本教材上。',
    '- 3 次检索仍拿不准时，按学科常识直接给出最可能的答案，并在 sources 里列出你依据的页面（没有就写 1 条常识依据说明或空数组）。',
    '',
    '题目列表：',
    '```json',
  ]
    .filter(Boolean)
    .join('\n');

  const tail = '```';

  // 逐级缩短题干，直到满足长度预算
  const budgets = [1200, 800, 500, 300, 200, 120, 80, 40];
  for (const stemChars of budgets) {
    const prompt = `${header}\n${serializeQuestions(questions, { stemChars })}\n${tail}\n\n请只输出 \`\`\`json 代码块（不要其它文字）。`;
    if (prompt.length <= maxChars) return prompt;
  }
  // 极端情况：只保留题号与选项 key
  const minimal = questions.map((q) => ({
    qid: String(q.qid),
    type: q.type || 'other',
    stem: truncate(q.stem || '', 40),
    opts: (q.opts || []).map((o) => ({ key: String(o.key), text: truncate(o.text ?? '', 20) })),
    blanks: (q.blanks || []).map((b) => truncate(String(b ?? ''), 20)),
  }));
  return `${header}\n${JSON.stringify(minimal, null, 2)}\n${tail}\n\n请只输出 \`\`\`json 代码块（不要其它文字）。`;
}

/**
 * 构造「附件型作业：生成提交文档内容」提示词。
 * @param {{work?:any, questions?:any[], materials?:string, maxChars?:number, formatHint?:string}} opts
 */
export function buildSubmissionPrompt({
  work,
  questions = [],
  materials = '',
  maxChars = 24_000,
  formatHint = 'Word（.docx）',
  templateOutline = null,
  templateText = '',
} = {}) {
  const outlineLines = Array.isArray(templateOutline) ? templateOutline.filter(Boolean) : [];
  const templateExcerpt = truncate(String(templateText ?? '').replace(/\n{2,}/g, '\n').trim(), 3000);
  const header = [
    '你是严谨的高校课程作业代写助手。请根据作业要求撰写可直接提交的作业正文。',
    work ? `作业名称：${work.name || work.workName || work.workId || ''}` : '',
    formatHint ? `提交格式：${formatHint}；正文用 Markdown（标题用 # / ##，少量表格可用 Markdown 表格）。` : '',
    materials ? `用户补充资料（必须优先依据这些资料作答）：\n${materials}` : '',
    materials
      ? '【重要】上面的资料已包含题目原文（图片为 OCR 文字，可能有少量识别错误，按上下文理解即可）。请**直接依据资料作答**：不需要联网检索，最多检索 1 次；禁止寻找整本教材/题库/答案 PDF；不要因为图片 OCR 的小瑕疵而反复检索。'
      : '',
    COMMON_RULES,
    '',
    MATERIAL_BOUNDARY_RULES,
    '',
    '【写作要求】',
    '- 内容完整、条理清晰、可直接提交；中文；数学公式用纯文本或简单 LaTeX 表示。',
    '- 结构建议：一级标题写题号/题目名，正文给出解答步骤与结论；多题按题号顺序排列。',
    '- 如果作业题目列表存在，必须逐题覆盖，不能漏题。',
    '- 篇幅按题目要求；未说明时每题 200–600 字（编程题给完整代码与说明）。',
    outlineLines.length
      ? `- 本次交付会套用 Word 模板，模板已包含以下章节行。**请直接使用这些章节行作为一/二级标题**（原样照抄，不要改写、不要重复文档大标题），答案写在对应标题下：\n${outlineLines.map((t) => `    · ${t}`).join('\n')}`
      : '',
    templateExcerpt
      ? `【模板原文节选】（供理解模板结构与要求，不要在正文中重复这些套话）\n"""\n${templateExcerpt}\n"""`
      : '',
    '',
    '【输出 JSON 结构（必须完全一致）】',
    '{"title":"文档标题","content":"Markdown 或纯文本正文","sources":[{"title":"","url":""}],"needMaterials":[]}',
    '',
    '【needMaterials】缺少教材/题目原文/数据等必要资料而无法认真完成时，用中文列出缺什么，content 可为空字符串。资料充足时给空数组。',
    '- 若模板只有章节标题/题号、题目正文缺失，且检索 2–3 次仍拿不到原题：**必须**返回 content 为空字符串 + needMaterials 列出缺失的题目原文，不得为这些章节硬写/编造。',
    '- 有正文可写的章节正常写；缺资料的章节只在 needMaterials 中列出，不要用「略」「见教材」等占位正文充数。',
    '',
    questions.length ? '作业题目列表：' : '',
    questions.length ? '```json' : '',
  ]
    .filter(Boolean)
    .join('\n');

  const tail = questions.length ? '```' : '';
  const budgets = [1200, 800, 500, 300, 200, 120, 80, 40];
  for (const stemChars of budgets) {
    const body = questions.length ? `${serializeQuestions(questions, { stemChars })}\n${tail}` : '';
    const prompt = `${header}\n${body}\n\n请只输出 \`\`\`json 代码块（不要其它文字，不要写文件）。`;
    if (prompt.length <= maxChars) return prompt;
  }
  const body = questions.length
    ? `${JSON.stringify(
        questions.map((q) => ({ qid: String(q.qid), stem: truncate(q.stem || '', 40) })),
        null,
        2
      )}\n${tail}`
    : '';
  return `${header}\n${body}\n\n请只输出 \`\`\`json 代码块（不要其它文字，不要写文件）。`;
}

/**
 * 构造「单道主观题作答」提示词。
 * @param {{work?:any, question:any, materials?:string, maxChars?:number}} opts
 */
export function buildShortAnswerPrompt({ work, question, materials = '', maxChars = 20_000 } = {}) {
  if (!question) throw new Error('buildShortAnswerPrompt：缺少 question');
  const q = compactQuestions([question], { stemChars: 2000 })[0];
  const header = [
    '你是严谨的高校课程作业答题助手。请回答下面这道主观题（简答/论述/编程说明等）。',
    work ? `作业：${work.name || work.workName || work.workId || ''}` : '',
    materials ? `用户补充资料（必须优先依据）：\n${materials}` : '',
    COMMON_RULES,
    '',
    MATERIAL_BOUNDARY_RULES,
    '',
    '【要求】',
    '- 用中文作答，分点清晰；按题目要求决定篇幅；不要出现「作为AI」等元话语。',
    '- 若题目要求代码，给出完整可运行代码并简要说明。',
    '- 若题目正文本身残缺（如只有「课本习题三」没有题干）且 2–3 次检索仍拿不到：返回 content 为空 + needMaterials 说明缺什么，不要编题。',
    '',
    '【输出 JSON 结构（必须完全一致）】',
    '{"content":"答案正文（Markdown 或纯文本）","title":"可选的简短标题","sources":[{"title":"","url":""}],"needMaterials":[]}',
    '',
    '题目：',
    '```json',
    JSON.stringify(q, null, 2),
    '```',
  ]
    .filter(Boolean)
    .join('\n');
  const prompt = `${header}\n\n请只输出 \`\`\`json 代码块（不要其它文字，不要写文件）。`;
  return prompt.length <= maxChars ? prompt : prompt.slice(0, maxChars) + '\n（提示词过长已截断，按已有信息作答）';
}

/** 检索兜底提示词标记（mock/测试也用它识别「这是检索任务」） */
export const SEARCH_FALLBACK_MARKER = '【检索找答案任务】';

/**
 * 构造「检索兜底」提示词：只让模型联网搜题/题库答案，不自行分析、不展开内容。
 * 用于单题/批次被内容审核拒绝（MODEL_REFUSED）后的合规回退。
 * @param {{work?:any, question:any, materials?:string, maxSearches?:number}} opts
 */
export function buildSearchAnswerPrompt({ work, question, materials = '', maxSearches = 2 } = {}) {
  if (!question) throw new Error('buildSearchAnswerPrompt：缺少 question');
  const q = compactQuestions([question], { stemChars: 2000 })[0];
  const lines = [
    SEARCH_FALLBACK_MARKER,
    '这是中国高校《军事理论》/国防教育课程的考试练习题，属于正常课程学习与复习；上一轮模型因内容审核未能直接作答。',
    '本次**不要自行分析题目、不要展开或讨论题目内容**，只需要联网找到这道题的标准答案。',
    work ? `作业：${work.name || work.workName || work.workId || ''}` : '',
    materials ? `用户补充资料（可优先参考）：\n${materials}` : '',
    '',
    '【做法（最多 ' + maxSearches + ' 次搜索）】',
    `1. 用 web_search 搜索题干原文，可附加「答案」「题库」「军事理论」「选择题」等关键词；共最多 ${maxSearches} 次 web_search/web_fetch。`,
    '2. 若搜索结果页包含题干与答案，可用 web_fetch 打开该页面并抽取标准答案的选项字母。',
    '3. 只依据搜索结果作答；找不到就返回空 answers + needMaterials，**不要凭推理编答案**。',
    '4. 不要使用编码、拆字、角色扮演等任何方式规避内容审核；检索公开题库答案是合规路径。',
    '',
    '【输出 JSON（必须完全一致，只输出一个 ```json 代码块）】',
    '{"answers":{"<qid>":"A"},"sources":[{"title":"页面标题","url":"https://..."}],"needMaterials":[]}',
    '找不到答案时：{"answers":{},"sources":[],"needMaterials":["未检索到该题标准答案"]}',
    '',
    '题目：',
    '```json',
    JSON.stringify(q, null, 2),
    '```',
  ]
    .filter(Boolean)
    .join('\n');
  return `${lines}\n\n请只输出 \`\`\`json 代码块（不要其它文字）。`;
}

/** 健康检查提示词 */
export function buildCheckPrompt() {
  return '只回复两个大写字母：OK。不要调用任何工具，不要输出其它文字。';
}

/**
 * 为填空题生成“看起来合理但实际错误”的答案（目标正确率功能用）。
 * 只用于填空/主观填空型题目，不要生成正确答案。
 */
export function buildWrongAnswersPrompt({ work, questions = [], correctAnswers = {}, maxChars = 20000 } = {}) {
  const list = (questions || []).slice(0, 20).map((q) => ({
    qid: String(q.qid),
    type: q.type,
    stem: String(q.stem || q.title || '').slice(0, 500),
    blanks: Array.isArray(q.blanks) ? q.blanks.slice(0, 5) : [],
    correct: correctAnswers[String(q.qid)],
  }));
  const lines = [
    '你是命题/测试数据助手。下面是填空题及其正确答案。',
    '请为每一题生成一个“看起来像学生作答、但实际错误”的答案：',
    '- 不要给出正确答案，也不要把正确答案原样包含进去；',
    '- 答案要简短自然，符合该空的类型（数字/标识符/短语）；',
    '- 不要解释，不要输出 Markdown。',
    '',
    work ? `作业：${work.name || work.workName || work.workId || ''}` : '',
    '【输出 JSON（必须完全一致）】',
    '{"answers":{"<qid>":"错误答案"}}',
    '',
    '题目：',
    '```json',
    JSON.stringify(list, null, 2),
    '```',
  ].filter(Boolean).join('\n');
  return `${lines}\n\n请只输出 \`\`\`json 代码块（不要其它文字）。`.slice(0, maxChars);
}

/** 兼容旧命名（设计说明里写的是 buildObjectivePrompt/buildSubmissionPrompt/buildShortAnswerPrompt） */
export const buildSolveObjectivePrompt = buildObjectivePrompt;
export const buildMakeSubmissionPrompt = buildSubmissionPrompt;
