/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * 单元级 mock 验证（不联网、不开浏览器、不动真实作业）
 *
 * 覆盖：
 *   - submit.mjs 生成的页面 JS（填答 / 暂存 / 提交 / validate / redo）在 mock DOM 下行为正确
 *   - 登录密码 AES 加密可逆、不落明文
 *   - session.mjs：文件模式（旧格式兼容）与注入 sessionStore 模式（不写明文文件）
 *   - answers 校验
 *
 * 运行：node test\mock.test.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildFillJs,
  buildPostFormJs,
  buildValidateJs,
  buildRedoJs,
  normalizeAnswers,
} from '../submit.mjs';
import { encryptByAES, TRANSFER_KEY } from '../login.mjs';
import { SessionManager, hasLogin, cookieHeader, expiresAtOf } from '../session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t) {
  console.log(`\n[${t}]`);
}

// ---------------------------------------------------------------- mock DOM 工具
function makeEl(id, extra = {}) {
  return { id, name: id, value: '', tagName: 'INPUT', ...extra };
}

function runFillJs(answers) {
  const els = new Map();
  const editors = new Map();
  const synced = [];
  const document = {
    getElementById: (id) => els.get(id) || null,
    querySelectorAll: () => [],
    createElement: () => makeEl(''),
  };
  const UE = {
    getEditor(name) {
      // 默认没有编辑器；需要时由测试预先 editors.set 创建
      return editors.get(name) || null;
    },
  };
  const sandbox = { document, UE, console };
  const raw = vm.runInNewContext(buildFillJs(answers), sandbox);
  return { result: JSON.parse(raw), els, editors, synced };
}

