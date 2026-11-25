/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * works.mjs — 作业列表 / 打开作业 / 抓题 / 附件列表
 *
 * 兼容性要点（旧工具 README「实现要点」）：
 *   - 课程页的"作业"标签是 javascript:void(0) + data-url，点开后内容在 iframe 里；
 *     点一下标签拿到 iframe 真实 URL，再带 Cookie HTTP GET 解析 <li onclick="goTask(this);" data="...">
 *   - 解析要抗改版：goTask 单/双引号、属性顺序、空白变化都兼容，正则失败再回退
 *   - 作答页题目：div.questionLi[data=<qid>]，选项 .answerBg（data 为真实字母），
 *     填空 input[name=tiankongsize<qid>] 给出空数，UEditor 名为 answerEditor<qid><n>
 *   - 数学题：img.ans-latex-moudle[data] 是 encodeURIComponent 后的 JSON 字符串，解码即公式文本
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureLoggedIn, getCoursePageParams } from './course.mjs';

// ---------------------------------------------------------------- 文本工具
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const k = code.toLowerCase();
    return k in ENTITIES ? ENTITIES[k] : m;
  });
}

export function stripTags(s) {
  return decodeEntities(
    String(s || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(p|div|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

export function cleanText(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function absUrl(u, base) {
  try {
    return new URL(decodeEntities(u), base || 'https://mooc1.chaoxing.com/').toString();
  } catch {
    return decodeEntities(u);
  }
}

/** 从 class 属性里找指定 class 名 */
function hasClass(cls, name) {
  return new RegExp(`(^|\\s)${name}(\\s|$)`).test(String(cls || ''));
}

// ---------------------------------------------------------------- 作业列表解析
const WORK_NAME_RE = /<([a-z][a-z0-9]*)\b[^>]*class\s*=\s*["'][^"']*overHidden2[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i;
const WORK_STATUS_RE = /<([a-z][a-z0-9]*)\b[^>]*class\s*=\s*["'][^"']*\bstatus\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i;
const WORK_TIME_RE = /<div\b[^>]*class\s*=\s*["'][^"']*(?:\btime\b|endTime)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
const LEFT_RE = /剩余\s*([0-9]+\s*(?:天|小时|分钟|秒)[^<\n]*)/;

function pickAttr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const m = String(attrs || '').match(re);
  return m ? decodeEntities(m[2]) : '';
}

/** 根据作业名猜 kind（列表页拿不到题目时的启发式，openWork 会用真实题目覆盖） */
export function guessKindFromName(name) {
  const n = String(name || '');
  if (/(附件|上传|提交文件|文件作业|大作业|报告)/.test(n)) return 'attach';
  return 'unknown';
}

/**
 * 解析作业列表 HTML（work/list 页面）。
 * 兼容：goTask(this) / goTask(this,..) / 单双引号 / 属性顺序 / 多余空白 / 换行属性。
 * @returns {Array<{workId,name,status,left,url,kind,answerId}>}
 */
export function parseWorkList(html, { baseUrl = 'https://mooc1.chaoxing.com/' } = {}) {
  const src = String(html || '');
  const out = [];
  const seen = new Set();
  const liRe = /<li\b([^>]*)>/gi;
  let m;
  while ((m = liRe.exec(src))) {
    const attrs = m[1] || '';
    if (!/goTask\s*\(\s*this\b/i.test(attrs)) continue;
    const bodyStart = m.index + m[0].length;
    let end = src.indexOf('</li>', bodyStart);
    if (end < 0) end = src.indexOf('</ul>', bodyStart);
    if (end < 0) end = Math.min(src.length, bodyStart + 4000);
    const chunk = src.slice(bodyStart, end);

    let url = pickAttr(attrs, 'data');
    if (!url) {
      const u = attrs.match(/https?:\/\/[^\s"'<>]+/i);
      if (u) url = decodeEntities(u[0]);
    }
    if (!url || !/https?:/i.test(url)) {
      const u = chunk.match(/https?:\/\/[^\s"'<>]*(?:workId=|work\/(?:task|doWork|dowork))[^\s"'<>]*/i);
      if (u) url = decodeEntities(u[0]);
    }
    if (!url) continue;
    url = absUrl(url, baseUrl);

    const workId = (url.match(/[?&]workId=(\d+)/i) || [])[1] || '';
    if (!workId || seen.has(workId)) continue;
    seen.add(workId);
    const answerId = (url.match(/[?&]answerId=(\d+)/i) || [])[1] || '';

    let name = '';
    const nm = chunk.match(WORK_NAME_RE);
    if (nm) name = cleanText(stripTags(nm[2]));
    if (!name) {
      const aria = pickAttr(attrs, 'aria-label').split(';')[0];
      name = cleanText(aria);
    }
    let status = '';
    const st = chunk.match(WORK_STATUS_RE);
    if (st) status = cleanText(stripTags(st[2]));
    if (!status) {
      const aria = pickAttr(attrs, 'aria-label').split(';')[1];
      status = cleanText(aria);
    }
    let left = '';
    const lf = cleanText(stripTags((chunk.match(WORK_TIME_RE) || [])[1] || '')).match(LEFT_RE);
    if (lf) left = lf[1].trim();
    else {
      const lf2 = cleanText(stripTags(chunk)).match(LEFT_RE);
      if (lf2) left = lf2[1].trim();
    }

    out.push({ workId, name, status, left, url, kind: guessKindFromName(name), answerId });
  }
  return out;
}

/** 页面是否是"考试列表"（不是作业列表；用于给出可读错误） */
export function isExamListPage(html) {
  const src = String(html || '');
  return /<title>\s*考试列表\s*<\/title>/i.test(src) || (/\/exam-ans\/mooc2\/exam\/exam-list/i.test(src) && !/goTask\s*\(\s*this\b/.test(src));
}

// ---------------------------------------------------------------- 作业列表获取
const WORK_IFRAME_JS = `(() => {
  const urls = [];
  const add = (u) => { if (!u) return; try { if (u.indexOf('/work/list') >= 0 && urls.indexOf(u) < 0) urls.push(u); } catch (e) {} };
  for (const f of document.querySelectorAll('iframe')) {
    try { add(f.src || ''); } catch (e) {}
    try { if (f.contentWindow && f.contentWindow.location) add(f.contentWindow.location.href); } catch (e) {}
  }
  return JSON.stringify(urls);
})()`;

const CLICK_WORK_TAB_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  let a = document.querySelector('li a[data-url*="/work"], a[data-url*="/work/list"], a[href*="/work/list"]');
  if (a) { try { a.click(); } catch (e) { return 'click-error:' + e.message; } return 'clicked'; }
  const cands = [...document.querySelectorAll('a,li,span,div')].filter((e) => /^作业(列表)?$/.test(norm(e.innerText)));
  if (cands.length) { try { cands[0].click(); } catch (e) { return 'click-error:' + e.message; } return 'clicked-text'; }
  return 'no-tab';
})()`;

/** 进入课程页 → 点"作业"标签 → 取作业列表 iframe 的真实 URL */
export async function getWorkListUrl(browser, session, course, { log = () => {} } = {}) {
  if (course.workListUrl) return course.workListUrl;
  if (!course.entryUrl) throw new Error('课程信息缺少 entryUrl，无法定位作业列表');
  const page = await ensureLoggedIn(browser, session, { log });
  await page.navigate(course.entryUrl, { settleMs: 1500 });
  const clicked = await page.eval(CLICK_WORK_TAB_JS).catch((e) => 'eval-error:' + e.message);
  log('点击"作业"标签:', clicked);
  if (String(clicked).startsWith('no-tab')) {
    throw new Error('没找到课程页的"作业"标签（页面可能改版），无法获取作业列表');
  }
  const raw = await page.waitFor(WORK_IFRAME_JS + ' && ' + WORK_IFRAME_JS + " !== '[]'", {
    timeoutMs: 20000,
    intervalMs: 800,
  }).catch(() => null);
  let urls = [];
  try {
    urls = JSON.parse(String(raw || '[]'));
  } catch {
    urls = [];
  }
  if (!urls.length) {
    // 兜底：也许点击后整页跳转到了列表页
    const cur = String(await page.url()).catch(() => '');
    if (/\/work\/list/i.test(cur)) return cur;
    throw new Error('作业列表 iframe 未加载出来（页面可能改版或网络较慢）');
  }
  return urls[0];
}

/**
 * 纯 HTTP 方式发现作业列表 URL：
 *   课程页里藏着隐藏域 workEnc / enc / cpi / t 等参数，
 *   作业列表 URL = {moocDomain}/mooc2/work/list?courseId=&classId=&cpi=&ut=&t=&stuenc=&enc=
 */
export async function discoverWorkListUrlViaHttp(session, course, { log = () => {} } = {}) {
  if (course.workListUrl) return course.workListUrl;
  const p = await getCoursePageParams(session, course, { log });
  if (!p.courseId || !p.classId || !p.workEnc) {
    throw new Error('课程页参数不全（缺少 courseId/classId/workEnc），无法拼出作业列表地址');
  }
  const base = String(p.moocDomain || 'https://mooc1.chaoxing.com').replace(/\/+$/, '');
  const q = new URLSearchParams({
    courseId: p.courseId,
    classId: p.classId,
    cpi: p.cpi || course.cpi || '',
    ut: p.ut || 's',
    t: p.t || String(Date.now()),
    stuenc: p.enc || course.enc || '',
    enc: p.workEnc,
  });
  const url = `${base}/mooc2/work/list?${q.toString()}`;
  log('HTTP 作业列表地址已拼出（课程页参数）');
  return url;
}

/**
 * 拉取某课程的作业列表。
 * 顺序：course.workListUrl（已知）→ 纯 HTTP 拼 URL → 受控浏览器点"作业"标签；
 *       拿到列表 URL 后先 HTTP GET 解析，失败再用浏览器读 DOM。
 * @param {{httpOnly?:boolean}} opts
 * @returns {Promise<Array<{workId,name,status,left,url,kind,answerId,courseId,classId,cpi,enc,courseName}>>}
 */
export async function listWorks(browser, session, course, { log = () => {}, fetchTimeoutMs = 30000, httpOnly = false } = {}) {
  if (!course || !course.entryUrl) throw new Error('listWorks 需要课程对象（含 entryUrl）');
  let listUrl = course.workListUrl || '';
  if (!listUrl) {
    try {
      listUrl = await discoverWorkListUrlViaHttp(session, course, { log });
    } catch (e) {
      if (httpOnly) throw e;
      log('HTTP 发现作业列表地址失败，改用浏览器：', e.message);
    }
  }
  if (!listUrl) listUrl = await getWorkListUrl(browser, session, course, { log });

  let works = [];
  let html = '';
  let lastStatus = 0;
  let lastUrl = '';
  try {
    const r = await session.fetch(listUrl, {
      referer: course.entryUrl,
      timeoutMs: fetchTimeoutMs,
    });
    html = r.text;
    lastStatus = r.status;
    lastUrl = r.url;
    if (/passport2\.chaoxing\.com\/login/i.test(r.url) || /(请输入手机号|手机号\/超星号|学习通密码)/.test(html.slice(0, 3000))) {
      throw new Error('登录态失效（作业列表被重定向到登录页），请重新登录');
    }
  } catch (e) {
    if (/登录态失效/.test(e.message)) throw e;
    log('HTTP 拉取作业列表失败，改用浏览器读取:', e.message);
    html = '';
  }

  if (html) works = parseWorkList(html, { baseUrl: listUrl });
  if (!works.length && httpOnly) {
    if (isExamListPage(html || '')) {
      throw new Error('该链接是"考试列表"而不是作业列表，请确认课程入口 URL（应含 /mooc2/work/list）');
    }
    const hint = cleanText(stripTags(html || '')).slice(0, 200);
    throw new Error(
      `HTTP 拉取作业列表没有解析出作业（HTTP ${lastStatus}，${String(lastUrl).slice(0, 120)}，${(html || '').length} 字节）。` +
        `列表页可能改版、enc 参数失效或课程没有作业。页面开头：${hint || '(空)'}`
    );
  }
  if (!works.length && browser && !httpOnly) {
    // 兜底：让浏览器直接打开列表页，读 DOM HTML（有些 iframe URL 带一次性参数，HTTP 拿不到）
    const page = await ensureLoggedIn(browser, session, { log });
    await page.navigate(listUrl, { settleMs: 1200 });
    const cur = String(await page.url()).catch(() => '');
    if (/passport2\.chaoxing\.com\/login/i.test(cur)) throw new Error('登录态失效（作业列表被重定向到登录页），请重新登录');
    html = await page.html();
    works = parseWorkList(html, { baseUrl: cur || listUrl });
    if (!works.length && isExamListPage(html)) {
      throw new Error('该链接是"考试列表"而不是作业列表，请确认课程入口 URL（应含 /mooc2/work/list）');
    }
  }

  return works.map((w) => ({
    ...w,
    courseId: course.courseId || '',
    classId: course.classId || '',
    cpi: course.cpi || '',
    enc: course.enc || '',
    courseName: course.name || '',
  }));
}

// ---------------------------------------------------------------- 抓题（作答页 JS）
const EXTRACT_QUESTIONS_JS = `(() => {
  const clean = (s) => (s || '')
    .replace(/\\u00a0/g, ' ')
    .replace(/\\r/g, '')
    .replace(/[ \\t]+\\n/g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
  const latexOf = (img) => {
    const d = img.getAttribute('data');
    if (!d) return '';
    let s = d;
    try { s = decodeURIComponent(s); } catch (e) {}
    try { const j = JSON.parse(s); if (typeof j === 'string') s = j; } catch (e) {}
    return String(s == null ? '' : s);
  };
  const textWithLatex = (root) => {
    if (!root) return { text: '', hasLatex: false, imgCount: 0 };
    const clone = root.cloneNode(true);
    let hasLatex = false;
    let imgCount = 0;
    try {
      clone.querySelectorAll('img').forEach((img) => {
        imgCount += 1;
        const cls = String(img.getAttribute('class') || '');
        let txt = '';
        if (/ans-latex-moudle|ans-formula-moudle|latex/i.test(cls) && img.getAttribute('data')) {
          txt = latexOf(img);
          hasLatex = true;
        } else {
          txt = img.getAttribute('alt') || '';
        }
        const span = document.createElement('span');
        span.textContent = txt ? ' ' + txt + ' ' : '';
        if (img.parentNode) img.parentNode.replaceChild(span, img);
      });
    } catch (e) {}
    return { text: clean(clone.innerText || clone.textContent || ''), hasLatex, imgCount };
  };
  const out = [];
  const nodes = [...document.querySelectorAll('.questionLi')];
  nodes.forEach((li, idx) => {
    const qid = String(li.getAttribute('data') || (li.id || '').replace(/^question/, '') || '').trim();
    if (!qid) return;
    const imageCount = li.querySelectorAll('img').length;
    const typeHint = String(li.getAttribute('typename') || li.getAttribute('typeName') || '').trim();
    const shallow = li.querySelector('.colorShallow');
    const typename = clean((typeHint || (shallow ? shallow.innerText : '') || '').replace(/[()（）\\s]/g, ''));
    const h3 = li.querySelector('h3');
    let stem = '';
    let latex = false;
    if (h3) {
      const c = h3.cloneNode(true);
      c.querySelectorAll('.colorShallow').forEach((n) => { if (n.parentNode) n.parentNode.removeChild(n); });
      const r = textWithLatex(c);
      stem = r.text.replace(/^\\s*\\d+\\s*[.、]\\s*/, '').replace(/^\\s*[一二三四五六七八九十]+\\s*[.、]\\s*/, '');
      latex = r.hasLatex;
    }
    let opts = [...li.querySelectorAll('.answerBg')].map((o) => {
      const numEl = o.querySelector('.num_option') || o.querySelector('[class*="num_option"]');
      let key = '';
      if (numEl) key = String(numEl.getAttribute('data') || clean(numEl.innerText) || '').trim();
      if (!key) {
        const m = (o.getAttribute('aria-label') || '').trim().match(/^([A-Za-z])\\s/);
        if (m) key = m[1];
      }
      let text = '';
      const p = o.querySelector('.answer_p') || o.querySelector('[class*="answer_p"]');
      if (p) {
        const r2 = textWithLatex(p);
        text = r2.text;
        if (r2.hasLatex) latex = true;
      } else {
        const r2 = textWithLatex(o);
        text = r2.text.replace(/^[A-Za-z]\\s*[.、]\\s*/, '');
        if (r2.hasLatex) latex = true;
      }
      return { key, text };
    });
    if (!opts.length) {
      const lis = [...li.querySelectorAll('ul.mark_letter li, ul.qtDetail li, .stem_answer > li')];
      opts = lis.map((x) => {
        const r2 = textWithLatex(x);
        if (r2.hasLatex) latex = true;
        const m = r2.text.match(/^([A-Za-z])\\s*[.、:：]?\\s*/);
        return { key: m ? m[1] : '', text: clean(m ? r2.text.slice(m[0].length) : r2.text) };
      }).filter((o) => o.key || o.text);
    }
    const ansTypeEl = li.querySelector('input[id^="answertype"]');
    const ansType = ansTypeEl ? String(ansTypeEl.value || '') : '';
    let blankCount = 0;
    li.querySelectorAll('input[name^="tiankongsize"]').forEach((i) => {
      const n = parseInt(i.value, 10);
      if (Number.isFinite(n) && n > blankCount) blankCount = n;
    });
    const editorNames = [];
    li.querySelectorAll('textarea[id^="answerEditor"], [id^="answerEditor"]').forEach((t) => {
      const id = t.id || '';
      const mm = id.match(/^answerEditor(\\d+)(\\d+)$/);
      if (mm && String(mm[1]) === qid) editorNames.push(parseInt(mm[2], 10));
    });
    if (!blankCount && editorNames.length) blankCount = Math.max(...editorNames);
    const blanks = [];
    for (let i = 1; i <= blankCount; i++) blanks.push('');
    const attachIframes = [...li.querySelectorAll('iframe.attach-iframe, iframe[module="insertAttach"], iframe[src*="attachment"]')];
    const attachments = attachIframes.map((f) => {
      let fn = f.getAttribute('filename') || '';
      try { fn = decodeURIComponent(fn); } catch (e) {}
      return { name: fn, objectid: f.getAttribute('objectid') || '', src: f.getAttribute('src') || '' };
    }).filter((a) => a.name || a.objectid);
    const hasEditor = Boolean(li.querySelector('textarea[id^="answer"], .edui-editor, .edui-for-attachment_new'));
    const hasAttachment = attachments.length > 0;
    let type = 'other';
    if (/多选/.test(typename)) type = 'multi';
    else if (/判断/.test(typename)) type = 'judge';
    else if (/单选/.test(typename)) type = 'single';
    else if (/填空|完形/.test(typename)) type = 'blank';
    else if (/简答|论述|名词|计算|分析|程序|设计|问答|翻译|写作|材料|实践|案例/.test(typename)) type = 'short';
    else if (/其它|其他/.test(typename)) type = hasAttachment ? 'attach' : 'short';
    if (type === 'other') {
      if (opts.length) {
        const isJudgeOpt = opts.length === 2 && opts.every((o) => /^(正确|错误|对|错|true|false|√|×)$/i.test(String(o.text || '').trim()));
        if (isJudgeOpt) type = 'judge';
        else type = ansType === '1' ? 'multi' : 'single';
        if (ansType === '1' && opts.length > 2) type = 'multi';
      } else if (blankCount) type = 'blank';
      else if (hasAttachment) type = 'attach';
      else if (hasEditor) type = 'short';
    }
    if (type === 'multi' && opts.length && ansType === '0') type = 'single';
    out.push({
      qid,
      type,
      typename,
      stem,
      opts,
      blanks,
      blankCount,
      latex,
      imageCount,
      attachments,
      required: !/选做|可不答|不要求/.test(stem),
      index: idx + 1,
    });
  });
  return JSON.stringify(out);
})()`;

/**
 * 从作答页抓题：优先用页面 DOM（在原页面里执行 JS，样式/懒加载都真实）；
 * 页面 JS 失败或没抓到题时，回退到纯 HTML 解析（parseQuestionsFromHtml）。
 */
export async function extractQuestions(page) {
  let list = [];
  let jsErr = null;
  let raw = null;
  try {
    raw = await page.evalJson(EXTRACT_QUESTIONS_JS, { timeoutMs: 30000 });
    if (Array.isArray(raw)) list = raw;
  } catch (e) {
    jsErr = e;
  }
  if (!list.length) {
    try {
      const html = await page.html();
      const fallback = parseQuestionsFromHtml(html);
      if (fallback.length) {
        if (jsErr) console.warn('[cx] 页面 JS 抓题失败，已用 HTML 解析兜底:', jsErr.message);
        list = fallback;
      }
    } catch (e) {
      if (jsErr) throw jsErr;
      throw e;
    }
  }
  if (!Array.isArray(list)) throw new Error('抓题失败：页面返回的数据格式不对');
  return list
    .filter((q) => q && q.qid)
    .map((q) => ({
      qid: String(q.qid),
      type: String(q.type || 'other'),
      typename: String(q.typename || ''),
      stem: String(q.stem || ''),
      opts: Array.isArray(q.opts) ? q.opts.map((o) => ({ key: String(o.key || ''), text: String(o.text || '') })) : [],
      blanks: Array.isArray(q.blanks) ? q.blanks : [],
      latex: Boolean(q.latex),
      imageCount: Number(q.imageCount) || 0,
      attachments: Array.isArray(q.attachments) ? q.attachments : [],
      required: q.required !== false,
    }));
}

// ---------------------------------------------------------------- 附件列表
const DOWNLOADISH_RE = /(downloadData|download|\/attach|attachment|\/ananas\/|insertCloud|\.(?:docx?|xlsx?|pptx?|pdf|zip|rar|7z|txt|csv|xls|ppt)(?:[?#]|$))/i;

function parseAttrs(attrText) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  let m;
  while ((m = re.exec(String(attrText || '')))) out[m[1].toLowerCase()] = decodeEntities(m[3]);
  return out;
}

/**
 * 从作答页（或任务页）HTML 里提取附件下载链接。
 * @returns {Array<{name:string,url:string,objectid?:string,size?:string,source:string}>}
 */
export function getAttachments(html, { baseUrl = 'https://mooc1.chaoxing.com/' } = {}) {
  const src = String(html || '');
  const out = [];
  const seen = new Set();
  const add = (item) => {
    const key = (item.url || '') + '|' + (item.objectid || '') + '|' + item.name;
    if (seen.has(key)) return;
    if (!item.url && !item.objectid) return;
    // 同一个 URL 只保留一条（后面的裸 URL 兜底常常是前面的重复）
    if (item.url) {
      const dup = out.find((x) => x.url && x.url === item.url);
      if (dup) {
        if (!dup.name && item.name) dup.name = item.name;
        if (!dup.objectid && item.objectid) dup.objectid = item.objectid;
        return;
      }
    }
    seen.add(key);
    out.push(item);
  };

  // 1) UEditor 附件 iframe：filename / objectid / filetype
  const tagRe = /<(iframe|a|div|span|li|p|input)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(src))) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    const cls = attrs.class || '';
    if (tag === 'iframe' && (/attach-iframe/.test(cls) || attrs.module === 'insertAttach' || /attachment/i.test(attrs.src || ''))) {
      let name = attrs.filename || '';
      if (!name) {
        const u = attrs.src || '';
        name = u.split('/').pop().split('?')[0];
      }
      add({
        name,
        url: attrs.src ? absUrl(attrs.src, baseUrl) : '',
        objectid: attrs.objectid || '',
        size: attrs.size || attrs.filesize || '',
        source: 'attach-iframe',
      });
      continue;
    }
    if (tag === 'a') {
      const href = attrs.href || '';
      if (!href || /^javascript:/i.test(href)) continue;
      const text = '';
      // 取 <a ...>后面到 </a> 的文字
      const end = src.indexOf('</a>', tagRe.lastIndex);
      const inner = end > 0 ? src.slice(tagRe.lastIndex, Math.min(end, tagRe.lastIndex + 600)) : '';
      const name = cleanText(stripTags(inner)) || attrs.title || '';
      if (!DOWNLOADISH_RE.test(href) && !DOWNLOADISH_RE.test(name)) continue;
      if (name.length > 200) continue;
      add({ name, url: absUrl(href, baseUrl), size: '', source: 'link' });
    }
  }

  // 2) 兜底：HTML 里裸出现的学习通下载 URL
  const urlRe = /https?:\/\/[^\s"'<>\\]+/gi;
  while ((m = urlRe.exec(src))) {
    const u = decodeEntities(m[0]).replace(/[),.;]+$/, '');
    if (!DOWNLOADISH_RE.test(u)) continue;
    if (/\.(?:js|css|png|jpe?g|gif|svg)(?:[?#]|$)/i.test(u) && !/download/i.test(u)) continue;
    let name = '';
    try {
      const q = new URL(u).searchParams;
      name = q.get('filename') || q.get('name') || q.get('fileName') || '';
    } catch {
      /* ignore */
    }
    if (!name) {
      try {
        name = decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
      } catch {
        name = '';
      }
    }
    if (!name || /^(attachment|insertCloud|downloadData)/i.test(name)) name = '';
    add({ name, url: u, size: '', source: 'raw-url' });
  }

  return out;
}

// ---------------------------------------------------------------- 纯 HTML 抓题（离线可测 / 页面 JS 失败时兜底）
const LATEX_IMG_TAG_RE = /<img\b[^>]*>/gi;

function attrOf(tag, name) {
  const m = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return m ? decodeEntities(m[2]) : '';
}

/** 解码 img.ans-latex-moudle 的 data（encodeURIComponent 后的 JSON 字符串） */
export function decodeLatexData(data) {
  let s = String(data || '');
  if (!s) return '';
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 可能没编码 */
  }
  try {
    const j = JSON.parse(s);
    if (typeof j === 'string') s = j;
  } catch {
    /* 不是 JSON 就用原串 */
  }
  return String(s == null ? '' : s);
}

/** 把一段 HTML 转成纯文本：公式图片替换成 LaTeX 源码，其他图片用 alt */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(LATEX_IMG_TAG_RE, (tag) => {
    if (/ans-latex-moudle|ans-formula-moudle/i.test(tag)) {
      const f = decodeLatexData(attrOf(tag, 'data'));
      // 防止 LaTeX 里的 < > & 被当成标签
      return f ? ` ${f.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')} ` : ' ';
    }
    const alt = attrOf(tag, 'alt');
    return alt ? ` ${alt} ` : ' ';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|span)>/gi, '\n');
  return cleanText(stripTags(s));
}

/** 统一的题型推断（页面 JS 与纯 HTML 解析共用同一套规则） */
export function inferQuestionType({ typename = '', opts = [], blankCount = 0, ansType = '', hasEditor = false, hasAttachment = false } = {}) {
  const tn = String(typename || '').replace(/[()（）\s]/g, '');
  let type = 'other';
  if (/多选/.test(tn)) type = 'multi';
  else if (/判断/.test(tn)) type = 'judge';
  else if (/单选/.test(tn)) type = 'single';
  else if (/填空|完形/.test(tn)) type = 'blank';
  else if (/简答|论述|名词|计算|分析|程序|设计|问答|翻译|写作|材料|实践|案例/.test(tn)) type = 'short';
  else if (/其它|其他/.test(tn)) type = hasAttachment ? 'attach' : 'short';
  if (type === 'other') {
    if (opts.length) {
      const isJudgeOpt = opts.length === 2 && opts.every((o) => /^(正确|错误|对|错|true|false|√|×)$/i.test(String(o.text || '').trim()));
      if (isJudgeOpt) type = 'judge';
      else type = ansType === '1' ? 'multi' : 'single';
      if (ansType === '1' && opts.length > 2) type = 'multi';
    } else if (blankCount) type = 'blank';
    else if (hasAttachment) type = 'attach';
    else if (hasEditor) type = 'short';
  }
  if (type === 'multi' && opts.length && ansType === '0') type = 'single';
  return type;
}

function extractQuestionAttachments(block) {
  const out = [];
  const re = /<iframe\b[^>]*>/gi;
  let m;
  while ((m = re.exec(block))) {
    const tag = m[0];
    const cls = attrOf(tag, 'class');
    const module = attrOf(tag, 'module');
    const src = attrOf(tag, 'src');
    if (!/attach-iframe/.test(cls) && !/insertAttach/i.test(module) && !/attachment/i.test(src)) continue;
    const name = attrOf(tag, 'filename') || src.split('/').pop().split('?')[0] || '';
    out.push({ name, objectid: attrOf(tag, 'objectid'), src });
  }
  return out;
}

/**
 * 从作答页/详情页 HTML 里解析题目（不依赖 DOM，离线单测用；页面 JS 失败时兜底）。
 * @returns {Array<{qid,type,typename,stem,opts,blanks,latex,attachments,required}>}
 */
export function parseQuestionsFromHtml(html) {
  const src = String(html || '');
  const startRe = /<div\b[^>]*class\s*=\s*["'][^"']*\bquestionLi\b[^"']*["'][^>]*>/gi;
  const marks = [];
  let m;
  while ((m = startRe.exec(src))) marks.push({ index: m.index, end: startRe.lastIndex, tag: m[0] });
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    let block = src.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].index : src.length);
    // 最后一个题目的 block 会拖到页面尾部：截到右侧答题卡/下一个大题标题为止
    const cut = block.search(/<div\b[^>]*class\s*=\s*["'][^"']*(?:fanyaMarking_right|mark_table)[^"']*["']|id\s*=\s*["']rightHeight|class\s*=\s*["'][^"']*type_tit/i);
    if (i + 1 >= marks.length && cut > 0) block = block.slice(0, cut);

    const attrs = parseAttrs(marks[i].tag.replace(/^<div\b/i, '').replace(/>\s*$/, ''));
    const qid = String(attrs.data || String(attrs.id || '').replace(/^question/, '')).trim();
    if (!qid) continue;

    let typename = String(attrs.typename || attrs.typname || '').trim();
    if (!typename) {
      const cs = block.match(/<([a-z]+)\b[^>]*class\s*=\s*["'][^"']*\bcolorShallow\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i);
      if (cs) typename = cleanText(stripTags(cs[2]));
    }
    typename = typename.replace(/[()（）]/g, '').trim();

    let stem = '';
    const h3 = block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    if (h3) stem = htmlToText(h3[1].replace(/<span\b[^>]*class\s*=\s*["'][^"']*\bcolorShallow\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, ''));
    if (!stem) {
      const qt = block.match(/<span\b[^>]*class\s*=\s*["'][^"']*\bqtContent\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
      if (qt) stem = htmlToText(qt[1]);
    }
    stem = stem.replace(/^\s*\d+\s*[.、]\s*/, '').replace(/^\s*[一二三四五六七八九十]+\s*[.、]\s*/, '').trim();

    const opts = [];
    const numRe = /<(span|div|i)\b[^>]*class\s*=\s*["'][^"']*\bnum_option\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
    let nm;
    while ((nm = numRe.exec(block))) {
      const tag = nm[0].slice(0, nm[0].indexOf('>') + 1);
      const key = String(attrOf(tag, 'data') || cleanText(stripTags(nm[2]))).trim();
      const rest = block.slice(nm.index + nm[0].length);
      // answer_p 内部是多个 <p>，要取到它的结束 </div>，不能取第一个 </p>
      const apStart = rest.search(/class\s*=\s*["'][^"']*\banswer_p\b[^"']*["'][^>]*>/i);
      let text = '';
      if (apStart >= 0) {
        const after = rest.slice(apStart);
        const gt = after.indexOf('>');
        const body = after.slice(gt + 1);
        const close = body.search(/<\/div>/i);
        text = htmlToText(close >= 0 ? body.slice(0, close) : body.slice(0, 2000));
      }
      opts.push({ key, text });
    }
    if (!opts.length) {
      // 已批阅/详情页：<ul class="mark_letter"><li>A. ...</li>
      const ul = block.match(/<ul\b[^>]*class\s*=\s*["'][^"']*(?:mark_letter|qtDetail)[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
      if (ul) {
        const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
        let lm;
        while ((lm = liRe.exec(ul[1]))) {
          const t = htmlToText(lm[1]);
          const km = t.match(/^([A-Za-z])\s*[.、:：]?\s*/);
          opts.push({ key: km ? km[1] : '', text: cleanText(km ? t.slice(km[0].length) : t) });
        }
      }
    }
    if (!opts.length) {
      // 兜底：.answerBg（aria-label 形如 "A 选项文本选择"）
      const bgRe = /<div\b[^>]*class\s*=\s*["'][^"']*\banswerBg\b[^"']*["'][^>]*>/gi;
      let bm;
      while ((bm = bgRe.exec(block))) {
        const tag = bm[0];
        const end = block.indexOf('</div>', bm.index + tag.length);
        const inner = block.slice(bm.index + tag.length, end > 0 ? end : bm.index + tag.length + 800);
        const aria = attrOf(tag, 'aria-label');
        const km = aria.match(/^([A-Za-z])\s*/);
        const text = htmlToText(inner).replace(/^[A-Za-z]\s*[.、]?\s*/, '');
        if (km || text) opts.push({ key: km ? km[1] : '', text: cleanText(text) });
      }
    }

    let blankCount = 0;
    const tk = block.match(/<input\b[^>]*name\s*=\s*["']tiankongsize[^"']*["'][^>]*>/i);
    if (tk) {
      const n = parseInt(attrOf(tk[0], 'value'), 10);
      if (Number.isFinite(n)) blankCount = n;
    }
    if (!blankCount) {
      const edRe = new RegExp(`id\\s*=\\s*["']answerEditor${qid}(\\d+)["']`, 'gi');
      let em;
      const nums = [];
      while ((em = edRe.exec(block))) nums.push(parseInt(em[1], 10));
      if (nums.length) blankCount = Math.max(...nums);
    }
    const blanks = [];
    for (let k = 0; k < blankCount; k++) blanks.push('');

    const attach = extractQuestionAttachments(block);
    const ansTypeM = block.match(/id\s*=\s*["']answertype\d+["'][^>]*value\s*=\s*["']([^"']*)["']/i);
    const ansType = ansTypeM ? ansTypeM[1] : '';
    const hasEditor = /<textarea\b[^>]*id\s*=\s*["']answer\d+["']|class\s*=\s*["'][^"']*\bedui-editor\b/i.test(block);
    const type = inferQuestionType({ typename, opts, blankCount, ansType, hasEditor, hasAttachment: attach.length > 0 });

    out.push({
      qid,
      type,
      typename,
      stem,
      opts,
      blanks,
      blankCount,
      latex: /ans-latex-moudle|ans-formula-moudle/i.test(block),
      imageCount: (String(block || '').match(/<img\b/gi) || []).length,
      attachments: attach,
      required: !/选做|可不答|不要求/.test(stem),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 打开作业
/**
 * 计算作业 kind。
 * @param {Array} questions
 * @param {string} html
 * @returns {'quiz'|'attach'|'mixed'|'unknown'}
 */
export function computeKind(questions, html = '') {
  const qs = questions || [];
  const hasAttachQ = qs.some((q) => q.type === 'attach' || (q.attachments && q.attachments.length));
  const hasObjective = qs.some((q) => ['single', 'multi', 'judge', 'blank'].includes(q.type));
  const hasSubjective = qs.some((q) => ['short', 'other'].includes(q.type));
  const htmlHasUpload = /edui-for-attachment_new|type\s*=\s*["']file["']|上传附件|insertCloud/i.test(String(html || ''));
  if (hasAttachQ && (hasObjective || hasSubjective)) return 'mixed';
  if (hasAttachQ) return 'attach';
  if (!qs.length) return 'unknown';
  if (hasObjective && hasSubjective) return 'mixed';
  return 'quiz';
}

/**
 * 纯 HTTP 打开作业：GET 作业入口 URL（跟随跳转，通常直接到 /dowork 或详情页），
 * 用纯 HTML 解析器抓题。浏览器不可用时的回退路径，也可 httpOnly 模式直接用。
 */
export async function openWorkHttp(session, work, { allowView = false, log = () => {} } = {}) {
  if (!work || (!work.url && !work.entryUrl && !work.taskUrl)) throw new Error('openWork 需要作业对象（含 url）');
  const url = work.url || work.entryUrl || work.taskUrl;
  const r = await session.fetch(url, { referer: 'https://i.chaoxing.com/' });
  const finalUrl = r.url || url;
  if (/passport2\.chaoxing\.com\/login/i.test(finalUrl)) throw new Error('学习通登录态已失效，请重新登录');
  const html = r.text || '';
  const questions = parseQuestionsFromHtml(html);
  const attachments = getAttachments(html, { baseUrl: finalUrl });
  if (!questions.length) {
    const text = cleanText(stripTags(html)).slice(0, 300);
    if (isExamListPage(html)) throw new Error('打开的是考试列表页而不是作业作答页，请检查作业 URL');
    if (/已完成|已提交|待批阅|已批阅|剩余|暂无/.test(text)) {
      throw new Error(`没有进入作答页（作业可能已完成/已批阅/已截止）。页面提示：${text.slice(0, 160)}`);
    }
    throw new Error(`没有进入作业作答页（页面结构可能改版）。当前页面：${finalUrl}`);
  }
  const viewMode = !/\/dowork/i.test(finalUrl);
  if (viewMode && !allowView) log('注意：该作业打开后是"作业详情"页（已完成/待批阅），不是作答页');
  return {
    workId: String(work.workId || ''),
    name: work.name || '',
    taskUrl: finalUrl,
    entryUrl: work.url || url,
    status: work.status || '',
    questions,
    attachments,
    kind: computeKind(questions, html),
    viewMode,
    via: 'http',
  };
}

/**
 * 打开作业作答页：返回 { workId, name, taskUrl, entryUrl, status, questions, attachments, kind, viewMode }
 * @param {object} work listWorks/parseWorkList 得到的作业对象
 * @param {{allowView?:boolean, httpOnly?:boolean}} opts 已完成/待批阅作业会进入详情页（view 模式），allowView=true 时也返回题目
 */
export async function openWork(browser, session, work, { allowView = false, log = () => {}, httpOnly = false } = {}) {
  if (!work || !work.url) throw new Error('openWork 需要作业对象（含 url）');
  if (httpOnly || !browser) {
    return openWorkHttp(session, work, { allowView, log });
  }
  let browserErr = null;
  try {
    const page = await ensureLoggedIn(browser, session, { log });
    await page.navigate(work.url, { settleMs: 1500 });

    // 等题目渲染（作答页/详情页都有 .questionLi）
    const found = await page.waitFor(`document.querySelectorAll('.questionLi').length > 0`, {
      timeoutMs: 20000,
      intervalMs: 600,
    });
    const finalUrl = String(await page.url());
    const html = await page.html();
    if (!found) {
      const text = cleanText(stripTags(html)).slice(0, 300);
      if (isExamListPage(html)) throw new Error('打开的是考试列表页而不是作业作答页，请检查作业 URL');
      if (/已完成|已提交|待批阅|已批阅|剩余|暂无/.test(text)) {
        throw new Error(`没有进入作答页（作业可能已完成/已批阅/已截止）。页面提示：${text.slice(0, 160)}`);
      }
      throw new Error(`没有进入作业作答页（页面结构可能改版）。当前页面：${finalUrl}`);
    }

    const questions = await extractQuestions(page);
    const attachments = getAttachments(html, { baseUrl: finalUrl });
    const viewMode = !/\/dowork/i.test(finalUrl);
    if (viewMode && !allowView) {
      log('注意：该作业打开后是"作业详情"页（已完成/待批阅），不是作答页');
    }
    const kind = computeKind(questions, html);
    return {
      workId: String(work.workId || ''),
      name: work.name || '',
      taskUrl: finalUrl,
      entryUrl: work.url,
      status: work.status || '',
      questions,
      attachments,
      kind,
      viewMode,
      via: 'browser',
    };
  } catch (e) {
    browserErr = e;
  }
  // 浏览器不可用（沙箱/Edge 启动失败等）→ 纯 HTTP 兜底
  log('受控浏览器打开作业失败，改用纯 HTTP：', browserErr.message);
  try {
    return await openWorkHttp(session, work, { allowView, log });
  } catch (e2) {
    throw browserErr || e2;
  }
}

/**
 * v1.6：截取受控作答页的题目区域（只截题目，不截桌面/其他窗口），供公式视觉识别兜底。
 * 返回 [{ path, index, qid, width, height }]；若无法逐题截图，回退一张当前页截图。
 */
export async function captureQuestionScreenshots(browser, session, work, outDir, { log = () => {}, qids = [] } = {}) {
  if (!browser) throw new Error('captureQuestionScreenshots 需要受控浏览器');
  const target = work && (work.taskUrl || work.url);
  if (!target) throw new Error('captureQuestionScreenshots 需要作业 URL');
  const wanted = new Set((qids || []).map(String).filter(Boolean));
  fs.mkdirSync(outDir, { recursive: true });
  const page = await ensureLoggedIn(browser, session, { log, keepPage: true });
  let cur = '';
  try { cur = String(await page.url()); } catch { cur = ''; }
  if (cur !== target) await page.navigate(target, { settleMs: 1500 });
  const ok = await page.waitFor(`document.querySelectorAll('.questionLi').length > 0`, { timeoutMs: 20000, intervalMs: 500 });
  if (!ok) throw new Error('没有打开作答页，无法截图');

  const count = Number(await page.eval(`document.querySelectorAll('.questionLi').length`) || 0);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    try {
      const qid = String(await page.eval(`(() => { const n = document.querySelectorAll('.questionLi')[${i}]; return n ? (n.getAttribute('data') || '') : ''; })()`) || '');
      if (wanted.size && !wanted.has(qid)) continue;
      await page.eval(`(() => { const n = document.querySelectorAll('.questionLi')[${i}]; if (n) n.scrollIntoView({ block: 'center' }); return true; })()`);
      await new Promise((r) => setTimeout(r, 250));
      const rect = await page.evalJson(`(() => {
        const n = document.querySelectorAll('.questionLi')[${i}];
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height, qid: n.getAttribute('data') || '' };
      })()`);
      if (!rect || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) continue;
      const width = Math.max(1, Math.min(1800, Math.round(rect.w)));
      const height = Math.max(1, Math.min(5000, Math.round(rect.h)));
      if (width < 40 || height < 30) continue;
      const shot = await page.cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: Math.max(0, Number(rect.x) || 0),
          y: Math.max(0, Number(rect.y) || 0),
          width,
          height,
          scale: 1,
        },
      }, page.sid, 20000);
      const file = path.join(outDir, `question-${String(i + 1).padStart(2, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      out.push({ path: file, index: i + 1, qid: String(rect.qid || ''), width, height });
      log(`已截取第 ${i + 1} 题（${width}x${height}）`);
    } catch (e) {
      log(`第 ${i + 1} 题截图失败：${e.message}`);
    }
  }
  if (!out.length) {
    if (wanted.size) {
      log(`没有找到指定题号对应的题目（${[...wanted].join(',')}），不退回整页识别`);
      return [];
    }
    const file = path.join(outDir, 'page.png');
    await page.screenshot(file);
    out.push({ path: file, index: 0, qid: '', width: 0, height: 0 });
    log('逐题截图失败，已回退整页截图');
  }
  return out;
}

export default { parseWorkList, listWorks, openWork, openWorkHttp, extractQuestions, getAttachments, computeKind, captureQuestionScreenshots };
