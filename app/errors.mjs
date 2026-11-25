/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 错误翻译：把底层错误转成“人话 + 建议”，原始内容保留用于排障。

const RULES = [
  {
    code: 'MISSING_CREDENTIAL',
    test: /MISSING_CREDENTIAL|no API key|未找到.*API Key|缺少 API Key/i,
    title: 'AI Key 没有生效',
    hint: '请到「设置与隐私」重新保存一次 DeepSeek API Key；若仍失败，删除 data\\dsh-home 后重试。',
  },
  {
    code: 'LOOP_DETECTED',
    test: /LOOP_DETECTED|检测到检索循环|循环\/卡死|疑似检索卡死/i,
    title: 'AI 检索或生成陷入循环',
    hint: '通常是资料不足或题目太模糊。请补充题目原文/图片后重试；已答出的题不会丢失。',
  },
  {
    code: 'TIMEOUT',
    test: /TIMEOUT|超时|timed out|TimeoutError/i,
    title: '本次 AI 处理超时',
    hint: '可稍后重试；若反复超时，请检查网络，或在设置里适当调大单项超时。',
  },
  {
    code: 'MODEL_REFUSED',
    test: /MODEL_REFUSED|content[_ ]?filter|内容审核|refus/i,
    title: '题目被 AI 内容审核拒绝',
    hint: '该题不会自动作答。可在 manual-answers.json 手填，或补充题目资料后重试。',
  },
  {
    code: 'BAD_MODEL_OUTPUT',
    test: /BAD_MODEL_OUTPUT|解析失败|JSON.*解析|无法解析/i,
    title: 'AI 返回格式异常',
    hint: '通常是模型偶发输出异常。可直接重试；若反复出现，请换模型或补充资料。',
  },
  {
    code: 'PARTIAL_ANSWERS',
    test: /PARTIAL_ANSWERS|部分题目未解出|未解出题号/i,
    title: '部分题目未能解出',
    hint: '已得到的答案会保留；请按暂停提示补资料或手填缺失题号，然后点「继续」。',
  },
  {
    code: 'DOCGEN_VERIFY_FAILED',
    test: /DOCGEN_VERIFY_FAILED|生成文档读回失败|docx.*校验/i,
    title: '生成的 Word 文件校验失败',
    hint: '通常是模板结构异常。请更换模板/补充题目后重试。',
  },
  {
    code: 'ENGINE_NOT_READY',
    test: /ERR_MODULE_NOT_FOUND|Cannot find package|找不到 DSH|DSH.*未找到|AI 引擎不可用/i,
    title: 'AI 运行环境不完整',
    hint: '请运行「01_环境准备（首次）.cmd」；v1.5 会自动修复 DSH 运行目录，仍失败可重新保存 Key。',
  },
  {
    code: 'NETWORK',
    test: /ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|网络|proxy|代理/i,
    title: '网络连接失败',
    hint: '请检查网络/代理；确认能访问 DeepSeek API 与学习通。',
  },
  {
    code: 'CDP_TIMEOUT',
    test: /CDP.*超时|CDP 调用超时|Runtime\.evaluate|Page\.navigate/i,
    title: '学习通页面响应超时',
    hint: '可能是网络慢、页面改版或 Edge 卡住。请刷新作业后重试；必要时重启程序。',
  },
  {
    code: 'SUBMIT_FAILED',
    test: /提交失败|submit.*fail|无效的参数|code-1/i,
    title: '学习通提交失败',
    hint: '答案可能已保存但未提交。请打开作业页检查；若页面提示过期，请重新刷新作业后重试。',
  },
  {
    code: 'SAVE_FAILED',
    test: /暂存失败|保存.*失败/i,
    title: '学习通暂存失败',
    hint: '答案未保存到学习通。请重试，或打开作业页手动确认。',
  },
  {
    code: 'NO_ANSWERS',
    test: /answers 为空|没有可填的答案|没有可提交的答案/i,
    title: '没有可提交的答案',
    hint: '该作业可能只有附件题或答案为空。请确认附件已生成/上传，或手填答案后重试。',
  },
];

function stringifyInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message || String(input);
  if (typeof input === 'object') {
    const parts = [];
    if (input.code) parts.push(String(input.code));
    if (input.message) parts.push(String(input.message));
    if (input.detail) parts.push(typeof input.detail === 'string' ? input.detail : JSON.stringify(input.detail));
    return parts.join(' | ') || JSON.stringify(input);
  }
  return String(input);
}

export function sanitizeErrorText(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(cookie|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=***')
    .replace(/[A-Za-z0-9+/=]{80,}/g, '***')
    .slice(0, 4000);
}

export function humanizeError(input) {
  const raw = sanitizeErrorText(stringifyInput(input));
  let code = '';
  if (input && typeof input === 'object' && input.code) code = String(input.code);
  const rule = RULES.find((r) => (code && r.code === code) || r.test.test(raw));
  if (rule) {
    return { code: rule.code, message: rule.title, hint: rule.hint, raw };
  }
  // 没命中目录：保留原信息作为人话，并给通用建议
  const firstLine = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '未知错误';
  return {
    code: code || 'UNKNOWN',
    message: firstLine.slice(0, 240),
    hint: '请查看「原始详情」或 logs 目录；如果反复出现，可反馈日志给作者。',
    raw,
  };
}

export function errorSummary(input) {
  const h = humanizeError(input);
  return h.hint ? `${h.message}（${h.hint}）` : h.message;
}
