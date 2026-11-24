/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * 只读实测（用现有有效会话，不 fill / save / submit / upload / redo）
 *
 * 步骤：
 *   1. 把 `可复用的程序\学习通自动作业\state\session.json` 复制到临时 dataDir
 *   2. 无头 Edge 打开个人中心 → listCourses（课程名）
 *   3. listWorks（作业数与列表）
 *   4. openWork 一个"未交"作业 → 抓题统计（只打开页面，不写入任何答案）
 *   5. 收尾：关闭浏览器、删除临时目录（含复制的 Cookie，避免落盘留存）
 *
 * 运行：node test\readonly.test.mjs
 * 说明：会真实联网访问学习通，但只读；不会修改任何作答记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCx } from '../index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_SESSION = path.resolve(HERE, '..', '..', '..', '..', '可复用的程序', '学习通自动作业', 'state', 'session.json');
const TMP = path.join(HERE, '.tmp-readonly');
const DATA_DIR = path.join(TMP, 'data');
const PROFILE_DIR = path.join(TMP, 'edge-profile');
// 模式说明：
//  - 默认：受控 Edge（CDP）。本会话沙箱里 Node spawn 的 Edge 会因命名管道受限崩溃（0x80000003），
//    可用 CX_TEST_REUSE_PORT=<端口> 复用外部已启动的 Edge；
//  - CX_TEST_HTTP=1：纯 HTTP 模式（不启动浏览器），验证 Cookie/URL 复用与抓题解析。
const HTTP_MODE = process.env.CX_TEST_HTTP === '1';
const REUSE_PORT = Number(process.env.CX_TEST_REUSE_PORT || 0);
const PORT = REUSE_PORT || Number(process.env.CX_TEST_PORT || 9345);

const logs = [];
const log = (...args) => {
  const line = args.join(' ');
  logs.push(line);
  console.log('[test]', line);
};

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

