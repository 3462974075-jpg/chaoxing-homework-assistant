/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// SSE 事件总线 + 运行日志环形缓冲。
export class EventHub {
  constructor({ keepAliveMs = 25000 } = {}) {
    this.clients = new Map(); // id -> { res }
    this.seq = 0;
    this.logs = [];
    this.keepAliveMs = keepAliveMs;
    this.timer = setInterval(() => this.ping(), keepAliveMs);
    this.timer.unref?.();
  }

  addClient(req, res) {
    const id = ++this.seq;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    this.clients.set(id, { res });
    const cleanup = () => this.clients.delete(id);
    req.on('close', cleanup);
    req.on('error', cleanup);
    return id;
  }

  ping() {
    for (const [, c] of this.clients) {
      try { c.res.write(`: ping\n\n`); } catch {}
    }
  }

  broadcast(type, data = {}) {
    const payload = JSON.stringify({ type, ts: new Date().toISOString(), ...data });
    for (const [id, c] of this.clients) {
      try { c.res.write(`data: ${payload}\n\n`); } catch { this.clients.delete(id); }
    }
  }

  log(level, message, extra = {}) {
    const item = {
      level,
      message: String(message),
      ts: new Date().toISOString(),
      ...extra,
    };
    this.logs.push(item);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    const tag = `[${item.ts.slice(11, 19)}]`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(tag, message);
    this.broadcast('log', item);
    return item;
  }

  info(message, extra) { return this.log('info', message, extra); }
  warn(message, extra) { return this.log('warn', message, extra); }
  error(message, extra) { return this.log('error', message, extra); }

  recentLogs(n = 200) {
    return this.logs.slice(-n);
  }

  close() {
    clearInterval(this.timer);
    for (const [, c] of this.clients) {
      try { c.res.end(); } catch {}
    }
    this.clients.clear();
  }
}
