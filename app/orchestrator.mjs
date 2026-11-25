/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
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

const FORMULA_OCR_PROMPT = [
  '你在识别学习通作业作答页截图。请逐题提取文字：',
  '1) 保留题号、题干、选项（A/B/C/D）、填空位置、单位；',
  '2) 数学公式尽量转成 LaTeX（如 $\\frac{a}{b}$、$x^2$），不要省略公式；',
  '3) 不要总结、不要解释、不要编造图片中没有的内容；',
  '4) 如果某道题有复杂公式、看不清或无法确定，在输出最后单独一行写：[[FORMULA_UNCERTAIN]]',
  '5) 只输出文字本身（含必要的标记行）。',
].join('\n');
const FORMULA_UNCERTAIN_MARKER = '[[FORMULA_UNCERTAIN]]';

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
      const objectiveAll = job.questions.filter((q) => OBJECTIVE_TYPES.has(String(q.type || '').toLowerCase()));
      const skippedSet = new Set((job.skippedQuestions || []).map(String));
      const objective = objectiveAll.filter((q) => !skippedSet.has(String(q.qid)));
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
      let materialsText = await this._materialsText(materialFiles);
      const manualOcrBefore = job.formulaOcr;
      // v1.7.2：只对“题目里确实有图片”的题号做主动截图识别，避免整页 OCR
      const imageQids = job.questions.filter((q) => Number(q.imageCount) > 0 || q.latex).map((q) => String(q.qid));
      if (imageQids.length && !job.formulaRescueAttempted) {
        const rescue = await this._tryFormulaRescue({ work, job, cx, engine, materialsText, emit, qids: imageQids });
        if (rescue.ok) materialsText = rescue.materialsText;
      }
      if (manualOcrBefore) {
        // 用户在暂停/失败后用「再次识别」手动补充的 OCR 结果，也加入下一次运行
        materialsText = `${materialsText}${materialsText ? '\n\n' : ''}【手动重新识别的作答页公式】\n${String(manualOcrBefore).slice(0, 30000)}`;
      }
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
          let solved = null;
          const highAccuracyEnabled = this.config.highAccuracy === true
            && accuracy.normalizeTargetAccuracy(this.config.targetAccuracy) === 0.99;
          if (highAccuracyEnabled) {
            setPhase('solve', `高正确率：客观题做 3 次投票（${toSolve.length} 题）`);
            const high = await this._solveHighAccuracy({ solveOnce, questions: toSolve });
            job.highAccuracy = {
              enabled: true,
              rounds: 3,
              ties: high.ties,
              at: new Date().toISOString(),
            };
            this.jobs.save(job);
            solved = { ok: Object.keys(high.answers).length > 0, answers: high.answers, sources: high.sources, missing: high.missing };
            if (high.missing.length) this.events.warn(`高正确率有 ${high.missing.length} 道题没有可用答案：${high.missing.slice(0, 20).join(',')}`);
            if (high.ties.length) {
              this.events.warn(`高正确率有 ${high.ties.length} 道题出现三次不同答案，已随机选用并将在提交前要求人工复核。`);
              emit('high-accuracy', { workId: job.workId, ties: high.ties, rounds: 3 });
            } else {
              this.events.info('高正确率：3 次投票没有出现三次全不同答案，无需额外人工复核。');
            }
          } else {
            solved = await solveOnce(toSolve, `联网求解 ${toSolve.length} 道客观题`);
          }
          let errDetail = {};
          // 部分成功：保留已得答案，再把缺失的题补一次（252 题这类大作业不会整份失败）
          if (solved && solved.ok === false) {
            const partial = solved.answers || {};
            errDetail = (solved.error && solved.error.detail) || {};
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
            // v1.6：如果 AI 因公式图片判缺资料，先截取作答页做视觉识别，再补解一次
            const retryQidsForRescue = toSolve.filter((q) => !answers.answers[q.qid]).map((q) => String(q.qid));
            const rescue = await this._tryFormulaRescue({ work, job, cx, engine, materialsText, emit, qids: retryQidsForRescue });
            if (rescue.ok) {
              materialsText = rescue.materialsText;
              const retryQs = toSolve.filter((q) => !answers.answers[q.qid]);
              if (retryQs.length) {
                this.events.warn(`截图识别后补解 ${retryQs.length} 道题…`);
                const retry = await solveOnce(retryQs, `截图识别后补解 ${retryQs.length} 道题`);
                if (retry && retry.answers) {
                  Object.assign(answers.answers, retry.answers);
                  if (retry.sources) sources.push(...retry.sources);
                }
                if (retry && retry.ok !== false) solved = { ...retry, ok: true, missing: [] };
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
            if (job.formulaError) detail.push('公式截图识别：' + job.formulaError);
            const missingQids = (solved && (solved.missing || (errDetail && errDetail.failedQids))) || [];
            this._writeManualTemplate(job, missingQids);
            const reason = job.formulaError
              ? `公式/图片识别失败：${job.formulaError}`
              : this._enginePauseReason('求解', err);
            return this._pauseJob(job, 'materials', reason, detail, emit, {
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
        let unanswered = objective.filter((q) => !answers.answers[q.qid]);
        if (unanswered.length) {
          // v1.7.2：只截取缺答案题号，避免整页 OCR 超时
          const rescue = await this._tryFormulaRescue({ work, job, cx, engine, materialsText, emit, qids: unanswered.map((q) => String(q.qid)) });
          if (rescue.ok) {
            materialsText = rescue.materialsText;
            const retry = await solveOnce(unanswered, `截图识别后补解 ${unanswered.length} 道客观题`);
            if (retry && retry.answers) {
              Object.assign(answers.answers, retry.answers);
              if (retry.sources) sources.push(...retry.sources);
              job.answers = answers;
              this.jobs.save(job);
            }
            unanswered = objective.filter((q) => !answers.answers[q.qid]);
          }
        }
        if (unanswered.length) {
          const qids = unanswered.map((q) => q.qid);
          this._writeManualTemplate(job, qids);
          const reason = job.formulaError
            ? `公式/图片识别失败，仍有 ${unanswered.length} 道题无法读取`
            : `还有 ${unanswered.length} 道客观题未解出，已保留已得答案；可在 data\\materials\\${job.workId}\\manual-answers.json 手填后点“继续”重试`;
          return this._pauseJob(job, 'materials', reason, qids, emit, {
            missingQuestions: this._questionRefs(qids, job.questions),
          });
        }
        await this._applyTargetAccuracy({
          job,
          objective: objectiveAll,
          answers,
          manualQids: Object.keys(manualAnswers),
          skippedQids: [...skippedSet],
          engine,
          emit,
          force: skippedSet.size > 0,
        });
      }

      if (!objective.length && objectiveAll.length && skippedSet.size) {
        await this._applyTargetAccuracy({
          job,
          objective: objectiveAll,
          answers,
          manualQids: Object.keys(manualAnswers),
          skippedQids: [...skippedSet],
          engine,
          emit,
          force: skippedSet.size > 0,
        });
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
        if (!docResult || docResult.ok === false || (docResult.needMaterials && docResult.needMaterials.length)) {
          // v1.7.2：只重试有图片的题目；没有图片信息时退回全部题目
          const docImageQids = job.questions.filter((q) => Number(q.imageCount) > 0 || q.latex).map((q) => String(q.qid));
          const rescue = await this._tryFormulaRescue({ work, job, cx, engine, materialsText, emit, qids: docImageQids });
          if (rescue.ok) {
            materialsText = rescue.materialsText;
            docResult = await engine.makeSubmissionDoc({
              work,
              questions: job.questions,
              materials: materialsText,
              templatePath: template,
              outDir: path.join(jobDir, 'output'),
              onEvent: (ev) => emit('engine', ev),
            });
          }
        }
        if (!docResult || docResult.ok === false) {
          const err = (docResult && docResult.error) || {};
          const detail = [err.message || 'AI 未返回有效结果'];
          if (job.formulaError) detail.push('公式截图识别：' + job.formulaError);
          const reason = job.formulaError ? `公式/图片识别失败：${job.formulaError}` : this._enginePauseReason('生成作业文件', err);
          return this._pauseJob(job, 'materials', reason, detail, emit, {
            missingQuestions: this._questionRefs(job.questions.map((q) => q.qid), job.questions),
          });
        }
        if (docResult.needMaterials && docResult.needMaterials.length) {
          const reason = job.formulaError ? `公式/图片识别失败：${job.formulaError}` : '缺少完成作业所需的资料';
          return this._pauseJob(job, 'materials', reason, docResult.needMaterials, emit, {
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

      // 9. 提交 / 暂存 / 主观题或正确率检查暂停
      const reviewBeforeSubmit = this.config.reviewBeforeSubmit !== false;
      const accuracyChanges = job.accuracy && Array.isArray(job.accuracy.changed) ? job.accuracy.changed : [];
      const skippedQuestions = Array.isArray(job.skippedQuestions) ? job.skippedQuestions : [];
      const hasSkipped = skippedQuestions.length > 0;
      const highAccuracyTies = job.highAccuracy && Array.isArray(job.highAccuracy.ties) ? job.highAccuracy.ties : [];
      const needHighAccuracyReview = this.config.autoSubmit && highAccuracyTies.length > 0;
      const needAccuracyReview = this.config.autoSubmit && accuracyChanges.length > 0;
      const mustSaveDraft = !this.config.autoSubmit
        || (this.config.autoSubmit && hasSubjective && reviewBeforeSubmit)
        || needAccuracyReview
        || (this.config.autoSubmit && hasSkipped)
        || needHighAccuracyReview;
      const reviewQids = job.questions
        .filter((q) => {
          const t = String(q.type || '').toLowerCase();
          return SHORT_TYPES.has(t) || !OBJECTIVE_TYPES.has(t);
        })
        .map((q) => q.qid);
      for (const c of accuracyChanges) if (!reviewQids.includes(String(c.qid))) reviewQids.push(String(c.qid));
      for (const qid of skippedQuestions) if (!reviewQids.includes(String(qid))) reviewQids.push(String(qid));
      for (const t of highAccuracyTies) if (!reviewQids.includes(String(t.qid))) reviewQids.push(String(t.qid));

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

        if (this.config.autoSubmit && ((hasSubjective && reviewBeforeSubmit) || needAccuracyReview || hasSkipped || needHighAccuracyReview)) {
          const reasonParts = [];
          const detail = [];
          if (hasSubjective && reviewBeforeSubmit) {
            reasonParts.push('检测到主观题/附件题');
            detail.push('若确认答案/附件无误，可点「仍然提交」由程序提交；');
          }
          if (needAccuracyReview) {
            reasonParts.push(`目标正确率 ${Math.round((job.accuracy.target || 0) * 100)}%，已故意改错 ${accuracyChanges.length} 道题`);
            detail.push('下方列出被故意改错的题（原 AI 答案 → 提交答案）；AI 原答案不保证正确；');
          }
          if (hasSkipped) {
            reasonParts.push(`已跳过 ${skippedQuestions.length} 道题（留空）`);
            detail.push('已跳过的主观题会留空（主观题不参与目标正确率改错）；提交前请手动确认这些题的完成情况，再决定是否提交。');
          }
          if (needHighAccuracyReview) {
            reasonParts.push(`高正确率有 ${highAccuracyTies.length} 道题三次答案不同`);
            detail.push('三次答案不同的题已随机选用一个，请人工复核下方三个答案后再提交。');
          }
          detail.push('也可点「打开作业页」在受控浏览器里检查，或点「仅保存，稍后手动提交」；');
          detail.push('AI 生成内容可能有误，请以作业页面实际内容为准。');
          return this._pauseJob(
            job,
            'review',
            reasonParts.join('；') + '：已暂存到学习通，请检查后手动提交',
            detail,
            emit,
            {
              reviewQuestions: this._questionRefs(reviewQids, job.questions),
              accuracyChanges,
              highAccuracyTies,
            }
          );
        }

        job.status = 'ready';
        job.phase = 'ready';
        job.result = {
          submitted: false,
          saved: true,
          at: new Date().toISOString(),
          note: '已暂存到学习通，等待手动提交',
          accuracyChanged: accuracyChanges.length,
        };
        this.jobs.save(job);
        emit('job-done', { status: 'ready', result: job.result, files: job.files || [] });
        this.events.warn(`「${job.name}」已暂存，等待手动提交（学习通进度可能在提交后才更新）`);
        if (accuracyChanges.length) {
          this.events.warn(`「${job.name}」目标正确率设置下故意改错了 ${accuracyChanges.length} 道题，详情见作业详情。`);
        }
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

  /**
   * v1.6：AI 因公式图片判“缺资料”时，截取受控作答页题目区域 → 视觉识别 → 追加资料并允许重试。
   * 只截答题页，不截整个桌面；复杂公式不确定时通过 formula-warning 事件让 UI 弹窗提醒核对。
   */
  /** v1.7.2 高正确率：客观题 3 次求解，多数票；三次全不同则随机选并记录题号。 */
  async _solveHighAccuracy({ solveOnce, questions }) {
    const rounds = [];
    for (let i = 1; i <= 3; i += 1) {
      this.events.info(`高正确率：第 ${i}/3 次求解（客观题）…`);
      try {
        const r = await solveOnce(questions, `高正确率第 ${i}/3 次`);
        rounds.push(r || {});
      } catch (e) {
        this.events.warn(`高正确率第 ${i}/3 次求解失败：${e.message}`);
        rounds.push({});
      }
    }
    const voteKey = (value) => {
      if (Array.isArray(value)) {
        return value.map((x) => String(x ?? '').trim().toUpperCase()).sort().join('|');
      }
      let s = String(value ?? '').trim();
      if (/^(对|正确|true|√)$/i.test(s)) s = 'TRUE';
      else if (/^(错|错误|false|×)$/i.test(s)) s = 'FALSE';
      else s = s.toUpperCase();
      return s;
    };
    const out = {};
    const ties = [];
    const sources = [];
    const missing = [];
    const indexMap = new Map((questions || []).map((q, i) => [String(q.qid), i + 1]));
    for (const r of rounds) if (r && Array.isArray(r.sources)) sources.push(...r.sources);
    for (const q of questions) {
      const qid = String(q.qid);
      const votes = [];
      for (const r of rounds) {
        const v = r && r.answers ? r.answers[qid] : undefined;
        if (v == null) continue;
        if (Array.isArray(v) ? !v.length : !String(v).trim()) continue;
        votes.push(v);
      }
      if (!votes.length) { missing.push(qid); continue; }
      const groups = new Map();
      for (const v of votes) {
        const k = voteKey(v);
        if (!groups.has(k)) groups.set(k, { count: 0, value: v, values: [] });
        const g = groups.get(k);
        g.count += 1;
        g.values.push(v);
      }
      const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
      let chosen;
      if (sorted.length === 1) {
        chosen = sorted[0].value;
      } else if (sorted[0].count >= 2) {
        chosen = sorted[0].value;
      } else if (votes.length >= 3) {
        // 三次全不同：随机选一个，并记录该题号与三个答案
        const pick = votes[Math.floor(Math.random() * votes.length)];
        chosen = pick;
        ties.push({
          qid,
          index: indexMap.get(qid) || Number(q.index || 0),
          type: String(q.type || ''),
          answers: votes.slice(0, 3),
          chosen,
        });
      } else {
        chosen = votes[0];
      }
      out[qid] = chosen;
    }
    return { answers: out, ties, missing, sources, rounds: rounds.length };
  }

  async _tryFormulaRescue({ work, job, cx, engine, materialsText = '', emit, qids = [] }) {
    if (job.formulaRescueAttempted) return { ok: false, reason: 'already-attempted' };
    if (!cx || typeof cx.captureQuestionScreenshots !== 'function') return { ok: false, reason: 'screenshot-unsupported' };
    if (!engine || typeof engine.ocrImages !== 'function') return { ok: false, reason: 'vision-unsupported' };
    job.formulaRescueAttempted = true;
    this.jobs.save(job);
    const jobDir = path.join(DIRS.jobs, job.workId);
    const shotDir = path.join(jobDir, 'screenshots');
    const targetQids = [...new Set((qids || []).map(String).filter(Boolean))];
    try {
      this.events.info(`「${job.name}」正在按题号截取作答页并做视觉识别${targetQids.length ? `（${targetQids.join(',')}）` : ''}…`);
      const shots = await cx.captureQuestionScreenshots(work, shotDir, { qids: targetQids });
      if (!shots || !shots.length) {
        job.formulaError = '没有截取到作答页截图';
        this.jobs.save(job);
        return { ok: false, reason: 'no-screenshots' };
      }
      job.formulaScreenshots = shots.map((s) => (typeof s === 'string' ? s : s.path)).filter(Boolean);
      this.jobs.save(job);
      const texts = [];
      const errors = [];
      // 每题单独 OCR；单题超时/失败不拖垮其他题；失败再降分辨率重试一次
      for (const file of job.formulaScreenshots) {
        const name = path.basename(file);
        let r = await engine.ocrImages({
          files: [file],
          cacheDir: path.join(DIRS.data, 'ocr-cache'),
          prompt: FORMULA_OCR_PROMPT,
          timeoutMs: 120000,
          maxPixels: 2000,
          onEvent: (ev) => { if (emit) emit('vision', ev); },
        });
        if (!r || !r.texts || !r.texts.length) {
          this.events.warn(`「${job.name}」${name} 识别超时/失败，降低分辨率重试…`);
          r = await engine.ocrImages({
            files: [file],
            cacheDir: path.join(DIRS.data, 'ocr-cache'),
            prompt: FORMULA_OCR_PROMPT,
            timeoutMs: 120000,
            maxPixels: 1200,
            onEvent: (ev) => { if (emit) emit('vision', ev); },
          });
        }
        if (r && r.texts && r.texts.length) texts.push(...r.texts);
        if (r && r.errors) errors.push(...r.errors);
      }
      let joined = texts.map((t) => String(t.text || '').trim()).filter(Boolean).join('\n\n');
      const uncertain = joined.includes(FORMULA_UNCERTAIN_MARKER);
      joined = joined.split(FORMULA_UNCERTAIN_MARKER).join('').trim();
      if (!joined) {
        job.formulaError = (errors[0] && (errors[0].error || errors[0].message)) || '截图识别没有产出文字';
        this.jobs.save(job);
        this.events.warn(`「${job.name}」作答页截图识别失败：${job.formulaError}`);
        return { ok: false, reason: 'ocr-empty', error: job.formulaError };
      }
      const ocrBlock = `【作业页面截图 OCR（按题号自动识别，仅供参考）】\n${joined.slice(0, 30000)}`;
      job.formulaOcr = joined.slice(0, 4000);
      if (errors.length) job.formulaError = errors.map((e) => e.error).filter(Boolean).join('；').slice(0, 500);
      if (uncertain) {
        job.formulaWarning = {
          text: joined.slice(0, 4000),
          screenshots: job.formulaScreenshots,
          at: new Date().toISOString(),
        };
        this.events.warn(`「${job.name}」检测到复杂/不确定公式，已提示用户比对原题`);
        if (emit) {
          emit('formula-warning', {
            workId: job.workId,
            name: job.name,
            text: joined.slice(0, 4000),
            screenshots: job.formulaScreenshots,
            reason: '复杂公式识别可能不准确，请比对原题目',
          });
        }
      }
      this.jobs.save(job);
      this.events.info(`「${job.name}」截图识别完成：${joined.length} 字${uncertain ? '（含不确定公式）' : ''}`);
      return {
        ok: true,
        materialsText: `${materialsText}${materialsText ? '\n\n' : ''}${ocrBlock}`,
        ocrText: joined,
        uncertain,
        screenshots: job.formulaScreenshots,
        failedCount: errors.length,
      };
    } catch (e) {
      job.formulaError = e.message;
      this.jobs.save(job);
      this.events.warn(`「${job.name}」公式截图识别异常：${e.message}`);
      return { ok: false, reason: 'exception', error: e.message };
    }
  }

  async _applyTargetAccuracy({ job, objective, answers, manualQids, skippedQids = [], engine, emit, force = false }) {
    const target = accuracy.normalizeTargetAccuracy(this.config.targetAccuracy);
    const objectiveAll = Array.isArray(objective) ? objective : job.questions.filter((q) => OBJECTIVE_TYPES.has(String(q.type || '').toLowerCase()));
    if (!objectiveAll.length) return null;
    const forceEffective = force || Boolean(job.accuracy && job.accuracy.applied && Number(job.accuracy.target) !== Number(target));
    if (job.accuracy && job.accuracy.applied && !forceEffective) return job.accuracy;
    const manualSet = new Set((manualQids || []).map(String));
    const skipSet = new Set((job.skippedQuestions || skippedQids || []).map(String));
    const skippedObjectiveCount = objectiveAll.filter((q) => skipSet.has(String(q.qid))).length;
    const map = answers && answers.answers ? answers.answers : answers || {};
    const originalAnswers = { ...((job.accuracy && job.accuracy.originalAnswers) || {}) };

    // 重新计算（例如跳过题目）时，先把之前故意改错的答案恢复，再按新题数重新改错
    if (forceEffective && job.accuracy && Array.isArray(job.accuracy.changed)) {
      for (const c of job.accuracy.changed) {
        const before = c.before != null ? c.before : originalAnswers[c.qid];
        if (before != null) map[c.qid] = before;
      }
    }
    for (const q of objectiveAll) {
      const qid = String(q.qid);
      if (skipSet.has(qid)) { delete map[qid]; continue; }
      if (originalAnswers[qid] === undefined && map[qid] != null) originalAnswers[qid] = map[qid];
    }

    const total = objectiveAll.filter((q) => !manualSet.has(String(q.qid))).length;
    const indexMap = new Map((job.questions || []).map((q, i) => [String(q.qid), i + 1]));
    const desiredWrong = target >= 0.99 ? 0 : Math.min(total, Math.max(1, Math.round(total * (1 - target))));
    const extraWrong = Math.max(0, desiredWrong - skippedObjectiveCount);
    const candidates = objectiveAll
      .filter((q) => {
        const qid = String(q.qid);
        if (skipSet.has(qid) || manualSet.has(qid)) return false;
        return map[qid] != null && (Array.isArray(map[qid]) ? map[qid].length > 0 : String(map[qid]).trim() !== '');
      })
      .slice()
      .sort((a, b) => (indexMap.get(String(a.qid)) || 0) - (indexMap.get(String(b.qid)) || 0));
    const selected = candidates.slice(0, extraWrong).map((q) => ({
      index: indexMap.get(String(q.qid)) || Number(q.index || 0),
      qid: String(q.qid),
      type: String(q.type || ''),
      stem: String(q.stem || ''),
      answer: map[String(q.qid)],
      kind: String(q.type || '').toLowerCase() === 'blank' ? 'blank' : 'choice',
    }));
    const plan = { target, eligibleCount: total, wrongCount: desiredWrong, selected };
    const blankSelected = selected.filter((x) => x.kind === 'blank');
    const blankWrong = {};
    if (blankSelected.length && engine && typeof engine.makeWrongAnswers === 'function') {
      try {
        const wr = await engine.makeWrongAnswers({
          work: { workId: job.workId, name: job.name },
          questions: blankSelected.map((x) => objectiveAll.find((q) => String(q.qid) === x.qid) || { qid: x.qid }),
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
    const applied = accuracy.applyTargetAccuracyFor({ plan, answers, questions: objectiveAll, blankWrong });
    job.answers = answers;
    job.accuracy = {
      target,
      eligibleCount: total,
      intendedWrong: desiredWrong,
      skippedCount: skippedObjectiveCount,
      changed: applied.changed.map((x) => ({
        qid: x.qid,
        index: x.index,
        type: x.type,
        kind: x.kind,
        before: x.before,
        after: x.after,
      })),
      failed: applied.failed,
      originalAnswers,
      applied: true,
      at: new Date().toISOString(),
    };
    this.jobs.save(job);
    const pct = Math.round(target * 100);
    if (skippedObjectiveCount) {
      this.events.warn(`已跳过 ${skippedObjectiveCount} 道客观题（留空，计入错误）；目标错误数 ${desiredWrong}，另改错 ${applied.changed.length} 道。`);
      if (skippedObjectiveCount > desiredWrong) this.events.warn(`跳过题数已超过目标错误数，实际正确率会低于 ${pct}%。`);
    }
    if (applied.changed.length) {
      const note = `已按目标正确率 ${pct}% 调整 ${applied.changed.length} 道客观题（第 ${applied.changed.map((x) => x.index).join('、')} 题）；实际正确率受 AI 能力影响，无法保证。`;
      this.events.warn(note);
      emit('accuracy', { target, changed: job.accuracy.changed, skippedCount: skippedObjectiveCount, note });
    } else if (!skippedObjectiveCount) {
      this.events.warn(`目标正确率 ${pct}%，但没有可调整的客观题（或题目数量太少）。`);
    }
    if (target <= 0.3) {
      this.events.warn('当前为 30% 档位：会产生大量故意错误答案，容易影响成绩/引起注意，请谨慎使用。');
    }
    return job.accuracy;
  }

  /** 跳过某道客观题：留空、计入正确率；提交时 UI 会提示手动确认。 */
  async skipQuestion(workId, qid) {
    if (this.running) throw new Error('队列仍在运行，请等运行结束或先停止后再跳过题目');
    const job = this.jobs.get(String(workId));
    if (!job) throw new Error('找不到该作业记录');
    const question = (job.questions || []).find((q) => String(q.qid) === String(qid));
    if (!question) throw new Error('找不到该题目');
    if (!SHORT_TYPES.has(String(question.type || '').toLowerCase())) throw new Error('只能跳过简答/论述等主观题');
    job.skippedQuestions = Array.isArray(job.skippedQuestions) ? job.skippedQuestions : [];
    if (job.skippedQuestions.includes(String(qid))) return { ok: true, skippedQuestions: job.skippedQuestions, already: true };
    job.skippedQuestions.push(String(qid));
    job.answers = job.answers || { answers: {} };
    job.answers.answers = job.answers.answers || {};
    const originalValue = job.answers.answers[String(qid)];
    job.accuracy = job.accuracy || { target: this.config.targetAccuracy, originalAnswers: {} };
    job.accuracy.originalAnswers = job.accuracy.originalAnswers || {};
    if (originalValue != null) job.accuracy.originalAnswers[String(qid)] = originalValue;
    delete job.answers.answers[String(qid)];
    if (job.status === 'paused') {
      job.paused = job.paused || {};
      job.paused.reason = `已跳过 ${job.skippedQuestions.length} 道题（留空）；提交前请手动确认完成情况`;
      job.paused.skippedQuestions = job.skippedQuestions;
    }
    this.jobs.save(job);
    const qIndex = (job.questions || []).findIndex((q) => String(q.qid) === String(qid)) + 1;
    this.events.warn(`「${job.name}」已跳过第 ${qIndex || question.index || '?'} 题（${qid}），该题为主观题，会留空；提交前请手动确认。`);
    try {
      const engine = await this._loadEngine();
      const objectiveAll = (job.questions || []).filter((q) => OBJECTIVE_TYPES.has(String(q.type || '').toLowerCase()));
      await this._applyTargetAccuracy({
        job,
        objective: objectiveAll,
        answers: job.answers,
        manualQids: [],
        skippedQids: job.skippedQuestions,
        engine,
        emit: (type, data) => this.events.broadcast(type, data),
        force: true,
      });
    } catch (e) {
      this.events.warn(`跳过题目后重新计算正确率失败：${e.message}`);
    }
    if (job.paused) {
      job.paused.skippedQuestions = job.skippedQuestions;
      job.paused.accuracyChanges = job.accuracy && Array.isArray(job.accuracy.changed) ? job.accuracy.changed : [];
      job.paused.reason = `已跳过 ${job.skippedQuestions.length} 道题（留空）；提交前请手动确认完成情况`;
    }
    this.jobs.save(job);
    const payload = {
      workId: job.workId,
      qid: String(qid),
      skippedQuestions: job.skippedQuestions,
      accuracy: job.accuracy || null,
      reason: '该题已留空，提交前需要手动确认完成情况',
    };
    this.events.broadcast('job-skip', payload);
    return { ok: true, ...payload };
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
      accuracyChanges: Array.isArray(extra.accuracyChanges) ? extra.accuracyChanges : [],
      skippedQuestions: Array.isArray(job.skippedQuestions) ? job.skippedQuestions : [],
      highAccuracyTies: Array.isArray(extra.highAccuracyTies) ? extra.highAccuracyTies : [],
      skippableQuestions: this._questionRefs(
        (job.questions || []).filter((q) => SHORT_TYPES.has(String(q.type || '').toLowerCase())).map((q) => q.qid),
        job.questions
      ),
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
      accuracyChanges: job.paused.accuracyChanges,
      skippedQuestions: job.paused.skippedQuestions,
      skippableQuestions: job.paused.skippableQuestions,
      highAccuracyTies: job.paused.highAccuracyTies,
    });
    this.events.warn(`「${job.name}」已暂停：${reason}${detail ? '（' + JSON.stringify(detail).slice(0, 200) + '）' : ''}`);
    return { workId: job.workId, name: job.name, outcome: 'paused', reason, detail };
  }

  /** 手动“再次识别”（AI 截图视觉识别）：重新截取受控作答页题目区域并 OCR。 */
  async rescueJob(workId) {
    if (this.running) throw new Error('队列仍在运行，请等运行结束或先停止后再手动识别');
    const job = this.jobs.get(String(workId));
    if (!job) throw new Error('找不到该作业记录');
    const cx = await this._loadCx();
    const engine = await this._loadEngine();
    const work = this.findWork(workId) || {
      workId: job.workId, courseId: job.courseId, courseName: job.courseName,
      name: job.name, kind: job.kind, status: job.status, url: job.url,
    };
    job.formulaRescueAttempted = false;
    this.jobs.save(job);
    this.events.info(`「${job.name}」正在手动重新截图识别（AI 视觉）…`);
    const imageQids = (job.questions || []).filter((q) => Number(q.imageCount) > 0 || q.latex).map((q) => String(q.qid));
    const r = await this._tryFormulaRescue({
      work,
      job,
      cx,
      engine,
      materialsText: '',
      emit: (type, data) => this.events.broadcast(type, data),
      qids: imageQids,
    });
    if (!r.ok) throw new Error(r.error || '截图识别失败');
    job.formulaOcr = r.ocrText;
    this.jobs.save(job);
    this.events.info(`「${job.name}」重新识别完成：${r.ocrText.length} 字`);
    return { ok: true, text: r.ocrText, uncertain: Boolean(r.uncertain), screenshots: r.screenshots || [] };
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
      // 跳过题在提交前显式写空，避免学习通页面残留暂存答案
      const submitMap = { ...((job.answers && job.answers.answers) || {}) };
      for (const qid of (job.skippedQuestions || [])) submitMap[String(qid)] = '';
      const sub = await cx.submitAnswers(work, { ...(job.answers || {}), answers: submitMap });
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
