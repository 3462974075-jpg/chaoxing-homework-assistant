/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * submit.mjs — 填答 / 暂存 / 提交 / 重做
 *
 * 与旧工具一致，全部复用页面自身的 jQuery 逻辑：
 *   - 答案落到隐藏域 #answer<qid>（单选/多选/判断）；填空题走 UEditor：
 *       UE.getEditor('answerEditor<qid><n>').setContent(...) + sync()，并同步 textarea
 *   - 提交：POST #submitForm 的 action，必带 ua/formType/saveStatus/version；
 *     表单里必须带 answerwqbid（即 #questionIds，题号逗号串），否则服务端返回"无效的参数：code-1"
 *   - 正式提交前页面会先 GET /work/validate，submit() 已内置
 *
 * 注意：答案格式与现有 answers JSON 兼容：
 *   { answers: { '405236745': 'A', '405220969': 'AB', '405220972': ['x=1','y=2'], '405220978': '简答正文' } }
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './session.mjs';
import { ensureLoggedIn } from './course.mjs';

export function normalizeAnswers(answers) {
  if (!answers || typeof answers !== 'object') throw new Error('answers 必须是对象');
  const map = answers.answers && typeof answers.answers === 'object' ? answers.answers : answers;
  const out = {};
  for (const [qid, val] of Object.entries(map)) {
    if (val == null) continue;
    out[String(qid)] = val;
  }
  if (!Object.keys(out).length) throw new Error('answers 为空，没有可填的答案');
  return out;
}

/**
 * 生成"填答"用的页面 JS。填空题（数组值）按空顺序写 UEditor；
 * 其他题型写隐藏域 #answer<qid>。
 */
export function buildFillJs(answers) {
  const map = answers && answers.answers ? answers.answers : answers;
  const parts = [];
  for (const [qid, val] of Object.entries(map || {})) {
    const q = String(qid);
    if (Array.isArray(val)) {
      // 填空题：answers 里给数组，按"第1空、第2空…"依次写入
      const sets = val.map((v, i) => {
        const name = `answerEditor${q}${i + 1}`;
        const s = JSON.stringify(typeof v === 'string' ? v : String(v));
        return `(function(){try{var ed=(typeof UE!=='undefined'&&UE.getEditor)?UE.getEditor(${JSON.stringify(name)}):null;if(ed&&ed.setContent){ed.setContent(${s});if(ed.sync)ed.sync();}}catch(e){}var ta=document.getElementById(${JSON.stringify(name)});if(ta&&!ta.value){ta.value=${s};}})();`;
      });
      parts.push(`${sets.join('')} r[${JSON.stringify(q)}] = 'blank x${val.length}';`);
    } else if (typeof val === 'object' && val !== null) {
      // 兼容 { value: '...' } 之类包装
      const v = String(val.value != null ? val.value : JSON.stringify(val));
      parts.push(`var e=document.getElementById(${JSON.stringify('answer' + q)}); if(e){e.value=${JSON.stringify(v)};r[${JSON.stringify(q)}]=e.value;} else {r[${JSON.stringify(q)}]='MISSING';}`);
    } else {
      const v = typeof val === 'string' ? val : String(val);
      const q = JSON.stringify(String(qid));
      const name = JSON.stringify('answer' + qid);
      // 单选/多选/判断/简答都只写隐藏域（与验证过的旧工具一致）。
      // 不使用 UE.getEditor(name)：它会给不存在的编辑器新建实例，252 题时会瞬间创建
      // 252 个编辑器导致页面卡死、/work/validate 超时。填空题仍走 UEditor（见上）。
      parts.push(
        `(function(){var v=${JSON.stringify(v)};var e=document.getElementById(${name});` +
          `if(e){e.value=v;r[${q}]=e.value;}else{r[${q}]='MISSING';}})();`
      );
    }
  }
  return `(() => { var r = {}; ${parts.join(' ')} return JSON.stringify(r); })()`;
}

