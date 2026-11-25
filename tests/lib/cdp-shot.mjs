/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
// 极简 CDP 截图工具：启动 headless Edge（独立临时 profile）→ 打开页面 → 截图 → 关闭。
// 为什么不用 Edge 的 --screenshot：对带 SSE/长连接的页面会等待不退出，实测卡死。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJson(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400);
  }
  return null;
}

export async function shotPage(url, outPath, { port = 9223, width = 1360, height = 900, waitMs = 4000 } = {}) {
  const profile = path.join(os.tmpdir(), `cdp-shot-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  try {
    const ver = await waitJson(port, 20000);
    if (!ver) throw new Error('Edge headless 未启动 CDP');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可用标签页');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 失败')), { once: true });
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message));
        else p.res(m.result);
      }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await sleep(waitMs);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    ws.close();
    return outPath;
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    // 清理临时 profile（尽力而为）
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}