function cleanup({ removeProfile = true } = {}) {
  try {
    // 复用外部浏览器时不能删整个 TMP（profile 正在被 Edge 使用），只删复制的 Cookie 数据目录
    if (removeProfile) {
      if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
    } else if (fs.existsSync(DATA_DIR)) {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[test] 清理临时目录失败（请手动删除）:', TMP, e.message);
  }
}

async function main() {
  if (!fs.existsSync(SRC_SESSION)) {
    throw new Error(`找不到现有登录态：${SRC_SESSION}`);
  }
  if (REUSE_PORT && !HTTP_MODE) {
    const { cdpInfo } = await import('../browser.mjs');
    const info = await cdpInfo(REUSE_PORT);
    if (!info) {
      throw new Error(
        `CX_TEST_REUSE_PORT=${REUSE_PORT}，但该端口没有运行中的受控 Edge。\n` +
          `请先在本机启动 Edge（本会话沙箱里 Node spawn 会被命名管道限制）：\n` +
          `  Start-Process msedge.exe -ArgumentList "--remote-debugging-port=${REUSE_PORT}","--user-data-dir=${PROFILE_DIR}","--no-first-run","--no-default-browser-check","--headless=new","about:blank"`
      );
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.copyFileSync(SRC_SESSION, path.join(DATA_DIR, 'session.json'));
  log(`已复制现有 session.json 到临时 data 目录${HTTP_MODE ? '；纯 HTTP 模式（不启动浏览器）' : REUSE_PORT ? '；复用端口 ' + REUSE_PORT + ' 上已启动的 Edge' : ''}`);

  const cx = await createCx({
    dataDir: DATA_DIR,
    edgeProfileDir: PROFILE_DIR,
    headless: true,
    port: PORT,
    httpOnly: HTTP_MODE,
    log,
  });
  try {
    console.log('\n[登录态]');
    const st = await cx.status();
    ok('status().loggedIn = true', st.loggedIn === true, JSON.stringify(st));
    ok('status() 有 uid', Boolean(st.uid), JSON.stringify(st));
    console.log('  savedAt =', st.savedAt, '| uid =', st.uid, '| expiresAt =', st.expiresAt);

    const online = await cx.statusOnline();
    ok('联网校验登录态仍有效', online.online === true, JSON.stringify({ online: online.online, finalUrl: online.finalUrl }));

    console.log('\n[课程列表 listCourses]');
    const courses = await cx.listCourses();
    ok('课程数 > 0', Array.isArray(courses) && courses.length > 0, `courses=${courses && courses.length}`);
    courses.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}  courseId=${c.courseId} classId=${c.classId} cpi=${c.cpi}`));
    // 优先用已知有作业的课程（state/course.json 的 courseId=204786741 高级语言程序设计）
    let knownCourseId = '';
    const knownCourseFile = path.resolve(HERE, '..', '..', '..', '..', '可复用的程序', '学习通自动作业', 'state', 'course.json');
    if (fs.existsSync(knownCourseFile)) {
      try {
        knownCourseId = JSON.parse(fs.readFileSync(knownCourseFile, 'utf8')).courseId || '';
      } catch {
        /* ignore */
      }
    }
    const course =
      courses.find((c) => knownCourseId && c.courseId === knownCourseId) ||
      courses.find((c) => /高级语言/.test(c.name)) ||
      courses.find((c) => /无人机系统概论/.test(c.name)) ||
      courses[0];
    ok('找到目标课程', Boolean(course), course && (course.name + '(' + course.courseId + ')'));
    ok('课程参数齐全（courseId/classId/cpi/entryUrl）', Boolean(course && course.courseId && course.classId && course.cpi && course.entryUrl));

    console.log('\n[作业列表 listWorks]');
    const works = await cx.listWorks(course);
    ok('作业数 > 0', Array.isArray(works) && works.length > 0, `works=${works && works.length}`);
    ok('每条作业都有 workId/name/url', works.every((w) => w.workId && w.name && w.url));
    console.log(`  课程《${course.name}》共 ${works.length} 份作业：`);
    works.slice(0, 12).forEach((w, i) => {
      console.log(`   ${String(i + 1).padStart(2)}. [${w.status}] ${w.name}  workId=${w.workId} ${w.left ? '剩余' + w.left : ''} kind=${w.kind}`);
    });

    console.log('\n[打开作业 openWork（只读，不填答）]');
    const target = works.find((w) => w.status === '未交') || works[0];
    const info = await cx.openWork(target, { allowView: true });
    ok('openWork 返回 taskUrl', Boolean(info.taskUrl), info.taskUrl);
    ok('抓题数 > 0', info.questions.length > 0, `questions=${info.questions.length}`);
    console.log(`  作业：${info.name}（workId=${info.workId}）`);
    console.log(`  作答页：${info.taskUrl}`);
    console.log(`  模式：${info.viewMode ? '作业详情页（已完成/已批阅）' : '作答页'} | kind=${info.kind}`);
    console.log(`  题目数=${info.questions.length} 附件数=${info.attachments.length}`);
    info.questions.slice(0, 5).forEach((q, i) => {
      const stem = (q.stem || '').replace(/\s+/g, ' ').slice(0, 60);
      console.log(`   Q${i + 1} qid=${q.qid} type=${q.type} opts=${q.opts.length} blanks=${q.blanks.length} latex=${q.latex} stem=${stem}`);
    });
    ok('题目对象结构正确（qid/type/opts）', info.questions.every((q) => q.qid && q.type && Array.isArray(q.opts)));
    ok('kind 是合法值', ['quiz', 'attach', 'mixed', 'unknown'].includes(info.kind), info.kind);
  } finally {
    console.log('\n[收尾] 关闭浏览器 / CDP…');
    await cx.browser.shutdown().catch(() => {});
    await cx.close().catch(() => {});
    cleanup({ removeProfile: !REUSE_PORT });
    log(REUSE_PORT ? '临时 data 目录已删除（复制的 Cookie 不残留）；外部浏览器 profile 保留，由测试外壳清理' : '临时目录已删除（复制的 Cookie 不残留）');
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  if (fail) {
    console.error('失败项：');
    failures.forEach((f) => console.error('  - ' + f));
    process.exitCode = 1;
  } else {
    console.log('只读实测全部通过 ✓');
  }
}

main().catch((e) => {
  console.error('\n[测试异常]', e && (e.stack || e.message));
  cleanup({ removeProfile: !REUSE_PORT });
  process.exit(1);
});