async function runPostFormJs(isSubmit) {
  const els = new Map();
  const form = {
    id: 'submitForm',
    getAttribute: (n) => (n === 'action' ? 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/submit?courseId=204786741' : null),
    appendChild: (el) => els.set(el.id, el),
  };
  els.set('submitForm', form);
  els.set('pyFlag', makeEl('pyFlag'));
  els.set('questionIds', makeEl('questionIds'));
  const document = {
    getElementById: (id) => els.get(id) || null,
    querySelectorAll: (sel) =>
      sel === '.questionLi' ? [{ getAttribute: () => '111111' }, { getAttribute: () => '222222' }] : [],
    createElement: (t) => {
      const e = makeEl('', { tagName: String(t).toUpperCase() });
      return e;
    },
  };
  let captured = null;
  const $ = (sel) => ({
    serialize: () =>
      `questionIds=${encodeURIComponent(els.get('questionIds').value)}&answerwqbid=${encodeURIComponent(
        els.get('questionIds').value
      )}&pyFlag=${encodeURIComponent(els.get('pyFlag').value)}`,
  });
  $.ajax = (opts) => {
    captured = opts;
    opts.success({ status: true, msg: 'ok' });
  };
  const sandbox = { document, $, clientType: () => '1', getformType: () => '1', console };
  const raw = await vm.runInNewContext(buildPostFormJs(isSubmit), sandbox);
  return { result: JSON.parse(raw), captured, els };
}

async function runSimpleAjax(js, globals, response) {
  let captured = null;
  const $ = {};
  $.ajax = (opts) => {
    captured = opts;
    if (opts.success) opts.success(response);
  };
  const sandbox = { $, console, ...globals };
  const raw = await vm.runInNewContext(js, sandbox);
  return { result: JSON.parse(raw), captured };
}

// ---------------------------------------------------------------- 填答 JS
section('填答 JS（buildFillJs）');
{
  const answers = {
    answers: {
      '405236745': 'A',
      '405220969': 'AB',
      '405220972': ['x=1', 'y=2'],
      '405220978': '简答正文\n第二行',
    },
  };
  const { result, els, editors, synced } = runFillJs(answers);
  ok('填空题标记为 blank x2', result['405220972'] === 'blank x2');
  ok('无对应 DOM 时标记 MISSING', result['405236745'] === 'MISSING' && result['405220978'] === 'MISSING');

  // 2) 有 DOM（真实隐藏域 + UEditor）时验证实际写入
  const els2 = new Map();
  const editors2 = new Map();
  const synced2 = [];
  const document2 = {
    getElementById: (id) => els2.get(id) || null,
    querySelectorAll: () => [],
    createElement: () => makeEl(''),
  };
  const UE2 = {
    getEditor(name) {
      if (!editors2.has(name)) {
        editors2.set(name, {
          content: '',
          setContent(v) {
            this.content = v;
          },
          sync() {
            synced2.push(name);
          },
        });
      }
      return editors2.get(name);
    },
  };
  for (const qid of ['405236745', '405220969', '405220978']) els2.set('answer' + qid, makeEl('answer' + qid));
  const r2 = JSON.parse(vm.runInNewContext(buildFillJs(answers), { document: document2, UE: UE2, console }));
  eq('隐藏域实际值（单选）', els2.get('answer405236745').value, 'A');
  eq('隐藏域实际值（多选连写）', els2.get('answer405220969').value, 'AB');
  eq('隐藏域实际值（简答）', els2.get('answer405220978').value, '简答正文\n第二行');
  ok('单选/多选/简答都回填到结果', r2['405236745'] === 'A' && r2['405220969'] === 'AB' && r2['405220978'] === '简答正文\n第二行');
  ok('简答只写隐藏域、不创建 UEditor 实例（避免 252 题时创建大量编辑器卡死）', !editors2.has('answer405220978'));
  eq('填空两个 UEditor 都写入', editors2.get('answerEditor4052209721').content, 'x=1');
  eq('填空第二空写入', editors2.get('answerEditor4052209722').content, 'y=2');
  ok('填空 UEditor 调用 sync() 两次', synced2.filter((s) => s.startsWith('answerEditor405220972')).length === 2);
  // 引号/反斜杠安全
  const tricky = '答案是 "A" 或 \\A\\\n最后';
  const els3 = new Map();
  els3.set('answerq', makeEl('answerq'));
  JSON.parse(
    vm.runInNewContext(buildFillJs({ q: tricky }), {
      document: { getElementById: (id) => els3.get(id) || null, querySelectorAll: () => [] },
      console,
    })
  );
  eq('特殊字符答案不破坏 JS', els3.get('answerq').value, tricky);
}

// ---------------------------------------------------------------- 暂存 / 提交
section('暂存/提交 JS（buildPostFormJs）');
{
  const saved = await runPostFormJs(false);
  ok('暂存返回 ok + status', saved.result.ok === true && saved.result.data.status === true);
  ok('暂存 URL 追加 pyFlag=1', /&pyFlag=1/.test(saved.captured.url), saved.captured.url);
  ok('URL 带 saveStatus/version', /saveStatus=1/.test(saved.captured.url) && /version=1/.test(saved.captured.url));
  ok('URL 带 ua/formType', /ua=/.test(saved.captured.url) && /formType=/.test(saved.captured.url));
  eq('暂存的 pyFlag 隐藏域值为 1', saved.els.get('pyFlag').value, '1');
  eq('questionIds 拼成逗号串（含尾部逗号）', saved.els.get('questionIds').value, '111111,222222,');
  ok('answerwqbid 走序列化数据', /answerwqbid=111111%2C222222%2C/.test(saved.captured.data), saved.captured.data);
  eq('暂存是 POST', saved.captured.type, 'post');

  const submitted = await runPostFormJs(true);
  ok('提交返回 ok + status', submitted.result.ok === true && submitted.result.data.status === true);
  ok('提交 URL 不带 pyFlag 参数', !/&pyFlag=/.test(submitted.captured.url), submitted.captured.url);
  eq('提交的 pyFlag 隐藏域为空串', submitted.els.get('pyFlag').value, '');
  eq('提交的 questionIds 正确', submitted.els.get('questionIds').value, '111111,222222,');
}
{
  // 页面没有 submitForm 时给出明确错误，不崩
  const sandbox = { document: { getElementById: () => null }, console };
  const raw = await vm.runInNewContext(buildPostFormJs(true), sandbox);
  const r = JSON.parse(raw);
  ok('无 submitForm 时返回可读错误', r.ok === false && /submitForm/.test(r.error));
}

// ---------------------------------------------------------------- validate / redo
section('validate / redo JS');
{
  const { result, captured } = await runSimpleAjax(
    buildValidateJs(),
    { _HOST_CP2_: '/mooc-ans', courseId: '204786741', classId: '157314406', cpi: '578699007' },
    { status: true, code: 1 }
  );
  ok('validate 请求为 GET', captured.type === 'get');
  ok('validate URL 命中 /work/validate', /\/work\/validate$/.test(captured.url), captured.url);
  eq('validate 带 courseId', captured.data.courseId, '204786741');
  ok('validate 返回透传', result.status === true);
}
{
  const { result, captured } = await runSimpleAjax(
    buildRedoJs(),
    { _HOST_CP2_: '/mooc-ans', courseId: '1', classId: '2', cpi: '3', workId: '57986827', answerId: '55489160' },
    { status: 1, msg: 'ok' }
  );
  ok('redo URL 命中 /work/phone/redo', /\/work\/phone\/redo$/.test(captured.url), captured.url);
  eq('redo 带 workId', captured.data.workId, '57986827');
  eq('redo 带 workAnswerId', captured.data.workAnswerId, '55489160');
  ok('redo 返回 status=1 透传', Number(result.status) === 1);
}

// ---------------------------------------------------------------- 登录 AES
section('登录密码加密（encryptByAES）');
{
  const plain = 'MyP@ssw0rd-中文';
  const enc = encryptByAES(plain);
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(TRANSFER_KEY, 'utf8'), Buffer.from(TRANSFER_KEY, 'utf8'));
  const dec = Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
  eq('AES 加密可解密回原文', dec, plain);
  ok('加密结果不是明文', enc !== plain && !enc.includes(plain));
  ok('输出是 Base64', /^[A-Za-z0-9+/]+=*$/.test(enc));
  eq('密钥长度 16 字节（AES-128）', Buffer.byteLength(TRANSFER_KEY, 'utf8'), 16);
}