/** 暂存/提交共用的表单 POST JS；isSubmit=false 时带 pyFlag=1（暂存） */
export function buildPostFormJs(isSubmit) {
  const py = isSubmit ? "''" : "'1'";
  return `(async () => {
    var f = document.getElementById('submitForm');
    if (!f) return JSON.stringify({ ok: false, error: '页面没有 submitForm' });
    var pf = document.getElementById('pyFlag');
    if (!pf) { pf = document.createElement('input'); pf.type = 'hidden'; pf.id = 'pyFlag'; pf.name = 'pyFlag'; f.appendChild(pf); }
    pf.value = ${py};
    var qids = [...document.querySelectorAll('.questionLi')].map(function (li) { return li.getAttribute('data'); }).filter(Boolean);
    var qidEl = document.getElementById('questionIds');
    if (!qidEl) { qidEl = document.createElement('input'); qidEl.type = 'hidden'; qidEl.id = 'questionIds'; qidEl.name = 'questionIds'; f.appendChild(qidEl); }
    qidEl.value = qids.join(',') + ',';
    var url = f.getAttribute('action') || '';
    if (!url) return JSON.stringify({ ok: false, error: 'submitForm 没有 action' });
    if (${!isSubmit}) url += '&pyFlag=' + pf.value;
    var ua = '';
    try { ua = (typeof clientType === 'function') ? clientType() : '1'; } catch (e) { ua = '1'; }
    var formType = '';
    try { formType = (typeof getformType === 'function') ? getformType() : '1'; } catch (e) { formType = '1'; }
    url += '&ua=' + encodeURIComponent(ua) + '&formType=' + encodeURIComponent(formType) + '&saveStatus=1&version=1';
    var data = '';
    try { data = $('#submitForm').serialize(); } catch (e) {
      var fd = new FormData(f); data = new URLSearchParams(fd).toString();
    }
    return await new Promise(function (res) {
      try {
        $.ajax({ type: 'post', url: url, data: data, dataType: 'json',
          success: function (d) { res(JSON.stringify({ ok: true, data: d })); },
          error: function (x) { res(JSON.stringify({ ok: false, status: x && x.status, text: String((x && x.responseText) || '').slice(0, 400) })); } });
      } catch (e) { res(JSON.stringify({ ok: false, error: 'jQuery 提交异常：' + e.message })); }
    });
  })()`;
}

/** 提交前的 /work/validate（页面自身会调；服务端据此认可本次提交） */
export function buildValidateJs() {
  return `(async () => { return await new Promise(function (res) {
    try {
      $.ajax({ type: 'get', url: _HOST_CP2_ + '/work/validate',
        data: { courseId: courseId, classId: classId, cpi: cpi },
        success: function (d) { res(JSON.stringify(d)); },
        error: function (x) { res(JSON.stringify({ status: 'http-' + (x && x.status) })); } });
    } catch (e) { res(JSON.stringify({ status: 'error', error: e.message })); }
  }); })()`;
}

/** 重做当前作业 */
export function buildRedoJs() {
  return `(async () => {
    return await new Promise(function (res) {
      try {
        $.ajax({ type: 'get', url: _HOST_CP2_ + '/work/phone/redo', dataType: 'json',
          data: { courseId: courseId, classId: classId, cpi: cpi, workId: workId, workAnswerId: answerId },
          success: function (d) { res(JSON.stringify(d)); },
          error: function (x) { res(JSON.stringify({ status: false, error: x && x.status })); } });
      } catch (e) { res(JSON.stringify({ status: false, error: e.message })); }
    });
  })()`;
}

function assertTaskUrl(work) {
  if (!work || !work.taskUrl) throw new Error('缺少作答页地址（taskUrl），请先调用 openWork()');
}

/** 停在作答页（必要时导航） */
async function gotoTaskPage(browser, session, work, { log = () => {} } = {}) {
  assertTaskUrl(work);
  const page = await ensureLoggedIn(browser, session, { log });
  let cur = '';
  try {
    cur = String(await page.url());
  } catch {
    cur = '';
  }
  if (cur !== work.taskUrl) await page.navigate(work.taskUrl, { settleMs: 1200 });
  const ok = await page.waitFor(`document.querySelectorAll('.questionLi').length > 0`, { timeoutMs: 15000, intervalMs: 600 });
  if (!ok) throw new Error('没有打开作业作答页（可能作业已截止或页面改版），无法填答');
  return page;
}

/** 只填答不保存（本地接口用，主要给 UI 预览/调试） */
export async function fillAnswers(browser, session, work, answers, { log = () => {} } = {}) {
  const map = normalizeAnswers(answers);
  const page = await gotoTaskPage(browser, session, work, { log });
  const filledRaw = await page.eval(buildFillJs(map), { timeoutMs: 40000 });
  let filled = {};
  try {
    filled = typeof filledRaw === 'string' ? JSON.parse(filledRaw) : filledRaw || {};
  } catch {
    filled = {};
  }
  const missing = Object.entries(filled)
    .filter(([, v]) => v === 'MISSING')
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`这些题目在页面上找不到（题号与作答页不匹配）：${missing.join(', ')}`);
  }
  log(`已填入 ${Object.keys(filled).length} 题答案`);
  return { ok: true, filled, count: Object.keys(filled).length };
}

/** 暂存（pyFlag=1）：答案保存到服务器但不提交 */
export async function save(browser, session, work, answers, { log = () => {} } = {}) {
  const map = normalizeAnswers(answers);
  const page = await gotoTaskPage(browser, session, work, { log });
  const filledRaw = await page.eval(buildFillJs(map), { timeoutMs: 40000 });
  let filled = {};
  try {
    filled = typeof filledRaw === 'string' ? JSON.parse(filledRaw) : filledRaw || {};
  } catch {
    filled = {};
  }
  const missing = Object.entries(filled)
    .filter(([, v]) => v === 'MISSING')
    .map(([k]) => k);
  if (missing.length) throw new Error(`这些题目在页面上找不到：${missing.join(', ')}`);
  await new Promise((r) => setTimeout(r, 300));
  const raw = await page.eval(buildPostFormJs(false), { timeoutMs: 60000 });
  const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!res || !res.ok || !res.data || !res.data.status) {
    throw new Error(`暂存失败：${JSON.stringify((res && (res.data || res)) || {}).slice(0, 300)}`);
  }
  return { ok: true, raw: res, filled };
}

