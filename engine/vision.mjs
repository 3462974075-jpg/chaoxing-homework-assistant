/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * vision.mjs — 图片识题 / OCR（DeepSeek Messages 图像输入）
 *
 * 背景：引擎主流程只做文本推理；用户把题目照片放进 data\materials\<workId>\ 时，
 * 这里调用 DeepSeek 官方 Messages 接口（Anthropic 兼容，默认 baseURL
 * https://api.deepseek.com/anthropic），用支持图像输入的 deepseek-flash 提取文字，
 * 再把文字交给 prompts/makeSubmissionDoc。API Key 从私有 DSH_HOME 的 .credentials.yaml 读取。
 *
 * 设计：
 *   - 一张图一次请求（避免多图总大小超限），顺序执行；
 *   - 结果缓存到 cacheDir（按 文件路径+mtime+size+model+prompt 哈希），重跑不重复计费；
 *   - 大图/非常见格式先缩放到 ≤2000px、JPEG 质量 85（PowerShell System.Drawing），失败则用原图；
 *   - 绝不把图片内容或 Key 打印到日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const DEFAULT_VISION_MODEL = 'deepseek-flash';
export const DEFAULT_VISION_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DEFAULT_OCR_PROMPT = [
  '请提取这张图片中的全部文字，尽量保持原有顺序与结构：',
  '1) 题号、题干、选项（A/B/C/D）、代码、公式、表格按原样输出；',
  '2) 不要总结、不要解释、不要补充图片中没有的内容；',
  '3) 如果图片是教材/作业页照片，按从上到下、从左到右的顺序转录；',
  '4) 只输出文字本身。',
].join('\n');

/** 作答页截图专用：重点保留数学公式；复杂/不确定时追加标记，供 UI 提醒用户核对。 */
export const FORMULA_OCR_PROMPT = [
  '你在识别学习通作业作答页截图。请逐题提取文字：',
  '1) 保留题号、题干、选项（A/B/C/D）、填空位置、单位；',
  '2) 数学公式尽量转成 LaTeX（如 $\\frac{a}{b}$、$x^2$），不要省略公式；',
  '3) 不要总结、不要解释、不要编造图片中没有的内容；',
  '4) 如果某道题有复杂公式、看不清或无法确定，在输出最后单独一行写：[[FORMULA_UNCERTAIN]]',
  '5) 只输出文字本身（含必要的标记行）。',
].join('\n');

/** 复杂/不确定公式标记（由视觉模型在末尾输出） */
export const FORMULA_UNCERTAIN_MARKER = '[[FORMULA_UNCERTAIN]]';

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tif?f)$/i;
const MEDIA_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

export function isImageFile(file) {
  return IMAGE_EXT.test(String(file || ''));
}

/** 从 DSH 凭据文件读 API Key（只在本进程内使用）。 */
export function readDshApiKey(dshHome) {
  const candidates = [
    path.join(dshHome || '', '.credentials.yaml'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.credentials.yaml'),
  ];
  for (const f of candidates) {
    try {
      if (!f || !fs.existsSync(f)) continue;
      const text = fs.readFileSync(f, 'utf8');
      const m = text.match(/DEEPSEEK_API_KEY:\s*([^\s#]+)/);
      if (m && m[1]) return m[1].trim();
    } catch {}
  }
  return process.env.DEEPSEEK_API_KEY || '';
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function runPowerShell(script, args = [], timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, ...args], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'resize timeout' });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, error: code === 0 ? '' : 'exit ' + code }); });
  });
}

/**
 * 准备图片：返回 { file, mediaType, cleanup }
 * 大于 3.6MB 或非常见格式时，用 PowerShell System.Drawing 缩放/转 JPEG。
 */
export async function prepareImage(file, { tmpDir, maxPixels = 2000, maxBytes = 3.6 * 1024 * 1024 } = {}) {
  const ext = path.extname(file).toLowerCase();
  let mediaType = MEDIA_TYPES[ext] || 'image/jpeg';
  let target = file;
  let cleanup = null;
  const stat = fs.statSync(file);
  const needsConvert = !['.jpg', '.jpeg', '.png', '.webp'].includes(ext) || stat.size > maxBytes;
  if (needsConvert) {
    const outDir = ensureDir(tmpDir || path.join(process.cwd(), '.vision-tmp'));
    const out = path.join(outDir, `vision-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`);
    const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile($args[0])
try {
  $max=${maxPixels}
  $w=$src.Width; $h=$src.Height
  $ratio=[Math]::Min(1.0, [Math]::Min($max/$w, $max/$h))
  $nw=[int][Math]::Max(1,[Math]::Round($w*$ratio)); $nh=[int][Math]::Max(1,[Math]::Round($h*$ratio))
  $bmp=New-Object System.Drawing.Bitmap($nw,$nh)
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src,0,0,$nw,$nh)
  $g.Dispose()
  $enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $ps=New-Object System.Drawing.Imaging.EncoderParameters(1)
  $ps.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,85)
  $bmp.Save($args[1],$enc,$ps)
  $bmp.Dispose()
} finally { $src.Dispose() }
`;
    const r = await runPowerShell(script, [file, out]);
    if (r.ok && fs.existsSync(out)) {
      target = out;
      mediaType = 'image/jpeg';
      cleanup = () => { try { fs.unlinkSync(out); } catch {} };
    }
  }
  return { file: target, mediaType, cleanup };
}

async function callVision({ apiKey, baseURL, model, imageFile, mediaType, prompt, maxTokens, timeoutMs, log }) {
  const buf = fs.readFileSync(imageFile);
  const b64 = buf.toString('base64');
  const url = String(baseURL).replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/messages';
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: prompt },
      ],
    }],
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || 120000),
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = new Error(`vision HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (res.status === 401 || res.status === 403) break;
        continue;
      }
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('vision 返回非 JSON'); }
      const blocks = Array.isArray(json.content) ? json.content : [];
      const parts = blocks.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text);
      const out = parts.join('\n').trim();
      if (!out) {
        const hasThinking = blocks.some((b) => b && b.type === 'thinking');
        throw new Error(hasThinking ? '模型只返回了思考过程、没有输出文字' : '模型返回为空');
      }
      return {
        ok: true,
        text: out,
        model: json.model || model,
        usage: json.usage || null,
        bytes: buf.length,
      };
    } catch (e) {
      lastErr = e;
      if (e && (e.name === 'AbortError' || /abort/i.test(e.message))) break;
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'vision 调用失败' };
}