// ---------------------------------------------------------------- Session 存储
section('session 存储（文件模式，兼容旧格式）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-session-'));
  try {
    const sm = new SessionManager({ dataDir: dir });
    await sm.init();
    const st0 = await sm.status();
    ok('空目录 loggedIn=false', st0.loggedIn === false);
    const future = Math.floor(Date.now() / 1000) + 86400 * 30;
    const cookies = [
      { name: '_uid', value: '123456', domain: '.chaoxing.com', path: '/', expires: future, secure: false, httpOnly: false },
      { name: '_d', value: 'secret-value', domain: '.chaoxing.com', path: '/', expires: future, secure: false, httpOnly: true },
      { name: 'uf', value: 'abc', domain: 'i.chaoxing.com', path: '/', expires: future, secure: false, httpOnly: false },
      { name: 'unrelated', value: 'x', domain: 'example.com', path: '/', expires: future, secure: false, httpOnly: false },
    ];
    await sm.save(cookies);
    const file = path.join(dir, 'session.json');
    ok('文件模式写出 session.json', fs.existsSync(file));
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok('格式含 savedAt', typeof onDisk.savedAt === 'string' && onDisk.savedAt.length > 10);
    ok('格式含 cookies 数组', Array.isArray(onDisk.cookies));
    ok('只落盘 chaoxing Cookie', !onDisk.cookies.some((c) => c.name === 'unrelated'));
    ok('Cookie 字段齐全', onDisk.cookies.every((c) => ['name', 'value', 'domain', 'path', 'expires', 'secure', 'httpOnly'].every((k) => k in c)));
    const st = await sm.status();
    eq('loggedIn=true（_uid+_d）', st.loggedIn, true);
    eq('uid 正确', st.uid, '123456');
    ok('expiresAt 有值', typeof st.expiresAt === 'string' && st.expiresAt.endsWith('Z'));
    ok('cookieHeader 含 _uid', /(^|;\s)_uid=123456/.test(sm.cookieHeader()));
    ok('hasLogin() 为真', sm.hasLogin());
    await sm.clear();
    ok('clear 后文件被删除', !fs.existsSync(file));
    eq('clear 后 loggedIn=false', (await sm.status()).loggedIn, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dataDir = path.join(HERE, '.tmp-no-file');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const saved = {};
    let cleared = false;
    const store = {
      async load() {
        return saved.data || null;
      },
      async save(obj) {
        saved.data = JSON.parse(JSON.stringify(obj));
      },
      async clear() {
        cleared = true;
        saved.data = null;
      },
    };
    const sm = new SessionManager({ dataDir, store });
    await sm.init();
    ok('注入 store：初始为空', (await sm.status()).loggedIn === false);
    const cookies = [
      { name: '_uid', value: '42', domain: '.chaoxing.com', path: '/', expires: -1, secure: false, httpOnly: true },
      { name: '_d', value: 's', domain: '.chaoxing.com', path: '/', expires: -1, secure: false, httpOnly: true },
    ];
    await sm.save(cookies);
    ok('注入 store：save 走 store', Boolean(saved.data) && saved.data.cookies.length === 2);
    ok('注入 store：不写明文 session.json', !fs.existsSync(path.join(dataDir, 'session.json')));
    ok('注入 store：status.loggedIn=true', (await sm.status()).loggedIn === true);
    ok('注入 store：encrypted 标记为 true', (await sm.status()).encrypted === true);
    await sm.clear();
    ok('注入 store：clear 走 store', cleared === true);
    ok('注入 store：clear 后 loggedIn=false', (await sm.status()).loggedIn === false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
{
  const future = Math.floor(Date.now() / 1000) + 100;
  const past = Math.floor(Date.now() / 1000) - 100;
  const session = {
    cookies: [
      { name: '_uid', value: '1', domain: '.chaoxing.com', path: '/', expires: future },
      { name: 'old', value: 'x', domain: '.chaoxing.com', path: '/', expires: past },
    ],
  };
  ok('cookieHeader 跳过过期 Cookie', !/old=/.test(cookieHeader(session)));
  ok('hasLogin 需要 _uid+_d', hasLogin({ cookies: [{ name: '_uid', value: '1', domain: '.chaoxing.com' }] }) === false);
  ok('expiresAtOf 取登录 Cookie 有效期', Boolean(expiresAtOf(session)));
}

// ---------------------------------------------------------------- answers 校验
section('answers 校验');
{
  ok('空对象被拒绝', (() => {
    try {
      normalizeAnswers({});
      return false;
    } catch (e) {
      return /为空/.test(e.message);
    }
  })());
  eq('兼容 {answers:{...}} 包装', JSON.stringify(Object.keys(normalizeAnswers({ answers: { a: 'A' } }))), '["a"]');
  ok('非对象被拒绝', (() => {
    try {
      normalizeAnswers('x');
      return false;
    } catch {
      return true;
    }
  })());
}

// ---------------------------------------------------------------- 汇总
console.log(`\n结果：${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败项：');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