/** 直接暂存“当前已填/已插入附件”的页面（不重新导航、不重新填答，避免冲掉刚上传的附件） */
export async function saveCurrent(browser, session, work, { log = () => {} } = {}) {
  // keepPage：绝不能在这里导航到学习通首页，否则会丢失刚才上传的附件/未保存的编辑内容
  const page = await ensureLoggedIn(browser, session, { log, keepPage: true });
  const target = work && (work.taskUrl || work.url);
  let cur = '';
  try {
    cur = String(await page.url());
  } catch {
    cur = '';
  }
  if (target && cur !== target) {
    log('当前不在作答页，暂存前先打开作答页（可能丢失未保存内容）');
    await page.navigate(target, { settleMs: 1200 });
    const ok = await page.waitFor(`document.querySelectorAll('.questionLi').length > 0`, { timeoutMs: 15000, intervalMs: 600 });
    if (!ok) throw new Error('没有打开作业作答页（可能作业已截止或页面改版），无法暂存');
  }
  await new Promise((r) => setTimeout(r, 300));
  const raw = await page.eval(buildPostFormJs(false), { timeoutMs: 60000 });
  const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!res || !res.ok || !res.data || !res.data.status) {
    throw new Error(`暂存失败：${JSON.stringify((res && (res.data || res)) || {}).slice(0, 300)}`);
  }
  return { ok: true, raw: res, saved: true };
}

/** 正式提交：先 /work/validate，再 POST 表单；返回结果并落盘记录 */
export async function submit(browser, session, work, answers, { dataDir, log = () => {} } = {}) {
  // 附件型作业可能没有任何“文字答案”（文件在 UEditor 附件里），此时允许空 answers 直接提交
  let map = {};
  try {
    map = normalizeAnswers(answers);
  } catch (e) {
    if (!/answers 为空/.test(String(e && e.message))) throw e;
    map = {};
  }
  const page = await gotoTaskPage(browser, session, work, { log });
  const filledRaw = Object.keys(map).length
    ? await page.eval(buildFillJs(map), { timeoutMs: 40000 })
    : '{}';
  let filled = {};
  try {
    filled = typeof filledRaw === 'string' ? JSON.parse(filledRaw) : filledRaw || {};
  } catch {
    filled = {};
  }
  const missing = Object.entries(filled)
    .filter(([, v]) => v === 'MISSING')
    .map(([k]) => k);
  if (missing.length) throw new Error(`这些题目在页面上找不到：${missing.join(', ')}`);

  // 与页面一致：先 /work/validate，再 POST；否则服务端只当"保存"，不生成提交记录
  let validate = null;
  try {
    const vRaw = await page.eval(buildValidateJs(), { timeoutMs: 30000 });
    validate = typeof vRaw === 'string' ? JSON.parse(vRaw) : vRaw;
  } catch (e) {
    log('警告：/work/validate 调用异常（继续尝试提交）:', e.message);
  }
  await new Promise((r) => setTimeout(r, 300));
  const raw = await page.eval(buildPostFormJs(true), { timeoutMs: 60000 });
  const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!res || !res.ok || !res.data || !res.data.status) {
    throw new Error(`提交失败：${JSON.stringify((res && (res.data || res)) || {}).slice(0, 300)}`);
  }
  let recordFile = '';
  if (dataDir) {
    try {
      ensureDir(dataDir);
      recordFile = path.join(dataDir, `submit-${work.workId || 'unknown'}-${Date.now()}.json`);
      fs.writeFileSync(
        recordFile,
        JSON.stringify(
          { workId: work.workId, name: work.name, taskUrl: work.taskUrl, filled, validate, response: res, at: new Date().toISOString() },
          null,
          2
        ),
        'utf8'
      );
    } catch (e) {
      log('提交记录落盘失败（不影响提交结果）:', e.message);
      recordFile = '';
    }
  }
  log('✓ 提交成功');
  return { ok: true, raw: res, validate, filled, recordFile };
}

/** 重做当前作业（成绩按最高分计，可用来修正错题） */
export async function redo(browser, session, work, { log = () => {} } = {}) {
  const page = await ensureLoggedIn(browser, session, { log });
  const entry = work.entryUrl || work.url || work.taskUrl;
  if (!entry) throw new Error('redo 需要作业 URL（url 或 taskUrl）');
  await page.navigate(entry, { settleMs: 1200 });
  const raw = await page.eval(buildRedoJs(), { timeoutMs: 30000 });
  const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!res || Number(res.status) !== 1) {
    throw new Error(`重做未获准：${(res && (res.msg || res.error)) || JSON.stringify(res)}`);
  }
  await new Promise((r) => setTimeout(r, 800));
  if (work.taskUrl) await page.navigate(work.taskUrl, { settleMs: 1000 });
  log('✓ 已进入新的一次作答（旧记录被覆盖，最终成绩取最高分）');
  return { ok: true, raw: res };
}

export default { fillAnswers, save, submit, redo };
