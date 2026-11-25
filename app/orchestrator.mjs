/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 编排器：把「学习通核心(cx)」与「AI 引擎(engine)」串成作业流水线。
// 设计见 ../../设计说明.md 第 6 节。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIRS, CX_DIR, ENGINE_DIR, MODULE_ROOT, findDshBin } from './paths.mjs';
import * as accuracy from './accuracy.mjs';
import { humanizeError } from './errors.mjs';

const OBJECTIVE_TYPES = new Set(['single', 'multi', 'judge', 'blank', 'choice', 'truefalse']);
const SHORT_TYPES = new Set(['short', 'essay', 'subjective', 'answer']);

function compactWork(w) {
  return {
    workId: String(w.workId),
    courseId: w.courseId || '',
    courseName: w.courseName || '',
    name: w.name || '',
    status: w.status || '',
    left: w.left || '',
    kind: w.kind || 'unknown',
    url: w.url || '',
  };
}

function isPendingStatus(status) {
  const s = String(status || '');
  if (!s) return true;
  if (/已完成|待批阅|已批阅|已提交|已交/.test(s)) return false;
  if (/未交|未完成|待重做|未开始|未做|未提交/.test(s)) return true;
  // 未知状态：如果还有剩余时间或没有明确结论，按待办处理
  return !/完成/.test(s);
}

/** 从附件/用户资料里挑出最适合做模板的 docx（优先标题带“模板”的）。 */
function pickTemplate(files) {
  const docx = (files || []).filter((f) => /\.docx$/i.test(String(f)));
  if (!docx.length) return null;
  const preferred = docx.find((f) => /模板|template|作业/i.test(path.basename(f)));
  return preferred || docx[0];
}

export class Orchestrator {
  constructor({ config, events, jobs, loadSecrets, saveConfig, log, cxFactory, engineFactory, sessionStore }) {
    this.config = config;
    this.events = events;
    this.jobs = jobs;
    this.loadSecrets = loadSecrets;
    this.saveConfig = saveConfig;
    this.log = log || ((...a) => this.events.info(a.join(' ')));
    this.cxFactory = cxFactory || null;
    this.engineFactory = engineFactory || null;
    this.sessionStore = sessionStore || null;
    this.engineModule = null;
    this.cx = null;
    this.engine = null;
    this.running = false;
    this.stopFlag = false;
    this.pauseFlag = false;
    this.courses = [];
    this.works = [];
    this.lastRefresh = null;
    this._loginBusy = false;
  }

  async _loadCx() {
    if (this.cx) return this.cx;
    if (this.cxFactory) {
      this.cx = await this.cxFactory({ dataDir: DIRS.chaoxingData, edgeProfileDir: DIRS.edgeProfile });
      return this.cx;
    }
    const fakeCx = process.env.CX_FAKE === '1' || process.env.CX_FAKE_CX === '1';
    const modFile = fakeCx
      ? path.join(MODULE_ROOT, 'tests', 'fake', 'cx.mjs')
      : path.join(CX_DIR, 'index.mjs');
    const mod = await import(pathToFileURL(modFile).href);
    if (typeof mod.createCx !== 'function') throw new Error('cx/index.mjs 未导出 createCx');
    this.cx = await mod.createCx({
      dataDir: DIRS.chaoxingData,
      edgeProfileDir: DIRS.edgeProfile,
      sessionStore: this.sessionStore || undefined,
      httpOnly: Boolean(this.config.httpOnly) || process.env.CX_HTTP_ONLY === '1',
      log: (...a) => this.log('[cx]', ...a),
    });
    return this.cx;
  }

  async _loadEngine() {
    if (this.engine) return this.engine;
    if (this.engineFactory) {
      this.engine = await this.engineFactory({ dshHome: DIRS.dshHome });
      return this.engine;
    }
    const fakeEngine = process.env.CX_FAKE === '1' || process.env.CX_FAKE_ENGINE === '1';
    const modFile = fakeEngine
      ? path.join(MODULE_ROOT, 'tests', 'fake', 'engine.mjs')
      : path.join(ENGINE_DIR, 'index.mjs');
    const mod = await import(pathToFileURL(modFile).href);
    if (typeof mod.createEngine !== 'function') throw new Error('engine/index.mjs 未导出 createEngine');
    this.engineModule = mod;
    this.engine = await mod.createEngine({
      dshHome: DIRS.dshHome,
      dshBin: findDshBin() || process.env.CX_DSH || null,
      timeoutMs: Math.max(60, Number(this.config.engineTimeoutSec) || 300) * 1000,
      idleTimeoutMs: 180000,
      log: (...a) => this.log('[engine]', ...a),
    });
    // 关键自愈：每次创建引擎时，把 DPAPI 中已保存的 API Key 同步进私有 DSH_HOME。
    // 旧逻辑只在「保存 Key」那一刻写 DSH_HOME；若当时引擎未就绪/后来 DSH_HOME 丢失，
    // 自检就会报“AI 引擎不可用”。这里保证启动/运行前 DSH_HOME 一定有 Key。
    await this._syncEngineHome(this.engine);
    return this.engine;
  }

  /** 把已保存的 API Key 同步到 DSH_HOME（不打印 Key） */
  async _syncEngineHome(engine) {
    if (!engine || typeof engine.ensureHome !== 'function' || typeof this.loadSecrets !== 'function') return null;
    try {
      const secrets = await this.loadSecrets();
      const apiKey = secrets && secrets.deepseek && secrets.deepseek.apiKey;
      const result = await engine.ensureHome(apiKey ? { apiKey } : {});
      if (apiKey) this.log('[engine] 已把已保存的 API Key 同步到 DSH_HOME');
      return result;
    } catch (e) {
      this.log('[engine] 同步 API Key 到 DSH_HOME 失败：' + (e && e.message));
      return null;
    }
  }

