/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * course.mjs — 课程列表（i.chaoxing.com/base 的 iframe 里 stucoursemiddle 链接）
 */
import { BASE_URL, hasLogin } from './session.mjs';

const COURSE_JS = `(() => {
  const out = [];
  const seen = new Set();
  const push = (a) => {
    let href = '';
    try { href = a.href || a.getAttribute('href') || ''; } catch (e) { return; }
    if (!href || href.indexOf('stucoursemiddle') < 0) return;
    if (!/^https?:/i.test(href)) return;
    const name = (a.innerText || a.textContent || a.title || '').replace(/\\s+/g, ' ').trim();
    if (!name) return;
    if (seen.has(href)) return;
    seen.add(href);
    out.push({ name, href });
  };
  const docs = [document];
  const frames = [...document.querySelectorAll('iframe'), ...document.querySelectorAll('frame')];
  for (const f of frames) {
    let d = null;
    try { d = f.contentDocument; } catch (e) { d = null; }
    if (d) docs.push(d);
  }
  for (const d of docs) {
    let links = [];
    try { links = [...d.querySelectorAll('a')]; } catch (e) { links = []; }
    links.forEach(push);
  }
  return JSON.stringify(out);
})()`;

/** 从课程入口 URL 里取 courseId/classId/cpi/enc */
export function parseCourseParams(href) {
  try {
    const q = new URL(href).searchParams;
    return {
      courseId: q.get('courseid') || q.get('courseId') || '',
      classId: q.get('clazzid') || q.get('classid') || q.get('clazzId') || '',
      cpi: q.get('cpi') || '',
      enc: q.get('enc') || '',
    };
  } catch {
    return { courseId: '', classId: '', cpi: '', enc: '' };
  }
}

async function pageLooksLikeLogin(page) {
  let url = '';
  try {
    url = String(await page.url());
  } catch {
    /* ignore */
  }
  if (/passport2\.chaoxing\.com\/login|passport2\.chaoxing\.com\/fanya/i.test(url)) return true;
  let text = '';
  try {
    text = await page.bodyText(1200);
  } catch {
    /* ignore */
  }
  if (/(请输入手机号|手机号\/超星号|学习通密码|扫码登录)/.test(text) && !/(个人中心|我的课程|课程列表|退出登录)/.test(text)) {
    return true;
  }
  return false;
}

/**
 * 确保受控浏览器里有登录态并停在个人中心；必要时把 session.json 的 Cookie 注入浏览器。
 * 登录态失效时抛中文错误。
 */
export async function ensureLoggedIn(browser, session, { log = () => {}, force = false, keepPage = false } = {}) {
  let page;
  try {
    page = await browser.ensureStarted();
  } catch (e) {
    throw new Error(`受控浏览器不可用：${e.message}`);
  }
  let cookies = [];
  try {
    cookies = await browser.cookies();
  } catch (e) {
    throw new Error(`受控浏览器连接已断开（${e.message}）。请关闭残留 Edge 后重试，或改用 httpOnly 模式`);
  }
  if (!hasLogin(cookies)) {
    const data = await session.load();
    if (!data || !hasLogin(data)) {
      throw new Error('还没有登录学习通：请先调用 login()（或确认 dataDir\\session.json 是否存在且有效）');
    }
    const n = await page.setCookies(data.cookies).catch((e) => {
      throw new Error(`注入登录 Cookie 失败：${e.message}`);
    });
    log(`已把 ${n} 个登录 Cookie 注入受控浏览器`);
    if (!n) throw new Error('登录 Cookie 注入失败（浏览器里没有登录态），请重试或改用 httpOnly 模式');
    if (!keepPage) {
      try {
        await page.navigate(BASE_URL, { settleMs: 1500 });
      } catch (e) {
        throw new Error(`打开学习通首页失败（${e.message}）。受控浏览器可能已退出，请重试`);
      }
    }
  } else if (force && !keepPage) {
    await page.navigate(BASE_URL, { settleMs: 1500 });
  } else if (!keepPage) {
    let url = '';
    try {
      url = String(await page.url());
    } catch {
      url = '';
    }
    if (!/i\.chaoxing\.com/i.test(url)) await page.navigate(BASE_URL, { settleMs: 1500 });
  }
  if (await pageLooksLikeLogin(page)) {
    throw new Error('学习通登录态已失效（页面被重定向到登录页），请重新登录');
  }
  return page;
}

/**
 * 课程列表
 * 优先用受控浏览器（个人中心 iframe 里的真实 DOM）；浏览器不可用/失败时回退纯 HTTP
 * （POST /mooc-ans/visit/courselistdata），保证在受限环境里也能工作。
 * @param {{preferHttp?:boolean, httpOnly?:boolean}} opts
 * @returns {Promise<Array<{name:string, courseId:string, classId:string, cpi:string, enc:string, entryUrl:string}>>}
 */
