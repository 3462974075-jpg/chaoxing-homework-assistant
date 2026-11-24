/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * index.mjs — 学习通核心模块统一入口（设计说明 5.1 契约）
 *
 *   const cx = await createCx({ dataDir, edgeProfileDir, log });   // 不启动浏览器，懒加载
 *   await cx.status() / cx.login() / cx.logout()
 *   await cx.listCourses() / cx.listWorks(course) / cx.openWork(work)
 *   await cx.downloadAttachments(work, outDir) / cx.fillAnswers(work, answers)
 *   await cx.submitAnswers(work, answers) / cx.uploadAttachment(work, filePath) / cx.close()
 *
 * 另外导出 save(work, answers)/redo(work)（暂存与重做，编排器可选使用）。
 * dataDir 由 app 传入（最终 <root>\data\chaoxing）；session 固定存 dataDir\session.json。
 */
import path from 'node:path';
import { Browser } from './browser.mjs';
import { SessionManager } from './session.mjs';
import { login as doLogin, LoginError } from './login.mjs';
import { listCourses } from './course.mjs';
import { listWorks, openWork } from './works.mjs';
import { fillAnswers, save as saveAnswers, submit as submitAnswers, redo as redoWork } from './submit.mjs';
import { downloadAttachments, uploadAttachment } from './attach.mjs';