  async sessionStatus() {
    if (this._sessionCache && Date.now() - this._sessionCache.at < 8000) return this._sessionCache.value;
    let value;
    try {
      const cx = await this._loadCx();
      const st = await cx.status();
      value = { loggedIn: Boolean(st && st.loggedIn), uid: st && st.uid ? String(st.uid) : '', savedAt: st && st.savedAt };
    } catch (e) {
      value = { loggedIn: false, uid: '', error: e.message };
    }
    this._sessionCache = { at: Date.now(), value };
    return value;
  }

  async login() {
    if (this._loginBusy) return { started: true, already: true };
    const secrets = await this.loadSecrets();
    const acc = secrets && secrets.chaoxing;
    if (!acc || !acc.username || !acc.password) throw new Error('尚未保存学习通账号密码');
    this._loginBusy = true;
    this.events.broadcast('login-start', {});
    try {
      const cx = await this._loadCx();
      const result = await cx.login({
        username: acc.username,
        password: acc.password,
        timeoutMs: (this.config.loginTimeoutSec || 300) * 1000,
        onNeedHuman: async (info = {}) => {
          this.events.broadcast('need-human', {
            scene: 'login',
            reason: info.reason || '学习通需要人工验证（滑块/安全验证）',
            screenshotPath: info.screenshotPath || '',
          });
          this.events.warn('登录需要人工验证：请在打开的浏览器里完成滑块/验证');
        },
      });
      const st = await this.sessionStatus().catch(() => ({ loggedIn: false }));
      this.events.broadcast('login-done', { ok: Boolean(st.loggedIn), uid: st.uid || '' });
      return { started: true, ok: Boolean(st.loggedIn), uid: st.uid || '', result };
    } finally {
      this._loginBusy = false;
    }
  }

  async logout() {
    try {
      const cx = await this._loadCx();
      if (typeof cx.logout === 'function') await cx.logout();
    } catch {}
    this.events.info('已退出学习通登录态');
    return { ok: true };
  }

  async refresh({ courseId } = {}) {
    const cx = await this._loadCx();
    const courses = (await cx.listCourses()) || [];
    const outCourses = [];
    const allWorks = [];
    for (const c of courses) {
      if (courseId && String(c.courseId) !== String(courseId)) continue;
      let works = [];
      try {
        works = (await cx.listWorks(c)) || [];
      } catch (e) {
        this.events.warn(`课程「${c.name}」作业列表获取失败：${e.message}`);
      }
      const mapped = works.map((w) => compactWork({ ...w, courseId: c.courseId, courseName: c.name }));
      const pending = mapped.filter((w) => isPendingStatus(w.status));
      outCourses.push({ courseId: c.courseId, classId: c.classId, cpi: c.cpi, name: c.name, entryUrl: c.entryUrl, works: { total: mapped.length, pending: pending.length } });
      for (const w of pending) allWorks.push(w);
    }
    this.courses = outCourses;
    this.works = allWorks;
    this.lastRefresh = new Date().toISOString();
    this.config.lastCourseRefresh = this.lastRefresh;
    this.saveConfig(this.config);
    this.events.info(`已刷新：${outCourses.length} 门课程，${allWorks.length} 项待完成作业`);
    return { courses: outCourses, works: allWorks };
  }

  findWork(workId) {
    return this.works.find((w) => String(w.workId) === String(workId)) || this.jobs.get(workId);
  }

  async run(workIds) {
    if (this.running) throw new Error('已有任务在运行');
    const list = (workIds || []).map(String);
    if (!list.length) throw new Error('没有选择作业');
    const works = list.map((id) => {
      const w = this.works.find((x) => String(x.workId) === id);
      if (!w) throw new Error(`作业 ${id} 不在待完成列表里，请先刷新列表`);
      return w;
    });
    this.running = true;
    this.stopFlag = false;
    this.pauseFlag = false;
    const summary = { total: works.length, done: 0, ready: 0, paused: 0, failed: 0, skipped: 0, results: [] };
    this.events.broadcast('run-start', { workIds: list, total: works.length });
    this.events.info(`开始批量作业：${works.length} 项`);
    // 预检：先确认 AI 引擎可用，避免打开作业后才发现引擎/凭据/入口有问题
    const pre = await this._preflightEngine();
    if (!pre.ok) {
      const msg = 'AI 引擎自检失败，已取消本次运行：' + (pre.message || '未知错误');
      this.events.error(msg);
      this.running = false;
      this.events.broadcast('run-done', { summary: { ...summary, error: msg }, error: msg });
      return summary;
    }
    if (pre.latencyMs) this.events.info(`AI 引擎自检通过（${pre.latencyMs}ms）`);
    try {
      for (const work of works) {
        if (this.stopFlag) { summary.skipped += works.length - summary.results.length; break; }
        while (this.pauseFlag && !this.stopFlag) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (this.stopFlag) break;
        const res = await this._runOne(work);
        summary.results.push(res);
        if (res.outcome === 'done') summary.done += 1;
        else if (res.outcome === 'ready') summary.ready += 1;
        else if (res.outcome === 'paused') summary.paused += 1;
        else if (res.outcome === 'skipped') summary.skipped += 1;
        else summary.failed += 1;
      }
    } finally {
      this.running = false;
      this.events.broadcast('run-done', { summary });
      this.events.info(`批量作业结束：提交 ${summary.done}，待提交 ${summary.ready}，暂停 ${summary.paused}，失败 ${summary.failed}`);
    }
    return summary;
  }

