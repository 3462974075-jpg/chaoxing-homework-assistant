/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 每项作业的持久化状态（data/jobs/<workId>/state.json），支持断点续跑与详情查看。
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './paths.mjs';

function jobDir(workId) {
  return path.join(DIRS.jobs, String(workId));
}

function jobFile(workId) {
  return path.join(jobDir(workId), 'state.json');
}

export class JobStore {
  constructor() {
    this.jobs = new Map();
    this.loadAll();
  }

  loadAll() {
    try {
      if (!fs.existsSync(DIRS.jobs)) return;
      for (const name of fs.readdirSync(DIRS.jobs)) {
        const f = path.join(DIRS.jobs, name, 'state.json');
        if (!fs.existsSync(f)) continue;
        try {
          const job = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (job && job.workId) this.jobs.set(String(job.workId), job);
        } catch {}
      }
    } catch {}
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  get(workId) {
    return this.jobs.get(String(workId)) || null;
  }

  ensure(work) {
    const workId = String(work.workId);
    let job = this.jobs.get(workId);
    if (!job) {
      job = {
        workId,
        courseId: work.courseId || '',
        courseName: work.courseName || '',
        name: work.name || '',
        kind: work.kind || 'unknown',
        status: work.status || '',
        url: work.url || '',
        phase: 'idle',
        steps: [],
        questions: [],
        answers: null,
        files: [],
        result: null,
        paused: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.jobs.set(workId, job);
    } else {
      // 刷新元信息，保留进度
      job.courseId = work.courseId || job.courseId;
      job.courseName = work.courseName || job.courseName;
      job.name = work.name || job.name;
      job.kind = work.kind || job.kind;
      job.status = work.status || job.status;
      job.url = work.url || job.url;
    }
    return job;
  }

  save(job) {
    job.updatedAt = new Date().toISOString();
    this.jobs.set(String(job.workId), job);
    const dir = jobDir(job.workId);
    fs.mkdirSync(dir, { recursive: true });
    const f = jobFile(job.workId);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
    fs.renameSync(tmp, f);
    return job;
  }

  /** 追加一条步骤记录 */
  step(job, name, status, message = '', extra = {}) {
    const s = { name, status, message, ts: new Date().toISOString(), ...extra };
    job.steps.push(s);
    if (job.steps.length > 200) job.steps.splice(0, job.steps.length - 200);
    this.save(job);
    return s;
  }

  writeArtifact(workId, name, content) {
    const dir = jobDir(workId);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
    return f;
  }

  dirOf(workId) {
    return jobDir(workId);
  }
}