/**
 * 批量 OCR/识题。
 * @param {object} p
 * @param {string[]} p.files 图片路径
 * @param {string} [p.dshHome] 私有 DSH_HOME（读 .credentials.yaml）
 * @param {string} [p.apiKey] 直接给 Key（优先级最高）
 * @param {string} [p.cacheDir] 缓存目录；给了就按文件哈希缓存
 * @param {string} [p.model] 默认 deepseek-flash（支持图像）
 * @param {string} [p.baseURL] 默认 https://api.deepseek.com/anthropic
 * @param {string} [p.prompt] 默认 OCR 提示词
 * @param {number} [p.maxTokens] 默认 8192
 * @param {Function} [p.log]
 * @param {Function} [p.onEvent]
 */
export async function ocrImages({
  files = [],
  dshHome = '',
  apiKey = '',
  cacheDir = '',
  model = DEFAULT_VISION_MODEL,
  baseURL = process.env.DEEPSEEK_BASE_URL || DEFAULT_VISION_BASE_URL,
  prompt = DEFAULT_OCR_PROMPT,
  maxTokens = 8192,
  maxPixels = 2000,
  timeoutMs = 120000,
  log = () => {},
  onEvent = () => {},
} = {}) {
  const images = (files || []).filter(isImageFile);
  if (!images.length) return { ok: true, texts: [], combined: '', errors: [], model };
  const key = apiKey || readDshApiKey(dshHome);
  if (!key) {
    return { ok: false, texts: [], combined: '', errors: images.map((f) => ({ file: f, error: '未找到 DeepSeek API Key' })), model };
  }
  if (cacheDir) ensureDir(cacheDir);
  const texts = [];
  const errors = [];
  for (let i = 0; i < images.length; i += 1) {
    const file = images[i];
    const name = path.basename(file);
    let st = { size: 0, mtimeMs: 0 };
    try { st = fs.statSync(file); } catch {}
    const cacheKey = cacheDir
      ? path.join(cacheDir, `${sha1(`${file}|${st.size}|${st.mtimeMs}|${model}|${prompt}|${maxPixels}`)}.txt`)
      : '';
    if (cacheKey && fs.existsSync(cacheKey)) {
      const cached = fs.readFileSync(cacheKey, 'utf8');
      texts.push({ file, text: cached, cached: true });
      onEvent({ type: 'vision', phase: 'cache', index: i + 1, total: images.length, file: name });
      log(`[vision] 命中缓存：${name}（${cached.length} 字）`);
      continue;
    }
    onEvent({ type: 'vision', phase: 'start', index: i + 1, total: images.length, file: name });
    log(`[vision] 识别图片 ${i + 1}/${images.length}：${name}（${(st.size / 1024 / 1024).toFixed(2)}MB）`);
    let prepared = null;
    try {
      prepared = await prepareImage(file, { tmpDir: cacheDir ? path.join(cacheDir, 'tmp') : '', maxPixels });
      const r = await callVision({
        apiKey: key, baseURL, model,
        imageFile: prepared.file, mediaType: prepared.mediaType,
        prompt, maxTokens, timeoutMs, log,
      });
      if (r.ok) {
        texts.push({ file, text: r.text, cached: false, bytes: r.bytes, model: r.model, usage: r.usage });
        if (cacheKey) { try { fs.writeFileSync(cacheKey, r.text, 'utf8'); } catch {} }
        log(`[vision] 完成：${name}（${r.text.length} 字）`);
        onEvent({ type: 'vision', phase: 'done', index: i + 1, total: images.length, file: name, chars: r.text.length });
      } else {
        errors.push({ file, error: r.error });
        log(`[vision] 失败：${name} — ${r.error}`);
        onEvent({ type: 'vision', phase: 'error', index: i + 1, total: images.length, file: name, error: r.error });
      }
    } catch (e) {
      errors.push({ file, error: e.message });
      log(`[vision] 异常：${name} — ${e.message}`);
      onEvent({ type: 'vision', phase: 'error', index: i + 1, total: images.length, file: name, error: e.message });
    } finally {
      try { prepared && prepared.cleanup && prepared.cleanup(); } catch {}
    }
  }
  const combined = texts
    .map((t) => `【图片：${path.basename(t.file)}】\n${String(t.text || '').slice(0, 20000)}`)
    .join('\n\n');
  return { ok: texts.length > 0, texts, combined, errors, model, attempted: images.length };
}

export default { ocrImages, prepareImage, isImageFile, readDshApiKey, DEFAULT_OCR_PROMPT, FORMULA_OCR_PROMPT, FORMULA_UNCERTAIN_MARKER, DEFAULT_VISION_MODEL };