  pauseQueue() { this.pauseFlag = true; this.events.info('已请求暂停（当前作业完成后暂停）'); }
  resumeQueue() { this.pauseFlag = false; this.events.info('继续队列'); }
  stopQueue() { this.stopFlag = true; this.events.info('已请求停止（当前作业完成后停止）'); }

  /** 运行前 AI 引擎自检（headless 回一句话），失败则本次运行直接取消。 */
  async _preflightEngine() {
    try {
      const engine = await this._loadEngine();
      if (!engine || typeof engine.check !== 'function') return { ok: true };
      // 每次运行前再同步一次 Key/初始化 DSH_HOME：防止运行中删过 data\dsh-home、或引擎被缓存后 Key 被重写
      await this._syncEngineHome(engine);
      this.events.info('AI 引擎自检中（约 5 秒）…');
      const chk = await engine.check({ cwd: path.join(DIRS.data, 'preflight') });
      if (!chk || chk.ok === false) {
        const detail = (chk && chk.detail) || {};
        const raw = String(detail.stderr || detail.errorText || (chk && chk.text) || '').trim();
        let message = '';
        if (/MISSING_CREDENTIAL|no API key/i.test(raw)) {
          message = 'DSH 运行目录中没有 API Key（已尝试自动同步；请在「连接」里重新保存 API Key 后重试）';
        } else if (/loadOverlayPatches|cordis\.patch|YAML|yaml/i.test(raw)) {
          message = 'AI 运行目录配置损坏（data\\dsh-home）；请删除该目录后重新保存 API Key，或点「清理本地数据」后重试';
        } else if (/ENOTFOUND|ECONN|ETIMEDOUT|network|proxy|fetch failed/i.test(raw)) {
          message = '连接 DeepSeek API 失败，请检查网络/代理后重试';
        } else if (/MODEL|model|route/i.test(raw)) {
          message = 'AI 模型配置异常：' + raw.split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 160);
        } else if (raw) {
          message = raw.split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 240);
        } else {
          message = 'AI 引擎不可用（无详细错误；请查看 logs 目录或重新保存 API Key）';
        }
        this.log(
          '[engine] 自检失败：' +
            JSON.stringify({
              ok: false,
              version: chk && chk.version,
              keyConfigured: chk && chk.keyConfigured,
              latencyMs: chk && chk.latencyMs,
              attempts: chk && chk.attempts,
              detail,
            }).slice(0, 2000)
        );
        return { ok: false, message, detail };
      }
      return { ok: true, latencyMs: chk.latencyMs };
    } catch (e) {
      this.log('[engine] 自检异常：' + (e && e.stack ? e.stack.slice(0, 2000) : e && e.message));
      return { ok: false, message: (e && e.message) || 'AI 引擎不可用' };
    }
  }

  /** 若 AI 有未解出的题，生成手动作答模板，方便用户填完继续。 */
  _writeManualTemplate(job, qids) {
    try {
      const list = (qids || []).map(String).filter(Boolean);
      if (!list.length) return;
      const dir = path.join(DIRS.materials, job.workId);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'manual-answers.json');
      if (fs.existsSync(file)) return;
      const answers = {};
      for (const q of list) answers[q] = '';
      fs.writeFileSync(file, JSON.stringify({
        _说明: 'AI 未能作答的题目，请把每题正确答案（如 A / AB / true）填到对应 qid，保存后点“继续”',
        缺失题号: list,
        answers,
      }, null, 2), 'utf8');
      this.events.warn(`已生成手动作答模板：${file}（填好后点“继续”）`);
    } catch (e) {
      this.events.warn('生成手动作答模板失败：' + e.message);
    }
  }

  /** 把引擎错误翻译成“暂停原因”（超时/循环/部分失败也算暂停，让队列继续）。 */
  _enginePauseReason(action, err = {}) {
    const code = String(err.code || '');
    const detail = err.detail || {};
    if (code === 'PARTIAL_ANSWERS') {
      const failed = Array.isArray(detail.failedQids) ? detail.failedQids : (Array.isArray(detail.missing) ? detail.missing : []);
      return `AI 只解出部分题目（缺 ${failed.length} 道），已保留已得答案；请点“继续”重试`;
    }
    if (code === 'MODEL_REFUSED') return `AI 内容审核拒绝作答（${action}），该批题目需手动处理或换措辞重试`;
    if (code === 'DSH_BIN_IS_CMD') return `AI 引擎入口异常（DSH 入口是 .cmd）；请检查运行环境或重新运行“环境准备.cmd”`;
    if (code === 'LOOP_DETECTED') return `AI 检索陷入循环（${action}），已中止；请补充资料或稍后重试`;
    if (code === 'TIMEOUT') return `AI 处理超时（${action}）；请稍后重试或补充资料`;
    if (code === 'CANCELLED') return `AI 调用被取消（${action}）`;
    return `AI ${action}失败：${err.message || '未知错误'}`;
  }

  /** 把附件/用户资料转成给 AI 读的纯文本（docx 用 docgen；图片用 AI 视觉 OCR）。 */
  async _materialsText(files) {
    if (!files || !files.length) return '';
    const IMG = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
    const parts = [];
    const images = files.filter((f) => IMG.test(String(f)));
    const others = files.filter((f) => !IMG.test(String(f)));

    if (images.length) {
      const canVision = this.engine && typeof this.engine.ocrImages === 'function';
      if (!canVision) {
        parts.push(`【图片（未识别）】\n当前引擎不支持图片识别：${images.map((f) => path.basename(f)).join('、')}`);
      } else {
        try {
          const ocr = await this.engine.ocrImages({
            files: images,
            cacheDir: path.join(DIRS.data, 'ocr-cache'),
            onEvent: (ev) => {
              if (!ev || ev.type !== 'vision') return;
              if (ev.phase === 'done') this.events.info(`图片识别 ${ev.index}/${ev.total}：${ev.file} 完成（${ev.chars} 字）`);
              else if (ev.phase === 'error') this.events.warn(`图片识别 ${ev.index}/${ev.total}：${ev.file} 失败（${ev.error}）`);
              else if (ev.phase === 'cache') this.events.info(`图片识别 ${ev.index}/${ev.total}：${ev.file} 使用缓存`);
              this.events.broadcast('vision', ev);
            },
          });
          for (const t of (ocr && ocr.texts) || []) {
            parts.push(`【图片 OCR：${path.basename(t.file)}】\n${String(t.text || '').slice(0, 16000)}`);
          }
          for (const e of (ocr && ocr.errors) || []) {
            parts.push(`【图片 OCR 失败：${path.basename(e.file)}】\n${e.error}`);
            this.events.warn(`图片「${path.basename(e.file)}」识别失败：${e.error}`);
          }
          if (!ocr || !ocr.texts || !ocr.texts.length) {
            this.events.warn('图片识别没有产出文字，请确认图片清晰、API Key 可用');
          }
        } catch (e) {
          parts.push(`【图片（无法识别）】\n${e.message}`);
          this.events.warn('图片识别异常：' + e.message);
        }
      }
    }

    for (const f of others) {
      const name = path.basename(f);
      let text = '';
      try {
        if (/\.docx$/i.test(f)) {
          const docgen = this.engineModule && this.engineModule.docgen;
          if (docgen && typeof docgen.docxToText === 'function') text = docgen.docxToText(f) || '';
        } else if (/\.(txt|md|csv|json)$/i.test(f)) {
          text = fs.readFileSync(f, 'utf8');
        }
      } catch (e) {
        this.events.warn(`读取资料「${name}」失败：${e.message}`);
      }
      parts.push(`【资料文件】${name}\n${(text || '（无法解析为文本，仅提供文件名供判断）').slice(0, 12000)}`);
    }
    const joined = parts.join('\n\n');
    return joined.length > 30000 ? joined.slice(0, 30000) : joined;
  }

  async _runOne(work) {
    const job = this.jobs.ensure(work);
    const jobDir = this.jobs.dirOf(job.workId);
    const emit = (type, data) => this.events.broadcast(type, { workId: job.workId, name: job.name, ...data });
    const setPhase = (phase, message) => {
      job.phase = phase;
      job.status = 'running';
      job.paused = null;
      job.error = null;
      this.jobs.step(job, phase, 'running', message || '');
      emit('step', { step: phase, status: 'running', message: message || '' });
      this.events.info(`[${job.courseName}] ${job.name} → ${message || phase}`);
    };
    const finishStep = (phase, message) => {
      const last = [...job.steps].reverse().find((s) => s.name === phase);
      if (last) { last.status = 'done'; last.message = message || last.message; last.ts = new Date().toISOString(); }
      this.jobs.save(job);
      emit('step', { step: phase, status: 'done', message: message || '' });
    };

    this.jobs.save(job);
    emit('job-start', { kind: job.kind });
    try {
      const cx = await this._loadCx();
      const engine = await this._loadEngine();

      // 1. 打开作业，取题目与附件
      setPhase('open', '打开作业页面');
      const opened = await cx.openWork(work);
      let questions = (opened && opened.questions) || [];
      if (!questions.length && typeof cx.extractQuestions === 'function') {
        questions = await cx.extractQuestions(opened);
      }
      job.questions = questions || [];
      finishStep('open', `题目 ${job.questions.length} 道`);

      // 2. 附件（模板/资料）下载
      let attachments = (opened && opened.attachments) || [];
      let localAttachments = [];
      if (attachments.length) {
        setPhase('attachments', `下载附件 ${attachments.length} 个`);
        if (typeof cx.downloadAttachments === 'function') {
          const dir = path.join(jobDir, 'attachments');
          fs.mkdirSync(dir, { recursive: true });
          try {
            localAttachments = (await cx.downloadAttachments(work, dir)) || [];
          } catch (e) {
            this.events.warn(`附件下载失败：${e.message}`);
          }
        }
        finishStep('attachments', `已下载 ${localAttachments.length} 个`);
      }

      // 3. 分类题目
      const objective = job.questions.filter((q) => OBJECTIVE_TYPES.has(String(q.type || '').toLowerCase()));
      const shorts = job.questions.filter((q) => SHORT_TYPES.has(String(q.type || '').toLowerCase()));
      const other = job.questions.filter((q) => !objective.includes(q) && !shorts.includes(q));
      const needsFile = job.kind === 'attach' || job.kind === 'mixed' || attachments.length > 0 || other.length > 0;
      const hasSubjective = shorts.length > 0 || needsFile;
      if (hasSubjective && this.config.autoSubmit && this.config.reviewBeforeSubmit !== false) {
        this.events.warn(`「${job.name}」包含主观题/附件题，生成完成后会先暂存并暂停，等你确认后再提交。`);
      }

      const priorAnswers = (job.answers && job.answers.answers && typeof job.answers.answers === 'object')
        ? { ...job.answers.answers }
        : {};
      // 用户在 data\materials\<workId>\manual-answers.json 里手填的答案（AI 拒绝/拿不到时用）优先
      const manualFile = path.join(DIRS.materials, job.workId, 'manual-answers.json');
      let manualAnswers = {};
      try {
        if (fs.existsSync(manualFile)) {
          const obj = JSON.parse(fs.readFileSync(manualFile, 'utf8'));
          const src = obj && obj.answers ? obj.answers : obj;
          if (src && typeof src === 'object' && !Array.isArray(src)) {
            for (const [qid, val] of Object.entries(src)) {
              if (typeof val === 'string' || Array.isArray(val)) manualAnswers[qid] = val;
            }
            this.events.info(`已读取手动作答 ${Object.keys(manualAnswers).length} 题（manual-answers.json）`);
          }
        }
      } catch (e) {
        this.events.warn(`manual-answers.json 解析失败：${e.message}`);
      }
      const answers = { answers: { ...priorAnswers, ...manualAnswers } };
      if (Object.keys(manualAnswers).length) {
        job.answers = answers;
        this.jobs.save(job);
      }
      let sources = [];
      const userMaterialsDir = path.join(DIRS.materials, job.workId);
      const userMaterials = fs.existsSync(userMaterialsDir)
        ? fs.readdirSync(userMaterialsDir).filter((n) => n !== 'manual-answers.json').map((n) => path.join(userMaterialsDir, n))
        : [];
      const materialFiles = [
        ...localAttachments.map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean),
        ...userMaterials,
      ];
      const template = pickTemplate(materialFiles);
      const materialsText = await this._materialsText(materialFiles);

      // 4. 客观题：联网求解（引擎内部会按批分片；已答过的题直接复用，只补缺失）
      if (objective.length) {
        const toSolve = objective.filter((q) => !answers.answers[q.qid]);
        const reuseCount = objective.length - toSolve.length;
        if (!toSolve.length) {
          job.answers = answers;
          this.jobs.save(job);
          finishStep('solve', `沿用已有 ${objective.length} 个答案`);
        } else {
          setPhase('solve', `联网求解 ${toSolve.length} 道客观题${reuseCount ? `（复用已有 ${reuseCount} 题答案）` : ''}`);
          const solveOnce = (qs, phaseText) => engine.solveObjective({
            work, questions: qs, materials: materialsText,
            cwd: path.join(jobDir, 'engine-objective'),
            onEvent: (ev) => {
              if (ev && ev.type === 'batch' && ev.total) {
                emit('step', { step: 'solve', status: 'running', message: `${phaseText}（第 ${ev.index}/${ev.total} 批）` });
              }
              emit('engine', ev);
            },
          });
          let solved = await solveOnce(toSolve, `联网求解 ${toSolve.length} 道客观题`);
          // 部分成功：保留已得答案，再把缺失的题补一次（252 题这类大作业不会整份失败）
          if (solved && solved.ok === false) {
            const partial = solved.answers || {};
            const errDetail = (solved.error && solved.error.detail) || {};
            const missing = (solved.missing || errDetail.failedQids || []).map(String);
            if (Object.keys(partial).length) {
              Object.assign(answers.answers, partial);
              job.answers = answers;
              this.jobs.save(job);
            }
            const retryQs = toSolve.filter((q) => missing.includes(String(q.qid)) && !answers.answers[q.qid]);
            if (retryQs.length) {
              this.events.warn(`客观题有 ${retryQs.length} 道未解出，正在补解…`);
              const retry = await solveOnce(retryQs, `补解 ${retryQs.length} 道题`);
              if (retry && retry.ok !== false) {
                Object.assign(answers.answers, retry.answers || {});
                if (retry.sources) sources.push(...retry.sources);
                solved = { ...retry, ok: true, missing: [] };
              }
            }
          }
          if (!solved || solved.ok === false) {
            const err = (solved && solved.error) || {};
            const detail = [err.message || 'AI 未返回有效结果'];
            if (solved && solved.missing && solved.missing.length) detail.push(`未解出题号：${solved.missing.slice(0, 30).join(',')}`);
            if (solved && Array.isArray(solved.failedBatches) && solved.failedBatches.length) {
              detail.push('失败批次：' + solved.failedBatches.map((b) => `#${b.index}(${(b.error && b.error.code) || '?'})`).join(' '));
            }
            const missingQids = (solved && (solved.missing || errDetail.failedQids)) || [];
            this._writeManualTemplate(job, missingQids);
            return this._pauseJob(job, 'materials', this._enginePauseReason('求解', err), detail, emit, {
              missingQuestions: this._questionRefs(missingQids, job.questions),
            });
          }
          Object.assign(answers.answers, solved.answers || {});
          sources = (sources || []).concat(solved.sources || []);
          job.answers = answers;
          this.jobs.save(job);
          const advisory = Array.isArray(solved.needMaterials) ? solved.needMaterials.filter(Boolean) : [];
          if (advisory.length) {
            job.notes = (job.notes || []).concat(advisory.map((x) => String(x))).slice(-20);
            this.jobs.save(job);
            this.events.warn(`客观题有 ${advisory.length} 条 AI 提示：${advisory[0]}`);
          }
          finishStep('solve', `已得到 ${objective.filter((q) => answers.answers[q.qid]).length}/${objective.length} 个答案`);
        }
        const unanswered = objective.filter((q) => !answers.answers[q.qid]);
        if (unanswered.length) {
          const qids = unanswered.map((q) => q.qid);
          this._writeManualTemplate(job, qids);
          return this._pauseJob(job, 'materials', `还有 ${unanswered.length} 道客观题未解出，已保留已得答案；可在 data\\materials\\${job.workId}\\manual-answers.json 手填后点“继续”重试`, qids, emit, {
            missingQuestions: this._questionRefs(qids, job.questions),
          });
        }
        await this._applyTargetAccuracy({ job, objective, answers, manualQids: Object.keys(manualAnswers), engine, emit });
      }

      // 5. 简答题：逐题生成文字（已答过的题复用）
      if (shorts.length) {
        let reuseShort = 0;
        for (let i = 0; i < shorts.length; i += 1) {
          const q = shorts[i];
          if (String(answers.answers[q.qid] || '').trim()) { reuseShort += 1; continue; }
          setPhase('short', `撰写简答题 ${i + 1}/${shorts.length}`);
          const r = await engine.answerShort({
            work, question: q, materials: materialsText,
            cwd: path.join(jobDir, `engine-short-${i + 1}`),
            onEvent: (ev) => emit('engine', ev),
          });
          if (!r || r.ok === false) {
            const err = (r && r.error) || {};
            return this._pauseJob(job, 'materials', this._enginePauseReason('简答', err), [err.message || 'AI 未返回有效结果'], emit, {
              missingQuestions: this._questionRefs([q.qid], job.questions),
            });
          }
          if (r.needMaterials && r.needMaterials.length && !String(r.text || '').trim()) {
            return this._pauseJob(job, 'materials', '题目缺少资料，无法作答', r.needMaterials, emit, {
              missingQuestions: this._questionRefs([q.qid], job.questions),
            });
          }
          answers.answers[q.qid] = String(r.text || '').trim();
          if (r.sources) sources.push(...r.sources);
          job.answers = answers;
          this.jobs.save(job);
          finishStep('short', `第 ${i + 1} 题完成`);
        }
        if (reuseShort) this.events.info(`简答题复用已有答案 ${reuseShort} 题`);
      }

      // 6. 主观/附件题：生成文件（失败/超时/循环时自动重试 1 次）
      let submissionFile = null;
      if (needsFile) {
        setPhase('doc', '生成作业文件');
        let docResult = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          if (attempt > 1) {
            setPhase('doc', `重试生成作业文件（第 ${attempt} 次）`);
            this.events.warn('作业文件生成未成功，正在重试一次…');
          }
          docResult = await engine.makeSubmissionDoc({
            work,
            questions: job.questions,
            materials: materialsText,
            templatePath: template,
            outDir: path.join(jobDir, 'output'),
            onEvent: (ev) => emit('engine', ev),
          });
          if (docResult && docResult.ok !== false) break;
          const code = String((docResult && docResult.error && docResult.error.code) || '');
          if (!['LOOP_DETECTED', 'TIMEOUT', 'ENGINE_FAILED', 'EMPTY_CONTENT'].includes(code)) break;
        }
        if (!docResult || docResult.ok === false) {
          const err = (docResult && docResult.error) || {};
          return this._pauseJob(job, 'materials', this._enginePauseReason('生成作业文件', err), [err.message || 'AI 未返回有效结果'], emit, {
            missingQuestions: this._questionRefs(job.questions.map((q) => q.qid), job.questions),
          });
        }
        if (docResult.needMaterials && docResult.needMaterials.length) {
          return this._pauseJob(job, 'materials', '缺少完成作业所需的资料', docResult.needMaterials, emit, {
            missingQuestions: this._questionRefs(job.questions.map((q) => q.qid), job.questions),
          });
        }
        submissionFile = docResult.filePath;
        if (!submissionFile || !fs.existsSync(submissionFile)) {
          throw new Error('AI 未生成有效的作业文件：' + JSON.stringify(docResult.summary || '').slice(0, 300));
        }
        job.files = [submissionFile];
        finishStep('doc', path.basename(submissionFile));
      }

      // 7. 填写客观/简答答案
      const hasAnswers = Object.keys(answers.answers).length > 0;
      if (hasAnswers) {
        setPhase('fill', '填写答案');
        const filled = await cx.fillAnswers(work, answers);
        if (filled && filled.ok === false) throw new Error('填写失败：' + JSON.stringify(filled).slice(0, 300));
        finishStep('fill', '答案已保存');
      }

      // 8. 附件上传
      if (submissionFile) {
        setPhase('upload', '上传作业文件');
        if (typeof cx.uploadAttachment !== 'function') throw new Error('当前学习通模块不支持附件上传');
        const up = await cx.uploadAttachment(work, submissionFile);
        if (up && up.ok === false) throw new Error('附件上传失败：' + JSON.stringify(up).slice(0, 300));
        finishStep('upload', '附件已上传');
      }

      // 9. 提交 / 暂存 / 主观题审核暂停
      const reviewBeforeSubmit = this.config.reviewBeforeSubmit !== false;
      const mustSaveDraft = !this.config.autoSubmit || (this.config.autoSubmit && hasSubjective && reviewBeforeSubmit);
      const reviewQids = job.questions
        .filter((q) => {
          const t = String(q.type || '').toLowerCase();
          return SHORT_TYPES.has(t) || !OBJECTIVE_TYPES.has(t);
        })
        .map((q) => q.qid);

      if (mustSaveDraft) {
        setPhase('save', '保存到学习通（暂存）');
        let drafted = null;
        if (typeof cx.saveCurrent === 'function') {
          drafted = await cx.saveCurrent(work);
        } else if (typeof cx.save === 'function') {
          drafted = await cx.save(work, answers);
        } else {
          throw new Error('当前学习通模块不支持暂存，无法在关闭自动提交时保存答案');
        }
        if (drafted && drafted.ok === false) throw new Error('暂存失败：' + JSON.stringify(drafted).slice(0, 400));
        finishStep('save', '已暂存到学习通');

        if (this.config.autoSubmit && hasSubjective && reviewBeforeSubmit) {
          return this._pauseJob(
            job,
            'review',
            '检测到主观题/附件题：已暂存到学习通，建议打开作业页检查后手动提交',
            [
              '若确认答案/附件无误，可点「仍然提交」由程序提交；',
              '也可点「打开作业页」在受控浏览器里检查，或点「仅保存，稍后手动提交」；',
              'AI 生成内容可能有误，请以作业页面实际内容为准。',
            ],
            emit,
            { reviewQuestions: this._questionRefs(reviewQids, job.questions) }
          );
        }

        job.status = 'ready';
        job.phase = 'ready';
        job.result = {
          submitted: false,
          saved: true,
          at: new Date().toISOString(),
          note: '已暂存到学习通，等待手动提交',
        };
        this.jobs.save(job);
        emit('job-done', { status: 'ready', result: job.result, files: job.files || [] });
        this.events.warn(`「${job.name}」已暂存，等待手动提交（学习通进度可能在提交后才更新）`);
        return { workId: job.workId, name: job.name, outcome: 'ready', result: job.result };
      }

      if (this.config.autoSubmit) {
        setPhase('submit', '提交作业');
        const sub = await cx.submitAnswers(work, answers);
        if (sub && sub.ok === false) throw new Error('提交失败：' + JSON.stringify(sub).slice(0, 400));
        job.result = {
          submitted: true,
          at: new Date().toISOString(),
          raw: sub && sub.raw ? String(JSON.stringify(sub.raw)).slice(0, 500) : '',
          sources: sources.slice(0, 20),
        };
        this.jobs.save(job);
        finishStep('submit', '提交成功');
      } else {
        job.result = { submitted: false, saved: true, at: new Date().toISOString(), note: '按设置仅保存未提交' };
        this.jobs.save(job);
        this.events.warn(`「${job.name}」已保存但未提交（设置里关闭了自动提交）`);
      }

      job.status = 'done';
      job.phase = 'done';
      this.jobs.save(job);
      emit('job-done', { result: job.result, files: job.files });
      return { workId: job.workId, name: job.name, outcome: 'done', result: job.result };
    } catch (e) {
      const h = humanizeError(e);
      job.status = 'failed';
      job.phase = 'failed';
      job.error = h.message;
      job.errorCode = h.code;
      job.errorHint = h.hint;
      job.errorRaw = h.raw;
      this.jobs.save(job);
      this.events.error(`「${job.name}」失败：${h.message}${h.hint ? '（' + h.hint + '）' : ''}`);
      this.log('[engine] 原始错误：' + h.raw);
      emit('job-done', { error: h.message, errorCode: h.code, errorHint: h.hint, errorRaw: h.raw, files: job.files || [] });
      return { workId: job.workId, name: job.name, outcome: 'failed', error: h.message };
    }
  }

  _questionRefs(qids, questions = []) {
    const typeLabel = {
      single: '单选题', multi: '多选题', judge: '判断题', truefalse: '判断题',
      blank: '填空题', choice: '选择题', short: '简答题', essay: '论述题',
      subjective: '主观题', answer: '简答题', other: '其他',
    };
    const list = Array.isArray(questions) ? questions : [];
    const indexMap = new Map(list.map((q, i) => [String(q.qid), i + 1]));
    const qmap = new Map(list.map((q) => [String(q.qid), q]));
    const out = [];
    for (const raw of qids || []) {
      const qid = String(raw);
      const q = qmap.get(qid);
      const index = indexMap.get(qid) || 0;
      if (!q) { out.push({ qid, index, type: '', typeLabel: '未知', stem: '' }); continue; }
      out.push({
        qid,
        index,
        type: q.type || '',
        typeLabel: typeLabel[String(q.type || '').toLowerCase()] || String(q.type || '未知'),
        stem: String(q.stem || q.title || '').replace(/\s+/g, ' ').slice(0, 160),
      });
    }
    return out;
  }

  async _applyTargetAccuracy({ job, objective, answers, manualQids, engine, emit }) {
    const target = accuracy.normalizeTargetAccuracy(this.config.targetAccuracy);
    if (target >= 0.99 || !objective.length) return null;
    if (job.accuracy && job.accuracy.applied) return job.accuracy;
    const plan = accuracy.planTargetAccuracy({
      questions: job.questions,
      answers,
      excludeQids: manualQids,
      target,
      seed: job.workId,
    });
    const blankSelected = plan.selected.filter((x) => x.kind === 'blank');
    const blankWrong = {};
    if (blankSelected.length && engine && typeof engine.makeWrongAnswers === 'function') {
      try {
        const wr = await engine.makeWrongAnswers({
          work: { workId: job.workId, name: job.name },
          questions: blankSelected.map((x) => objective.find((q) => String(q.qid) === x.qid) || { qid: x.qid }),
          correctAnswers: answers.answers,
          cwd: path.join(DIRS.jobs, job.workId, 'engine-wrong'),
          onEvent: (ev) => emit('engine', ev),
        });
        if (wr && wr.ok !== false && wr.answers) Object.assign(blankWrong, wr.answers);
        else this.events.warn(`填空题错误答案生成失败，将使用兜底错误答案：${(wr && wr.error && wr.error.message) || '未知'}`);
      } catch (e) {
        this.events.warn(`填空题错误答案生成异常，将使用兜底错误答案：${e.message}`);
      }
    }
    const applied = accuracy.applyTargetAccuracyFor({ plan, answers, questions: job.questions, blankWrong });
    job.answers = answers;
    job.accuracy = {
      target,
      eligibleCount: plan.eligibleCount,
      intendedWrong: plan.wrongCount,
      changed: applied.changed.map((x) => ({ qid: x.qid, index: x.index, type: x.type })),
      failed: applied.failed,
      applied: true,
      at: new Date().toISOString(),
    };
    this.jobs.save(job);
    const pct = Math.round(target * 100);
    if (applied.changed.length) {
      const note = `已按目标正确率 ${pct}% 调整 ${applied.changed.length} 道客观题（第 ${applied.changed.map((x) => x.index).join('、')} 题）；实际正确率受 AI 能力影响，无法保证。`;
      this.events.warn(note);
      emit('accuracy', { target, changed: job.accuracy.changed, note });
    } else {
      this.events.warn(`目标正确率 ${pct}%，但没有可调整的客观题（或题目数量太少）。`);
    }
    if (target <= 0.3) {
      this.events.warn('当前为 30% 档位：会产生大量故意错误答案，容易影响成绩/引起注意，请谨慎使用。');
    }
    return job.accuracy;
  }

  _pauseJob(job, kind, reason, detail, emit, extra = {}) {
    job.status = 'paused';
    job.phase = 'paused';
    job.paused = {
      kind,
      reason,
      detail,
      missingQuestions: Array.isArray(extra.missingQuestions) ? extra.missingQuestions : [],
      reviewQuestions: Array.isArray(extra.reviewQuestions) ? extra.reviewQuestions : [],
      materialsDir: path.join(DIRS.materials, job.workId),
      at: new Date().toISOString(),
    };
    this.jobs.save(job);
    emit('job-paused', {
      kind,
      reason,
      detail,
      missingQuestions: job.paused.missingQuestions,
      reviewQuestions: job.paused.reviewQuestions,
    });
    this.events.warn(`「${job.name}」已暂停：${reason}${detail ? '（' + JSON.stringify(detail).slice(0, 200) + '）' : ''}`);
    return { workId: job.workId, name: job.name, outcome: 'paused', reason, detail };
  }

  /** 审核暂停后：打开作业页（受控 Edge），供用户检查。 */
  async openReview(workId) {
    const job = this.jobs.get(String(workId));
    if (!job) throw new Error('找不到该作业记录');
    const cx = await this._loadCx();
    const work = this.findWork(workId) || {
      workId: job.workId, courseId: job.courseId, courseName: job.courseName,
      name: job.name, kind: job.kind, status: job.status, url: job.url,
    };
    await cx.openWork(work);
    return { ok: true };
  }

  /** 审核暂停后：用户确认提交。 */
  async submitReview(workId) {
    if (this.running) throw new Error('队列仍在运行，请等运行结束或先停止后再提交');
    const job = this.jobs.get(String(workId));
    if (!job) throw new Error('找不到该作业记录');
    if (job.status !== 'paused' || !job.paused || job.paused.kind !== 'review') throw new Error('该作业当前不在“待确认提交”状态');
    const cx = await this._loadCx();
    const work = this.findWork(workId) || {
      workId: job.workId, courseId: job.courseId, courseName: job.courseName,
      name: job.name, kind: job.kind, status: job.status, url: job.url,
    };
    try {
      const sub = await cx.submitAnswers(work, job.answers || { answers: {} });
      if (sub && sub.ok === false) throw new Error('提交失败：' + JSON.stringify(sub).slice(0, 400));
      job.result = { submitted: true, at: new Date().toISOString(), raw: sub && sub.raw ? String(JSON.stringify(sub.raw)).slice(0, 500) : '' };
      job.status = 'done';
      job.phase = 'done';
      job.paused = null;
      job.error = '';
      job.errorCode = '';
      job.errorHint = '';
      job.errorRaw = '';
      this.jobs.save(job);
      this.events.info(`「${job.name}」已确认提交成功`);
      this.events.broadcast('job-done', { workId: job.workId, name: job.name, status: 'done', result: job.result, files: job.files || [] });
      return { ok: true, outcome: 'done', result: job.result };
    } catch (e) {
      const h = humanizeError(e);
      job.paused = {
        ...(job.paused || {}),
        kind: 'review',
        reason: '提交失败：' + h.message,
        detail: [h.hint || '请打开作业页检查后重试。'],
        at: new Date().toISOString(),
      };
      this.jobs.save(job);
      this.events.error(`「${job.name}」提交失败：${h.message}`);
      this.log('[engine] 提交原始错误：' + h.raw);
      throw new Error(h.message + (h.hint ? '；' + h.hint : ''));
    }
  }

  /** 审核暂停后：仅保留暂存，稍后手动提交。 */
  async markReady(workId) {
    if (this.running) throw new Error('队列仍在运行，请等运行结束或先停止后再操作');
    const job = this.jobs.get(String(workId));
    if (!job) throw new Error('找不到该作业记录');
    job.status = 'ready';
    job.phase = 'ready';
    job.paused = null;
    job.result = { submitted: false, saved: true, at: new Date().toISOString(), note: '已暂存到学习通，等待手动提交' };
    this.jobs.save(job);
    this.events.broadcast('job-done', { workId: job.workId, name: job.name, status: 'ready', result: job.result, files: job.files || [] });
    this.events.warn(`「${job.name}」已标记为待提交（已暂存）`);
    return { ok: true, outcome: 'ready', result: job.result };
  }

  async resumeWork(workId) {
    const job = this.jobs.get(workId);
    if (!job) throw new Error('找不到该作业记录');
    const work = this.works.find((w) => String(w.workId) === String(workId)) || {
      workId: job.workId, courseId: job.courseId, courseName: job.courseName,
      name: job.name, kind: job.kind, status: job.status, url: job.url,
    };
    if (this.running) throw new Error('已有任务在运行，请稍后或停止后再继续');
    this.running = true;
    this.stopFlag = false;
    this.pauseFlag = false;
    this.events.broadcast('run-start', { workIds: [String(workId)], total: 1 });
    try {
      const res = await this._runOne(work);
      this.events.broadcast('run-done', { summary: { total: 1, done: res.outcome === 'done' ? 1 : 0, paused: res.outcome === 'paused' ? 1 : 0, failed: res.outcome === 'failed' ? 1 : 0 } });
      return res;
    } finally {
      this.running = false;
    }
  }
}