export async function listCourses(browser, session, { log = () => {}, preferHttp = false, httpOnly = false } = {}) {
  if (preferHttp || httpOnly) {
    try {
      const list = await listCoursesViaHttp(session, { log });
      if (list.length) return list;
      log('HTTP 课程列表为空，尝试受控浏览器…');
    } catch (e) {
      if (httpOnly) throw e;
      log('HTTP 课程列表失败，尝试受控浏览器：', e.message);
    }
  }
  if (browser) {
    try {
      return await listCoursesViaBrowser(browser, session, { log });
    } catch (e) {
      if (httpOnly) throw e;
      log('受控浏览器取课程列表失败，改用纯 HTTP：', e.message);
      return listCoursesViaHttp(session, { log });
    }
  }
  return listCoursesViaHttp(session, { log });
}

async function listCoursesViaBrowser(browser, session, { log = () => {} } = {}) {
  const page = await ensureLoggedIn(browser, session, { log, force: true });

  let raw = await page.waitFor(`(() => { try { const s = ${COURSE_JS}; return s && s !== '[]' ? s : ''; } catch (e) { return ''; } })()`, {
    timeoutMs: 30000,
    intervalMs: 1000,
  });
  if (!raw) {
    // 有的账号首页 iframe 是懒加载/跨域：再等一轮，并尝试滚动
    await page.eval('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
    raw = await page.waitFor(`(() => { try { const s = ${COURSE_JS}; return s && s !== '[]' ? s : ''; } catch (e) { return ''; } })()`, {
      timeoutMs: 15000,
      intervalMs: 1000,
    });
  }
  if (!raw) {
    const text = await page.bodyText(800).catch(() => '');
    if (/暂无课程|还没有课程|没有课程/.test(text)) return [];
    if (await pageLooksLikeLogin(page)) throw new Error('学习通登录态已失效（页面被重定向到登录页），请重新登录');
    throw new Error('没能从学习通首页取到课程列表（页面结构可能改版，或课程中心 iframe 未加载）');
  }
  const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return (list || []).map((c) => ({
    name: String(c.name || '').replace(/\s+/g, ' ').trim(),
    ...parseCourseParams(c.href),
    entryUrl: c.href,
  }));
}

// ---------------------------------------------------------------- 纯 HTTP 课程列表
const COURSE_LIST_HOSTS = ['https://mooc1-1.chaoxing.com', 'https://mooc1.chaoxing.com'];

function attrOfTag(tag, name) {
  const m = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return m ? m[2] : '';
}

/**
 * 纯 HTTP 课程列表：
 *   1) GET i.chaoxing.com/base 找课程中心入口（判断登录态 / 拿 host）
 *   2) POST /mooc-ans/visit/courselistdata 拿课程卡片 HTML
 *   3) 解析 li.course[courseId][clazzId][personId] + stucoursemiddle 链接
 */
export async function listCoursesViaHttp(session, { log = () => {} } = {}) {
  const base = await session.fetch(BASE_URL, { referer: 'https://i.chaoxing.com/' });
  if (/passport2\.chaoxing\.com\/login/i.test(base.url || '') || /(请输入手机号|手机号\/超星号|学习通密码)/.test(base.text.slice(0, 3000))) {
    throw new Error('学习通登录态已失效（首页被重定向到登录页），请重新登录');
  }
  const body = new URLSearchParams({
    courseType: '1',
    courseFolderId: '0',
    baseEducation: '0',
    superstarClass: '',
    courseFolderSize: '0',
  }).toString();
  let lastErr = '';
  for (const host of COURSE_LIST_HOSTS) {
    const api = `${host}/mooc-ans/visit/courselistdata`;
    let r;
    try {
      r = await session.fetch(api, {
        method: 'POST',
        referer: 'https://i.chaoxing.com/',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
      });
    } catch (e) {
      lastErr = e.message;
      continue;
    }
    if (!/stucoursemiddle/i.test(r.text)) {
      lastErr = `接口返回的页面不像课程列表（len=${r.text.length}）`;
      continue;
    }
    const courses = parseCourseCards(r.text, host);
    if (courses.length) {
      log(`HTTP 课程列表：${courses.length} 门课程`);
      return courses;
    }
    lastErr = '课程列表页里没解析出课程';
  }
  throw new Error(`获取课程列表失败：${lastErr || '未知原因'}`);
}

/** 解析 courselistdata 返回的课程卡片 */
export function parseCourseCards(html, host = 'https://mooc1.chaoxing.com') {
  const src = String(html || '');
  const out = [];
  const seen = new Set();
  // 找所有 <li ...> 里 class 词表包含独立 class="course" 的标签（注意 quit-course/move-to 之类不算），
  // 卡片内容区间 = 到下一张课程卡片开头（卡片内有嵌套 <li>，不能按 </li> 切）
  const allLi = /<li\b[^>]*>/gi;
  const marks = [];
  let m;
  while ((m = allLi.exec(src))) {
    const cls = attrOfTag(m[0], 'class');
    if (String(cls).split(/\s+/).includes('course')) marks.push({ index: m.index, end: allLi.lastIndex, tag: m[0] });
  }
  for (let i = 0; i < marks.length; i++) {
    const { index, end, tag } = marks[i];
    const chunkEnd = i + 1 < marks.length ? marks[i + 1].index : Math.min(src.length, end + 5000);
    const chunk = src.slice(end, chunkEnd);
    const courseId = attrOfTag(tag, 'courseId') || attrOfTag(tag, 'courseid');
    const classId = attrOfTag(tag, 'clazzId') || attrOfTag(tag, 'clazzid');
    const personId = attrOfTag(tag, 'personId') || attrOfTag(tag, 'cpi');
    if (!courseId || seen.has(courseId + '_' + classId)) continue;
    let name = '';
    const nm =
      chunk.match(/<span\b[^>]*class\s*=\s*["'][^"']*\bcourse-name\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
      chunk.match(/<span\b[^>]*class\s*=\s*["'][^"']*\boverHidden2\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    if (nm) name = cleanTextSimple(nm[1]);
    if (!name) {
      const dd = chunk.match(/<dd\b[^>]*title\s*=\s*["']([^"']+)["']/i);
      if (dd) name = dd[1];
    }
    if (!name) {
      const hrefTitle = chunk.match(/<a\b[^>]*title\s*=\s*["']([^"']+)["']/i);
      if (hrefTitle) name = hrefTitle[1];
    }
    const link = chunk.match(/<a\b[^>]*href\s*=\s*["']([^"']*stucoursemiddle[^"']*)["']/i);
    let entryUrl = link ? decodeEntitiesSimple(link[1]) : '';
    if (entryUrl && !/^https?:/i.test(entryUrl)) entryUrl = new URL(entryUrl, host).toString();
    if (!entryUrl) {
      entryUrl = `${host}/mooc-ans/visit/stucoursemiddle?courseid=${courseId}&clazzid=${classId}&vc=1&cpi=${personId}&ismooc2=1&v=2`;
    }
    seen.add(courseId + '_' + classId);
    out.push({
      name: name.replace(/\s+/g, ' ').trim(),
      courseId,
      classId,
      cpi: personId,
      enc: '',
      entryUrl,
    });
  }
  return out;
}

function cleanTextSimple(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
function decodeEntitiesSimple(s) {
  return String(s || '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

/**
 * 打开课程页，解析隐藏域参数（courseId/classId/cpi/enc/workEnc/ut/t/moocDomain），
 * 供纯 HTTP 拼作业列表 URL。返回 { courseId, classId, cpi, enc, workEnc, ut, t, moocDomain, entryUrl }
 */
export async function getCoursePageParams(session, course, { log = () => {} } = {}) {
  if (!course || !course.entryUrl) throw new Error('课程信息缺少 entryUrl');
  const r = await session.fetch(course.entryUrl, { referer: 'https://i.chaoxing.com/' });
  if (/passport2\.chaoxing\.com\/login/i.test(r.url || '')) {
    throw new Error(`打开课程页被重定向到登录页（HTTP ${r.status}，${String(r.url).slice(0, 120)}），登录态已失效，请重新登录`);
  }
  const pick = (id) => {
    const m = r.text.match(new RegExp(`id=["']${id}["'][^>]*value=["']([^"']*)["']`, 'i'));
    return m ? m[1] : '';
  };
  const params = {
    name: course.name || '',
    courseId: pick('courseid') || course.courseId || '',
    classId: pick('clazzid') || course.classId || '',
    cpi: pick('cpi') || course.cpi || '',
    enc: pick('enc') || course.enc || '',
    workEnc: pick('workEnc') || '',
    ut: pick('heardUt') || pick('ut') || 's',
    t: pick('t') || '',
    moocDomain: pick('moocDomainName') || 'https://mooc1.chaoxing.com',
    entryUrl: r.url || course.entryUrl,
  };
  const courseNameM = r.text.match(/<dd\b[^>]*title\s*=\s*["']([^"']+)["']/i);
  if (courseNameM) params.name = courseNameM[1];
  if (!params.workEnc) {
    log(`课程页参数：courseId=${params.courseId} classId=${params.classId} cpi=${params.cpi} workEnc=(空) enc=${params.enc ? '有' : '空'}`);
    throw new Error(
      `课程页里没有 workEnc 隐藏域（HTTP ${r.status}，页面 ${r.text.length} 字节，${String(r.url).slice(0, 120)}），可能课程页改版或登录态不完整`
    );
  }
  return params;
}

export default listCourses;
