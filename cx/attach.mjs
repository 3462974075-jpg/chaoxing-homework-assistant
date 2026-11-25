/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * attach.mjs — 附件下载 / 附件上传
 *
 * 下载：带登录 Cookie 直接 HTTP GET（附件链接可能来自任务页/作答页附件 iframe）
 * 上传：作答页 UEditor 的"附件"按钮 → CDP 拦截文件选择器（Page.setInterceptFileChooserDialog）
 *       → DOM.setFileInputFiles → 等上传完成 → 尝试点"确定"插入。
 *
 * 说明：上传流程复用旧工具 cx.mjs attach 的 CDP 手法（旧工具已实测可用），
 *       但"等待上传完成/点确定"是本工具新增逻辑，**待真机验证**（开发会话不真实上传）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './session.mjs';
import { ensureLoggedIn } from './course.mjs';
import { getAttachments } from './works.mjs';
import { sleep } from './browser.mjs';

function sanitizeFilename(name, fallback = 'attachment') {
  let n = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  if (!n) n = fallback;
  if (n.length > 120) {
    const ext = path.extname(n);
    n = n.slice(0, 110) + ext;
  }
  return n;
}

function uniquePath(dir, name) {
  let base = path.join(dir, name);
  if (!fs.existsSync(base)) return base;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 500; i++) {
    const p = path.join(dir, `${stem}(${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/** 从 Content-Disposition / URL 里猜文件名 */
function guessFilename(entry, resUrl) {
  if (entry && entry.name) return entry.name;
  try {
    return decodeURIComponent(new URL(resUrl).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

function isHtmlResponse(buffer, contentType) {
  if (/text\/html/i.test(String(contentType || ''))) return true;
  const head = buffer.slice(0, 200).toString('utf8').toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

/** 未提供 url、只有 objectid 时的下载候选地址（学习通附件接口，待真机验证） */
function objectidCandidates(objectid, filename) {
  const id = encodeURIComponent(objectid);
  const fn = filename ? `&filename=${encodeURIComponent(filename)}` : '';
  return [
    `https://mooc1.chaoxing.com/ananas/attachment/attachment-download?objectid=${id}${fn}`,
    `https://mooc1.chaoxing.com/ananas/attachment/download?objectid=${id}${fn}`,
    `https://mooc1.chaoxing.com/ananas/attachment/downloadAttachment?objectid=${id}${fn}`,
  ];
}

/**
 * 下载作业附件到 outDir。
 * @param {object} p
 * @param {import('./session.mjs').SessionStore} p.session
 * @param {object} p.work 作业对象（含 taskUrl/url）
 * @param {Array} [p.attachments] 已知附件列表（openWork 返回的）；不传则现抓任务页
 * @param {string} p.outDir
 * @returns {Promise<Array<{name:string,path:string,ok:boolean,size?:number,error?:string,url?:string}>>}
 */