function defaultLog(...args) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${t}]`, ...args);
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir 运行数据目录（不传 sessionStore 时 session.json 存这里）
 * @param {string} [opts.edgeProfileDir] 受控 Edge 的独立 profile 目录，默认 dataDir\edge-profile
 * @param {Function} [opts.log]
 * @param {number} [opts.port] CDP 端口，默认 9333（占用自动 +1）
 * @param {boolean} [opts.headless] 是否无头，默认 false（登录遇到验证需要可见窗口）
 * @param {{load:Function,save:Function,clear:Function}} [opts.sessionStore]
 *        可选的登录态存储后端（如 app 的 DPAPI 加密实现）；传入时不再写明文 session.json
 */
export async function createCx({ dataDir, edgeProfileDir, log, port, headless = false, sessionStore = null, httpOnly = false } = {}) {
  if (!dataDir) throw new Error('createCx 需要 dataDir（Cookie 与运行数据目录）');
  const logger = typeof log === 'function' ? log : defaultLog;
  const resolvedDataDir = path.resolve(dataDir);
  const session = new SessionManager({ dataDir: resolvedDataDir, store: sessionStore || null, log: logger });
  await session.init();
  const browser = new Browser({
    port: port || Number(process.env.CX_PORT || 9333),
    profileDir: edgeProfileDir ? path.resolve(edgeProfileDir) : path.join(resolvedDataDir, 'edge-profile'),
    dataDir: resolvedDataDir,
    headless: Boolean(headless),
    log: logger,
  });

  /** 最近一次 listWorks 的结果（openWork 传 workId 字符串时用） */
  const worksCache = new Map();
  /** 最近一次 openWork 的结果（downloadAttachments/fill 传 workId 时补齐字段） */
  const openedCache = new Map();

  function resolveWork(work) {
    if (!work) throw new Error('缺少作业对象（请先调用 listWorks/openWork）');
    if (typeof work === 'string') {
      const w = openedCache.get(work) || worksCache.get(work);
      if (!w) throw new Error(`未知作业 workId=${work}，请先调用 listWorks() 获取作业列表`);
      return w;
    }
    const id = String(work.workId || '');
    const cached = openedCache.get(id);
    const base = cached ? { ...cached } : {};
    return { ...base, ...work, workId: id || work.workId };
  }

  const api = {
    dataDir: resolvedDataDir,
    session,
    browser,

    /** 登录态（只读内存/后端缓存，不联网） */
    async status() {
      const st = await session.status();
      return {
        loggedIn: Boolean(st.loggedIn),
        uid: st.uid || null,
        savedAt: st.savedAt || null,
        expiresAt: st.expiresAt || null,
        cookieCount: st.cookieCount || 0,
        encrypted: Boolean(st.encrypted),
      };
    },

    /** 联网确认登录态是否仍有效（可选，慢） */
    async statusOnline() {
      const v = await session.verifyOnline();
      return { ...(await api.status()), online: Boolean(v.loggedIn), onlineCheckedAt: new Date().toISOString(), finalUrl: v.finalUrl };
    },

    /**
     * 账号密码登录（自动；遇到滑块/短信时回调 onNeedHuman）
     * @param {{username:string,password:string,onNeedHuman?:Function,timeoutMs?:number,force?:boolean}} p
     */
    async login({ username, password, onNeedHuman, timeoutMs = 300000, force = false } = {}) {
      // 登录成功后要确保浏览器里有 Cookie，因此这里先拉起浏览器（登录遇到验证时可见）；
      // httpOnly 模式下不启动浏览器（只保存 Cookie 供后续 HTTP 调用）。
      const res = await doLogin({
        username,
        password,
        session,
        browser: httpOnly ? null : browser,
        onNeedHuman,
        timeoutMs,
        dataDir: resolvedDataDir,
        log: logger,
        force,
      });
      return res;
    },

    /** 退出登录：清空登录态（文件或注入的 sessionStore）+ 清浏览器 Cookie；保留 Edge profile */
    async logout() {
      await session.clear();
      try {
        await browser.clearCookies();
      } catch (e) {
        logger('清理浏览器 Cookie 失败（可忽略）:', e.message);
      }
      try {
        browser.close();
      } catch {
        /* ignore */
      }
      openedCache.clear();
      return { ok: true };
    },

    /** 课程列表（httpOnly=true 时纯 HTTP，不启动浏览器） */
    async listCourses() {
      return listCourses(browser, session, {
        log: logger,
        preferHttp: Boolean(httpOnly),
        httpOnly: Boolean(httpOnly),
      });
    },

    /** 作业列表 */
    async listWorks(course) {
      if (!course) throw new Error('listWorks 需要课程对象（来自 listCourses）');
      const works = await listWorks(browser, session, course, { log: logger, httpOnly: Boolean(httpOnly) });
      for (const w of works) worksCache.set(String(w.workId), w);
      return works;
    },

    /**
     * 打开作业作答页并抓题
     * @param {object|string} work 作业对象或 workId
     */
    async openWork(work, opts = {}) {
      const w = resolveWork(work);
      const info = await openWork(browser, session, w, { log: logger, httpOnly: Boolean(httpOnly), ...opts });
      const merged = { ...w, ...info };
      openedCache.set(String(info.workId || w.workId), merged);
      worksCache.set(String(info.workId || w.workId), merged);
      return merged;
    },

    /** 下载附件到 outDir（openWork 后调用最省事；也可直接传 work） */
    async downloadAttachments(work, outDir) {
      const w = resolveWork(work);
      const cached = openedCache.get(String(w.workId));
      return downloadAttachments({
        session,
        work: w,
        attachments: cached && cached.attachments && cached.attachments.length ? cached.attachments : undefined,
        outDir: outDir || path.join(resolvedDataDir, 'attachments', String(w.workId || 'unknown')),
        log: logger,
      });
    },

    /** 只填答不保存 */
    async fillAnswers(work, answers) {
      return fillAnswers(browser, session, resolveWork(work), answers, { log: logger });
    },

    /** 暂存（不提交） */
    async save(work, answers) {
      const res = await saveAnswers(browser, session, resolveWork(work), answers, { log: logger });
      return res;
    },

    /** 正式提交 */
    async submitAnswers(work, answers) {
      return submitAnswers(browser, session, resolveWork(work), answers, { log: logger, dataDir: resolvedDataDir });
    },

    /** 重做当前作业 */
    async redo(work) {
      return redoWork(browser, session, resolveWork(work), { log: logger });
    },

    /** 上传附件（作答页 UEditor 附件按钮） */
    async uploadAttachment(work, filePath, opts = {}) {
      return uploadAttachment({
        browser,
        session,
        work: resolveWork(work),
        filePath,
        log: logger,
        ...opts,
      });
    },

    /** 关闭 CDP 连接（浏览器可保留） */
    async close() {
      browser.close();
      return { ok: true };
    },
  };

  return api;
}

export { LoginError };
export default createCx;