export async function downloadAttachments({ session, work, attachments, outDir, log = () => {} } = {}) {
  if (!outDir) throw new Error('downloadAttachments 需要 outDir');
  ensureDir(outDir);
  let list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) {
    const pageUrl = work?.taskUrl || work?.url || work?.entryUrl;
    if (!pageUrl) throw new Error('缺少作业页面地址，无法查找附件');
    const r = await session.fetch(pageUrl, { referer: work?.entryUrl || pageUrl });
    list = getAttachments(r.text, { baseUrl: r.url || pageUrl });
  }
  if (!list.length) {
    log('该作业页面上没有发现附件');
    return [];
  }

  const results = [];
  for (const item of list) {
    const urls = [];
    if (item.url && !/insertCloud\.html/i.test(item.url)) urls.push(item.url);
    if (item.objectid) urls.push(...objectidCandidates(item.objectid, item.name));
    if (!urls.length) {
      results.push({ name: item.name || '', path: '', ok: false, error: '附件没有可用的下载地址（只有 objectid，接口待真机验证）' });
      continue;
    }
    let done = false;
    let lastErr = '';
    for (const u of urls) {
      try {
        const r = await session.download(u, { referer: work?.taskUrl || work?.url || '' });
        if (!r.buffer.length) throw new Error('下载内容为空');
        if (isHtmlResponse(r.buffer, r.contentType)) throw new Error('返回的是网页而不是文件（可能未登录或链接失效）');
        const name = sanitizeFilename(guessFilename(item, r.url), `attachment-${results.length + 1}`);
        const file = uniquePath(outDir, name);
        fs.writeFileSync(file, r.buffer);
        results.push({ name, path: file, ok: true, size: r.buffer.length, url: u });
        log(`附件已下载：${name}（${(r.buffer.length / 1024).toFixed(0)} KB）`);
        done = true;
        break;
      } catch (e) {
        lastErr = e.message;
      }
    }
    if (!done) {
      results.push({ name: item.name || '', path: '', ok: false, error: lastErr || '下载失败' });
      log(`附件下载失败：${item.name || '(未命名)'} — ${lastErr}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------- 上传
// 关键：作答页里可能存在多个 iframe（insertCloud.html 是“已插入附件”展示框，没有 file input），
// 真正的上传弹窗是 attachment_new/attachment.html。旧实现只取第一个含 attachment 的 iframe，
// 会误选 insertCloud 导致“没找到附件上传的 file input”。这里统一按“有 file input 的 iframe”优先。
const FRAME_PICKER = `const pickFrame = () => {
  const frames = [...document.querySelectorAll('iframe')];
  const bySrc = (re) => frames.find((f) => re.test(String(f.src || '')));
  const hasFile = (f) => { try { const d = f.contentDocument; return !!(d && d.querySelector('input[type="file"]')); } catch (e) { return false; } };
  return bySrc(/attachment_new\\/attachment\\.html/i) || frames.find(hasFile) || bySrc(/attachment_new|attachment\\.html/i) || null;
};`;

const FIND_INPUT_JS = `(() => {
  ${FRAME_PICKER}
  const f = pickFrame();
  if (!f) return 'no-iframe';
  let d = null;
  try { d = f.contentDocument; } catch (e) { return 'cross-origin'; }
  if (!d) return 'no-doc';
  const ins = [...d.querySelectorAll('input[type="file"]')];
  if (!ins.length) return 'no-input';
  return 'ok';
})()`;

const CLICK_ATTACH_BUTTON_JS = `(() => {
  const dlg = document.querySelector('.edui-dialog.edui-for-attachment_new');
  if (dlg && dlg.offsetParent !== null) return 'already-open';
  const b = document.querySelector('.edui-for-attachment_new .edui-button-body') || document.querySelector('.edui-for-attachment_new');
  if (!b) return 'no-button';
  try { b.click(); } catch (e) { return 'click-error:' + e.message; }
  return 'clicked';
})()`;

const CLICK_FILE_INPUT_JS = `(() => {
  ${FRAME_PICKER}
  const f = pickFrame();
  if (!f) return 'no-iframe';
  let d = null;
  try { d = f.contentDocument; } catch (e) { return 'cross-origin'; }
  if (!d) return 'no-doc';
  const ins = [...d.querySelectorAll('input[type="file"]')];
  if (!ins.length) {
    const pick = d.querySelector('#pickfiles, .webuploader-pick, .jb_btn');
    if (!pick) return 'no-input';
    try { pick.click(); } catch (e) { return 'click-error:' + e.message; }
    return 'clicked-pick';
  }
  try { ins[0].click(); } catch (e) { return 'click-error:' + e.message; }
  return 'ok';
})()`;

const DIALOG_STATE_JS = `(() => {
  ${FRAME_PICKER}
  const f = pickFrame();
  let dlgText = '';
  let dlgOpen = false;
  if (f) {
    let d = null;
    try { d = f.contentDocument; } catch (e) { d = null; }
    if (d && d.body) { dlgText = (d.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400); dlgOpen = f.offsetParent !== null || dlgText.length > 0; }
  }
  const top = document.querySelector('.edui-dialog.edui-for-attachment_new');
  if (!dlgOpen && top) { dlgText = (top.innerText || '').replace(/\\s+/g, ' ').slice(0, 400); dlgOpen = top.offsetParent !== null; }
  return JSON.stringify({ dlgOpen, dlgText });
})()`;

const CONFIRM_DIALOG_JS = `(() => {
  ${FRAME_PICKER}
  const docs = [];
  const f = pickFrame();
  if (f) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} }
  docs.push(document);
  for (const d of docs) {
    const cands = [...d.querySelectorAll('a,button,div,span')].filter((e) => /^确定$/.test((e.innerText || '').trim()));
    for (const c of cands) {
      try { if (c.offsetParent !== null) { c.click(); return 'clicked'; } } catch (e) {}
    }
  }
  return 'no-confirm';
})()`;

/**
 * 直接上传：不走 WebUploader 文件对话框，而是读取 UEditor 的 fileUrl/上传参数，
 * 用页面内 fetch 以 multipart 上传，拿到 objectId 后把附件 iframe HTML 插入编辑器并 sync。
 * 实测比 CDP 操作隐藏 file input 稳定（学习通 2026 版 attachment_new 对话框）。
 */
async function tryDirectUpload(page, file, log = () => {}) {
  const b64 = fs.readFileSync(file).toString('base64');
  const name = path.basename(file);
  const ext = (path.extname(file) || '.docx').replace('.', '').toLowerCase();
  const expression = `(async () => {
    try {
      if (typeof UE === 'undefined' || !UE.instants) return JSON.stringify({ ok: false, error: 'no-UE' });
      const ids = Object.keys(UE.instants);
      const pickId = ids.find((i) => /ueditorInstant|answerEditor/.test(i)) || ids[0];
      const ed = UE.instants[pickId];
      if (!ed) return JSON.stringify({ ok: false, error: 'no-editor' });
      const fileUrl = ed.getOpt('fileUrl');
      if (!fileUrl) return JSON.stringify({ ok: false, error: 'no-fileUrl' });
      const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
      const url = fileUrl + (fileUrl.indexOf('?') > 0 ? '&' : '?') + 'source=1&enc2=' + encodeURIComponent(val('uploadEnc')) + '&t=' + encodeURIComponent(val('uploadTimeStamp')) + '&uid=' + encodeURIComponent(val('userId'));
      const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const fd = new FormData();
      fd.append('upfile', new File([bin], ${JSON.stringify(name)}, { type: 'application/octet-stream' }));
      const res = await fetch(url, { method: 'POST', body: fd, credentials: 'include' });
      const text = await res.text();
      let j = null;
      try { j = JSON.parse(text); } catch (e) { return JSON.stringify({ ok: false, error: 'bad-json', status: res.status, text: text.slice(0, 200) }); }
      const state = String(j.state || '');
      if (state.toUpperCase() !== 'SUCCESS') return JSON.stringify({ ok: false, error: 'server:' + state, status: res.status, text: text.slice(0, 300) });
      const objId = String(j.url || '').split('objectId=')[1] || String(j.objectid || '');
      if (!objId) return JSON.stringify({ ok: false, error: 'no-objectid', text: text.slice(0, 300) });
      const original = j.original || j.title || ${JSON.stringify(name)};
      const size = j.size || 0;
      let data = '';
      try { data = btoa(encodeURIComponent(JSON.stringify({ objectid: objId, name: original, type: ${JSON.stringify(ext)}, size: size }))); } catch (e) {}
      const html = '<p><br></p><div class="editor-iframe" contenteditable="false"><iframe frameborder="0" scrolling="no" src="/ananas/common-modules/attachment/insertCloud.html" class="attach-iframe" module="insertAttach" objectid="' + objId + '" filename="' + original + '" filetype="${ext}" filesize="' + size + '" name="' + data + '" style="display: block; max-width: 620px; width: 100%; height: 74px;"></iframe></div><p><br></p>';
      ed.execCommand('insertHTML', html, true);
      try { ed.sync(); } catch (e) {}
      return JSON.stringify({ ok: true, objectid: objId, url: j.url, state: state, editorChars: (ed.getContent() || '').length, file: original });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  })()`;
  const raw = await page.eval(expression, { timeoutMs: 60000 });
  const out = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!out || !out.ok) log(`直接上传未成功：${(out && out.error) || '未知'}，将回退对话框上传`);
  return out;
}

/**
 * 上传附件到作答页（UEditor 附件按钮）。
 * @param {object} p
 * @param {import('./browser.mjs').Browser} p.browser
 * @param {import('./session.mjs').SessionStore} p.session
 * @param {object} p.work
 * @param {string} p.filePath 本地文件
 * @param {number} [p.timeoutMs] 等待上传完成，默认 120000
 * @returns {Promise<{ok:boolean, uploaded:boolean, dialogText:string, raw:object}>}
 */
export async function uploadAttachment({ browser, session, work, filePath, timeoutMs = 120000, log = () => {} } = {}) {
  const file = path.resolve(String(filePath || ''));
  if (!filePath || !fs.existsSync(file)) throw new Error(`要上传的文件不存在：${filePath}`);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`要上传的文件不是有效文件：${file}`);

  const page = await ensureLoggedIn(browser, session, { log });
  const target = work?.taskUrl || work?.url;
  if (!target) throw new Error('uploadAttachment 需要作业作答页地址（taskUrl）');
  let cur = '';
  try {
    cur = String(await page.url());
  } catch {
    cur = '';
  }
  if (cur !== target) await page.navigate(target, { settleMs: 1500 });

  // 首选：直接调用上传接口 + 插入编辑器（避免隐藏 file input/WebUploader 兼容问题）
  try {
    const direct = await tryDirectUpload(page, file, log);
    if (direct && direct.ok) {
      log(`✓ 附件已直接上传并插入编辑器：${direct.file || path.basename(file)}（objectId=${direct.objectid}）`);
      await sleep(800);
      return { ok: true, uploaded: true, direct: true, dialogText: '', raw: direct };
    }
  } catch (e) {
    log(`直接上传异常（回退对话框）：${e.message}`);
  }

  // 拦截文件选择器
  await page.cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, page.sid, 10000).catch((e) => {
    throw new Error(`无法启用文件选择器拦截：${e.message}`);
  });
  let chooser = null;
  const onChooser = (params) => {
    chooser = params;
  };
  page.cdp.on('Page.fileChooserOpened', onChooser);

  const opened = await page.eval(CLICK_ATTACH_BUTTON_JS, { timeoutMs: 15000 });
  log('附件对话框:', opened);
  if (String(opened).startsWith('no-button')) {
    throw new Error('页面上没有"附件"按钮（该作业可能不支持附件上传，或页面改版）');
  }
  await sleep(2500);

  let setResult = '';
  const state = await page.eval(FIND_INPUT_JS, { timeoutMs: 15000 }).catch(() => 'eval-error');
  log('附件上传框状态:', state);
  const clicked = await page.eval(CLICK_FILE_INPUT_JS, { timeoutMs: 15000 }).catch((e) => 'eval-error:' + e.message);
  log('点击文件选择框:', clicked);
  for (let i = 0; i < 40 && !chooser; i++) await sleep(250);
  if (chooser && chooser.backendNodeId) {
    await page.cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId: chooser.backendNodeId }, page.sid, 20000);
    setResult = 'chooser-backendNodeId';
  } else {
    // 兜底：直接对“真正含 file input 的 iframe”设文件（insertCloud.html 展示框没有 input，必须跳过）
    try {
      await page.cdp.send('DOM.enable', {}, page.sid, 10000).catch(() => {});
      const r = await page.cdp.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const frames = [...document.querySelectorAll('iframe')];
            const byFile = frames.find((f) => { try { const d = f.contentDocument; return !!(d && d.querySelector('input[type="file"]')); } catch (e) { return false; } });
            const bySrc = frames.find((f) => /attachment_new\\/attachment\\.html/i.test(String(f.src || '')));
            const f = byFile || bySrc;
            if (!f) return null;
            let d = null; try { d = f.contentDocument; } catch (e) { return null; }
            return d ? d.querySelector('input[type="file"]') : null;
          })()`,
          returnByValue: false,
        },
        page.sid,
        15000
      );
      const objectId = r && r.result && r.result.objectId;
      if (!objectId) throw new Error('没找到附件上传的 file input（对话框可能没打开）');
      await page.cdp.send('DOM.setFileInputFiles', { files: [file], objectId }, page.sid, 20000);
      setResult = 'objectId';
      // 部分 WebUploader 版本不会自动触发 change，补一下
      await page.eval(`(() => {
        const frames = [...document.querySelectorAll('iframe')];
        for (const f of frames) {
          try { const d = f.contentDocument; if (!d) continue; const i = d.querySelector('input[type="file"]'); if (i) { i.dispatchEvent(new Event('change', { bubbles: true })); return 'change'; } } catch (e) {}
        }
        return 'none';
      })()`, { timeoutMs: 8000 }).catch(() => {});
    } catch (e) {
      throw new Error(`没能把文件交给上传框（可能页面改版）：${e.message}`);
    }
  }
  log(`已选择文件：${path.basename(file)}，等待上传完成…`);

  const t0 = Date.now();
  let dialogText = '';
  let finished = false;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1200);
    let st;
    try {
      st = await page.evalJson(DIALOG_STATE_JS, { timeoutMs: 10000 });
    } catch {
      st = null;
    }
    if (!st) continue;
    dialogText = st.dlgText || '';
    if (!st.dlgOpen) {
      // 对话框自己关了：有的页面上传成功会自动插入
      finished = true;
      break;
    }
    if (/上传完成|上传成功|已上传|100%/.test(dialogText) && !/上传中|正在上传|等待上传|0%/.test(dialogText)) {
      finished = true;
      break;
    }
  }
  if (!finished) {
    throw new Error(`等待附件上传完成超时（${Math.round(timeoutMs / 1000)} 秒）。对话框状态：${dialogText.slice(0, 160) || '(无)'}`);
  }
  const confirmed = await page.eval(CONFIRM_DIALOG_JS, { timeoutMs: 10000 }).catch(() => 'eval-error');
  log('点击"确定"插入附件:', confirmed);
  await sleep(1200);
  return {
    ok: true,
    uploaded: true,
    dialogText,
    raw: { opened, clicked, setResult, confirmed, file: path.basename(file), size: stat.size },
  };
}

export default { downloadAttachments, uploadAttachment };
