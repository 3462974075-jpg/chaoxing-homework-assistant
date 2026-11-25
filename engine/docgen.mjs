/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.5.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * docgen.mjs — 零依赖 .docx 读写（ZIP + OOXML）
 *
 * 设计要点（对应设计说明 5.2.1）：
 *   - 不依赖任何 npm 包、不依赖 Python；只用 node:zlib / node:fs / node:path。
 *   - 自写 ZIP 读写（EOCD / 中央目录 / 本地头）+ CRC32。
 *   - docxToText(path)            提取纯文本（段落按行，表格按制表符）
 *   - parseDocx(path)             返回 { paragraphs:[{text,style}], tables:[{rows}], text }
 *   - newDocx({title, blocks, outPath})   生成新文档（标题/段落/表格/代码块/分页）
 *   - fillDocxTemplate(templatePath, ops, outPath)  模板占位符替换 + 段落锚点插入 + 兜底追加
 *
 * 说明：
 *   - 真实模板 `第6次作业模板.docx` 的 document.xml 里存在 550KB 图片（header logo），
 *     本模块重打包时原样保留所有未修改的 zip 条目（含二进制），不会损坏图片。
 *   - 模板文字提取兼容 `<w:t>` 跨 run 拆分、`<w:tab/>`、`<w:br/>`、XML 实体。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ========================================================================== *
 * 1. CRC32 / ZIP 读写
 * ========================================================================== */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** 计算 Buffer 的 CRC32（无符号 32 位整数） */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function dosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 读取 ZIP 为条目数组（保持原始顺序）。
 * @param {Buffer} buf
 * @returns {{name:string, data:Buffer, isDir:boolean}[]}
 */
export function readZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件：未找到 EOCD 记录');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new Error(`ZIP 中央目录损坏（第 ${i} 项，offset=${offset}）`);
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOff = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    const isDir = name.endsWith('/');
    if (isDir) {
      entries.push({ name, data: Buffer.alloc(0), isDir: true });
      continue;
    }
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) {
      throw new Error(`ZIP 本地头损坏：${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`不支持的 ZIP 压缩方式 ${method}：${name}`);
    if (uncompSize && data.length !== uncompSize) {
      throw new Error(`ZIP 解压长度不符：${name} 期望 ${uncompSize} 实际 ${data.length}`);
    }
    void flags;
    entries.push({ name, data, isDir: false });
  }
  return entries;
}

/**
 * 把条目写成新的 ZIP Buffer。
 * @param {{name:string, data?:Buffer, isDir?:boolean}[]} entries
 */
export function writeZip(entries) {
  const now = dosDateTime();
  const chunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name;
    const nameBuf = Buffer.from(name, 'utf8');
    const isDir = entry.isDir || name.endsWith('/');
    const flags = /[^\x00-\x7f]/.test(name) ? 0x0800 : 0;
    let method = 0;
    let crc = 0;
    let raw = Buffer.alloc(0);
    let comp = Buffer.alloc(0);
    if (!isDir) {
      raw = entry.data ?? Buffer.alloc(0);
      crc = crc32(raw);
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        method = 8;
        comp = deflated;
      } else {
        method = 0;
        comp = raw;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(isDir ? 0x10 : 0, 38); // external attrs（目录位）
    central.writeUInt32LE(offset, 42); // local header offset
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...centralChunks, eocd]);
}

/** 读取 ZIP → 条目数组（文件版） */
export function readZipFile(filePath) {
  return readZip(fs.readFileSync(filePath));
}

/** 修改 ZIP 中一个条目后写出（其余条目原样保留） */
export function replaceZipEntry(entries, name, data) {
  let found = false;
  const out = entries.map((e) => {
    if (e.name === name) {
      found = true;
      return { name: e.name, data, isDir: false };
    }
    return e;
  });
  if (!found) out.push({ name, data, isDir: false });
  return out;
}

/* ========================================================================== *
 * 2. XML 基础工具
 * ========================================================================== */

export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function decodeXmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &amp; 最后处理，避免二次解码
    .replace(/&amp;/g, '&');
}

/** 取 `<w:body>` 内部 XML（找不到则返回整段） */
function bodyInner(documentXml) {
  const start = documentXml.indexOf('<w:body');
  if (start < 0) return documentXml;
  const openEnd = documentXml.indexOf('>', start);
  const end = documentXml.lastIndexOf('</w:body>');
  if (openEnd < 0 || end < 0) return documentXml.slice(openEnd + 1);
  return documentXml.slice(openEnd + 1, end);
}

/**
 * 从 `<w:p>` XML 提取文本（对齐 python-docx 的 paragraph.text 语义：
 * w:t / w:tab / w:br / w:cr / w:noBreakHyphen）。
 */
export function paragraphText(pXml) {
  if (!pXml) return '';
  const parts = [];
  const re = /<w:(t|tab|br|cr|noBreakHyphen)(?=[\s/>])/g;
  let m;
  while ((m = re.exec(pXml))) {
    const tag = m[1];
    const tagStart = m.index;
    const openEnd = pXml.indexOf('>', tagStart);
    if (openEnd < 0) break;
    const selfClosing = pXml[openEnd - 1] === '/';
    if (tag === 't') {
      if (selfClosing) continue;
      const close = pXml.indexOf('</w:t>', openEnd + 1);
      if (close < 0) continue;
      parts.push(decodeXmlEntities(pXml.slice(openEnd + 1, close)));
      re.lastIndex = close + 6;
    } else if (selfClosing) {
      if (tag === 'tab') parts.push('\t');
      else if (tag === 'br' || tag === 'cr') parts.push('\n');
      else if (tag === 'noBreakHyphen') parts.push('-');
    }
  }
  return parts.join('');
}

/** 在 `from` 位置处找到标签的配闭合位置（含嵌套），返回闭合标签结束下标 */
function findMatchingEnd(xml, tagName, openStart) {
  const re = new RegExp(`<${tagName}(?=[\\s/>])|</${tagName}>`, 'g');
  re.lastIndex = openStart;
  let depth = 0;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else {
      const gt = xml.indexOf('>', m.index);
      if (gt < 0) return xml.length;
      if (xml[gt - 1] === '/') {
        // 自闭合：不计深度；若尚在顶层则直接结束
        if (depth === 0) return gt + 1;
      } else {
        depth++;
      }
    }
  }
  return xml.length;
}

/**
 * 把 body 拆成顶层条目：{kind:'p'|'tbl'|'other', xml, start}
 * 说明：w:p 内可能嵌 textbox 里的 w:p，用配对计数避免切错。
 */
export function splitBodyItems(bodyXml) {
  const items = [];
  let i = 0;
  while (i < bodyXml.length) {
    const pIdx = bodyXml.indexOf('<w:p', i);
    const tIdx = bodyXml.indexOf('<w:tbl', i);
    let next = -1;
    let kind = null;
    if (pIdx >= 0 && (tIdx < 0 || pIdx < tIdx)) {
      const ch = bodyXml[pIdx + 4];
      if (ch === ' ' || ch === '>' || ch === '/') {
        next = pIdx;
        kind = 'p';
      } else {
        // 例如 <w:pPr> 之类，跳过这个前缀
        i = pIdx + 4;
        continue;
      }
    } else if (tIdx >= 0) {
      next = tIdx;
      kind = 'tbl';
    }
    if (next < 0) break;
    if (kind === 'p') {
      const end = findMatchingEnd(bodyXml, 'w:p', next);
      items.push({ kind: 'p', xml: bodyXml.slice(next, end), start: next, end });
      i = end;
    } else {
      const end = findMatchingEnd(bodyXml, 'w:tbl', next);
      items.push({ kind: 'tbl', xml: bodyXml.slice(next, end), start: next, end });
      i = end;
    }
  }
  return items;
}

/** 从段落 XML 取 pPr XML（无则空串） */
export function paragraphPPr(pXml) {
  const m = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(pXml);
  return m ? m[0] : '';
}

/** 取第一个 run 的 rPr（无则空串） */
function firstRunRPr(pXml) {
  const m = /<w:r>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)?/.exec(pXml);
  return m && m[1] ? m[1] : '';
}

function pStyleId(pXml) {
  const m = /<w:pStyle\s+w:val="([^"]+)"/.exec(pXml);
  return m ? m[1] : null;
}

/* ========================================================================== *
 * 3. 解析 docx
 * ========================================================================== */

function parseStyles(stylesXml) {
  const idToName = new Map();
  if (!stylesXml) return { idToName, defaultParagraphStyle: 'Normal' };
  const styleRe = /<w:style\b[\s\S]*?<\/w:style>/g;
  let m;
  let defaultParagraphStyle = null;
  while ((m = styleRe.exec(stylesXml))) {
    const block = m[0];
    const idMatch = /<w:style\b[^>]*\bw:styleId="([^"]+)"/.exec(block);
    const nameMatch = /<w:name\s+w:val="([^"]+)"/.exec(block);
    if (!idMatch) continue;
    const id = idMatch[1];
    const name = nameMatch ? decodeXmlEntities(nameMatch[1]) : id;
    idToName.set(id, name);
    if (/\bw:type="paragraph"/.test(block) && /\bw:default="1"/.test(block)) {
      defaultParagraphStyle = name;
    }
  }
  return { idToName, defaultParagraphStyle: defaultParagraphStyle || 'Normal' };
}

const KNOWN_STYLE_NAMES = new Map([
  ['normal', 'Normal'],
  ['body text', 'Body Text'],
  ['title', 'Title'],
  ['subtitle', 'Subtitle'],
  ['quote', 'Quote'],
  ['caption', 'Caption'],
  ['list paragraph', 'List Paragraph'],
  ['table grid', 'Table Grid'],
  ['footnote text', 'Footnote Text'],
  ['header', 'Header'],
  ['footer', 'Footer'],
]);

/** 把 styles.xml 的 name 转成 python-docx 风格的显示名 */
function displayStyleName(rawName) {
  const lower = String(rawName || '').toLowerCase();
  const heading = /^heading (\d)$/.exec(lower);
  if (heading) return `Heading ${heading[1]}`;
  if (KNOWN_STYLE_NAMES.has(lower)) return KNOWN_STYLE_NAMES.get(lower);
  return rawName;
}

function parseTable(tblXml) {
  const rows = [];
  const trRe = /<w:tr(?=[\s/>])/g;
  let trMatch;
  while ((trMatch = trRe.exec(tblXml))) {
    const trEnd = findMatchingEnd(tblXml, 'w:tr', trMatch.index);
    const trXml = tblXml.slice(trMatch.index, trEnd);
    trRe.lastIndex = trEnd;
    const cells = [];
    const tcRe = /<w:tc(?=[\s/>])/g;
    let tcMatch;
    while ((tcMatch = tcRe.exec(trXml))) {
      const tcEnd = findMatchingEnd(trXml, 'w:tc', tcMatch.index);
      const tcXml = trXml.slice(tcMatch.index, tcEnd);
      tcRe.lastIndex = tcEnd;
      // 单元格文本：python-docx 用 '\n' 连接其内部段落
      const pTexts = [];
      const pRe = /<w:p(?=[\s/>])/g;
      let pMatch;
      while ((pMatch = pRe.exec(tcXml))) {
        const pEnd = findMatchingEnd(tcXml, 'w:p', pMatch.index);
        pTexts.push(paragraphText(tcXml.slice(pMatch.index, pEnd)));
        pRe.lastIndex = pEnd;
      }
      const cellText = (pTexts.length ? pTexts : [paragraphText(tcXml)]).join('\n');
      cells.push(cellText);
    }
    rows.push(cells);
  }
  return { rows };
}

/**
 * 解析 docx。
 * @param {string} filePath
 * @returns {{paragraphs:{text:string,style:string}[], tables:{rows:string[][]}[], text:string}}
 */
export function parseDocx(filePath) {
  const entries = readZipFile(filePath);
  const docEntry = entries.find((e) => e.name === 'word/document.xml');
  if (!docEntry) throw new Error(`不是有效的 docx（缺少 word/document.xml）：${filePath}`);
  const stylesEntry = entries.find((e) => e.name === 'word/styles.xml');
  const { idToName, defaultParagraphStyle } = parseStyles(
    stylesEntry ? stylesEntry.data.toString('utf8') : ''
  );
  const documentXml = docEntry.data.toString('utf8');
  const items = splitBodyItems(bodyInner(documentXml));

  const paragraphs = [];
  const tables = [];
  const lines = [];
  for (const item of items) {
    if (item.kind === 'p') {
      const text = paragraphText(item.xml);
      const id = pStyleId(item.xml);
      const style = displayStyleName(id ? idToName.get(id) ?? id : defaultParagraphStyle);
      paragraphs.push({ text, style });
      lines.push(text);
    } else if (item.kind === 'tbl') {
      const table = parseTable(item.xml);
      tables.push(table);
      for (const row of table.rows) lines.push(row.join('\t'));
    }
  }
  return { paragraphs, tables, text: lines.join('\n') };
}

/** 提取 docx 纯文本（供引擎读模板/资料） */
export function docxToText(filePath) {
  const { paragraphs, tables } = parseDocx(filePath);
  const lines = paragraphs.map((p) => p.text);
  for (const t of tables) for (const row of t.rows) lines.push(row.join('\t'));
  return lines.join('\n');
}

/* ========================================================================== *
 * 4. 生成 docx（newDocx）
 * ========================================================================== */

const NS_DECL = [
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"',
  'xmlns:wpsCustomData="http://www.wps.cn/officeDocument/2013/wpsCustomData"',
].join(' ');

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const FONT_CN = '宋体';
const FONT_EN = 'Times New Roman';

/** 生成一个 run：支持 **粗体** 与行内 `代码`，\n 转 w:br，\t 转 w:tab */
function buildRuns(text, { bold: forceBold = false, mono = false, sizeHalfPt = null } = {}) {
  const runs = [];
  const segments = [];
  let rest = String(text ?? '');
  // 简单行内解析：**bold** / `code`
  const inlineRe = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = inlineRe.exec(rest))) {
    if (m.index > last) segments.push({ text: rest.slice(last, m.index) });
    if (m[1] !== undefined) segments.push({ text: m[1], bold: true });
    else segments.push({ text: m[2], mono: true });
    last = m.index + m[0].length;
  }
  if (last < rest.length) segments.push({ text: rest.slice(last) });
  if (!segments.length) segments.push({ text: '' });

  for (const seg of segments) {
    const bold = forceBold || seg.bold;
    const isMono = mono || seg.mono;
    const rPrParts = [
      `<w:rFonts w:ascii="${isMono ? 'Consolas' : FONT_EN}" w:hAnsi="${
        isMono ? 'Consolas' : FONT_EN
      }" w:eastAsia="${FONT_CN}"/>`,
    ];
    if (bold) rPrParts.push('<w:b/><w:bCs/>');
    if (sizeHalfPt) rPrParts.push(`<w:sz w:val="${sizeHalfPt}"/><w:szCs w:val="${sizeHalfPt}"/>`);
    const rPr = `<w:rPr>${rPrParts.join('')}</w:rPr>`;
    const pieces = seg.text.split(/(\n|\t)/).filter((s) => s !== '');
    if (!pieces.length) pieces.push('');
    for (const piece of pieces) {
      if (piece === '\n') runs.push(`<w:r>${rPr}<w:br/></w:r>`);
      else if (piece === '\t') runs.push(`<w:r>${rPr}<w:tab/></w:r>`);
      else runs.push(`<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(piece)}</w:t></w:r>`);
    }
  }
  return runs.join('');
}

function buildParagraph(text, { styleId = null, align = null, bold = false, mono = false, sizeHalfPt = null, pPrExtra = '' } = {}) {
  const pPr = `<w:pPr>${styleId ? `<w:pStyle w:val="${styleId}"/>` : ''}${
    align ? `<w:jc w:val="${align}"/>` : ''
  }${pPrExtra}</w:pPr>`;
  return `<w:p>${pPr}${buildRuns(text, { bold, mono, sizeHalfPt })}</w:p>`;
}

function buildTable(rows, { header = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const colWidth = Math.floor(9000 / Math.max(1, cols));
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colWidth}"/>`).join('')}</w:tblGrid>`;
  const borders =
    '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:tblBorders>';
  const tblPr =
    `<w:tblPr><w:tblW w:w="${colWidth * cols}" w:type="dxa"/>${borders}` +
    '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>' +
    '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>';
  const trs = rows
    .map((row, ri) => {
      const tcs = Array.from({ length: cols }, (_, ci) => {
        const cellText = row[ci] == null ? '' : String(row[ci]);
        const bold = header && ri === 0;
        const p = buildParagraph(cellText, {
          align: 'center',
          bold,
          pPrExtra: '<w:spacing w:before="20" w:after="20"/>',
        });
        return `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${p}</w:tc>`;
      }).join('');
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join('');
  return `<w:tbl>${tblPr}${grid}${trs}</w:tbl>`;
}

function blockXml(block, { headingStyleIds = null, anchorPPr = '' } = {}) {
  const type = (block && block.type) || 'p';
  const text = block && (block.text ?? block.content ?? '');
  switch (type) {
    case 'title':
      return buildParagraph(String(text), { styleId: 'Title', align: 'center', bold: true, sizeHalfPt: 36 });
    case 'h1':
    case 'heading1':
      return buildParagraph(String(text), { styleId: headingStyleIds?.h1 || 'Heading1', bold: true });
    case 'h2':
    case 'heading2':
      return buildParagraph(String(text), { styleId: headingStyleIds?.h2 || 'Heading2', bold: true });
    case 'h3':
    case 'heading3':
      return buildParagraph(String(text), { styleId: headingStyleIds?.h3 || 'Heading3', bold: true });
    case 'heading':
      return buildParagraph(String(text), { styleId: 'Heading1', bold: true });
    case 'bullet':
    case 'li': {
      return buildParagraph(`• ${String(text)}`, { pPrExtra: '<w:ind w:left="420" w:hanging="210"/>' });
    }
    case 'code': {
      return String(text)
        .split('\n')
        .map((line) => buildParagraph(line, { mono: true, pPrExtra: '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' }))
        .join('');
    }
    case 'pagebreak':
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case 'spacer':
      return '<w:p/>';
    case 'table': {
      const rows = block.rows || (block.data ?? []);
      return buildTable(rows, { header: block.header !== false });
    }
    case 'p':
    case 'paragraph':
    default: {
      // 支持文本内多段落（按 \n 拆），保持锚点段落的 pPr 风格
      const lines = String(text).split('\n');
      return lines
        .map((line) => {
          if (anchorPPr) return `<w:p>${anchorPPr}${buildRuns(line)}</w:p>`;
          return buildParagraph(line);
        })
        .join('');
    }
  }
}

/** 把 markdown 转成 blocks（供 AI 返回的 content 使用） */
export function markdownToBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      if (inCode) {
        blocks.push({ type: 'code', text: codeBuf.join('\n') });
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const level = Math.min(3, heading[1].length);
      blocks.push({ type: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', text: heading[2].trim() });
      i++;
      continue;
    }
    // markdown 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const rows = [];
      const parseRow = (l) =>
        l
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      rows.push(parseRow(line));
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', rows, header: true });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ type: 'bullet', text: bullet[1].trim() });
      i++;
      continue;
    }
    const numbered = /^\s*\d+[.)、]\s*(.*)$/.exec(line);
    if (numbered) {
      blocks.push({ type: 'p', text: line.trim() });
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      blocks.push({ type: 'p', text: line.replace(/^\s*>\s?/, '').trim() });
      i++;
      continue;
    }
    blocks.push({ type: 'p', text: line.trim() });
    i++;
  }
  if (inCode && codeBuf.length) blocks.push({ type: 'code', text: codeBuf.join('\n') });
  return blocks;
}

const CONTENT_TYPES_XML =
  XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>';

const ROOT_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

const DOC_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

function stylesXml() {
  const heading = (id, name, size, basedOn = 'Normal') =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return (
    XML_DECL +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT_EN}" w:hAnsi="${FONT_EN}" w:eastAsia="${FONT_CN}" w:cs="${FONT_EN}"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
    heading('Heading1', 'heading 1', 32) +
    heading('Heading2', 'heading 2', 28) +
    heading('Heading3', 'heading 3', 24) +
    '</w:styles>'
  );
}

function corePropsXml(title) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title || '')}</dc:title>` +
    '<dc:creator>ChaoxingHomeworkHelper</dc:creator>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

function appPropsXml() {
  return (
    XML_DECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>ChaoxingHomeworkHelper</Application></Properties>'
  );
}

function documentXmlFromBlocks(blocks) {
  const bodyParts = [];
  for (const block of blocks) bodyParts.push(blockXml(block));
  const sectPr =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr>';
  return (
    XML_DECL +
    `<w:document ${NS_DECL}><w:body>${bodyParts.join('')}${sectPr}</w:body></w:document>`
  );
}

/**
 * 生成新的 .docx。
 * @param {{title?:string, blocks?:any[], outPath:string}} opts
 * @returns {{filePath:string, paragraphs:number}}
 */
export function newDocx({ title, blocks = [], outPath }) {
  if (!outPath) throw new Error('newDocx：缺少 outPath');
  const allBlocks = [];
  if (title) allBlocks.push({ type: 'title', text: title });
  for (const b of blocks) allBlocks.push(b);
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8') },
    { name: '_rels/', isDir: true },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS_XML, 'utf8') },
    { name: 'docProps/', isDir: true },
    { name: 'docProps/core.xml', data: Buffer.from(corePropsXml(title), 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(appPropsXml(), 'utf8') },
    { name: 'word/', isDir: true },
    { name: 'word/_rels/', isDir: true },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOC_RELS_XML, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXmlFromBlocks(allBlocks), 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml(), 'utf8') },
  ];
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, writeZip(entries));
  const parsed = parseDocx(outPath);
  return { filePath: outPath, paragraphs: parsed.paragraphs.length };
}

/* ========================================================================== *
 * 5. 模板填充（fillDocxTemplate）
 * ========================================================================== */

/** 在单个段落内替换文字（优先只改单个 <w:t>，跨 run 时重建段落） */
function replaceInParagraphXml(pXml, find, replace) {
  if (!pXml.includes(find)) {
    // 文本可能被实体化或跨 run，先用提取文本判断
    if (!paragraphText(pXml).includes(find)) return null;
    // 跨 run：重建段落（保留 pPr + 首个 rPr）
  }
  // 1) 单 <w:t> 内直接替换（保留 run 级格式）
  let changed = false;
  const newXml = pXml.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (whole, attrs, inner) => {
    const decoded = decodeXmlEntities(inner);
    if (!decoded.includes(find)) return whole;
    changed = true;
    return `<w:t${attrs || ''} xml:space="preserve">${escapeXml(decoded.split(find).join(replace))}</w:t>`;
  });
  if (changed) return newXml;
  // 2) 跨 run：整段重建（保留 pPr 与首个 rPr）
  const text = paragraphText(pXml);
  if (!text.includes(find)) return null;
  const pPr = paragraphPPr(pXml);
  const rPr = firstRunRPr(pXml);
  const newText = text.split(find).join(replace);
  return rebuildParagraph(pXml, newText, pPr, rPr);
}

/** 用纯文本重建段落（保留 pPr 与首个 rPr） */
function rebuildParagraph(pXml, newText, pPr = paragraphPPr(pXml), rPr = firstRunRPr(pXml)) {
  const runs = newText
    .split('\n')
    .map((line, idx) => {
      const prefix = idx === 0 ? '' : '<w:br/>';
      const pieces = line.split('\t');
      const inner = pieces
        .map((piece, pi) => `${pi === 0 ? '' : '<w:tab/>'}<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`)
        .join('');
      return `<w:r>${rPr}${prefix}${inner}</w:r>`;
    })
    .join('');
  void pXml;
  return `<w:p>${pPr}${runs}</w:p>`;
}

/** 取模板中可用的标题样式 id（找不到则 null） */
function detectHeadingStyles(entries) {
  const stylesEntry = entries.find((e) => e.name === 'word/styles.xml');
  if (!stylesEntry) return null;
  const xml = stylesEntry.data.toString('utf8');
  const ids = new Set();
  const re = /<w:style\b[^>]*\bw:styleId="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml))) ids.add(m[1]);
  const pick = (candidates) => candidates.find((id) => ids.has(id)) || null;
  return {
    h1: pick(['Heading1', 'heading1', '1']),
    h2: pick(['Heading2', 'heading2', '2']),
    h3: pick(['Heading3', 'heading3', '3']),
  };
}

/**
 * 在模板基础上填充：支持占位符替换、段落锚点后插入、兜底追加。
 *
 * ops:
 *   { find: '{{name}}', replace: '廖思源' }                 // 占位符替换（跨 run 也支持）
 *   { after: { text: '课本习题三' }, insert: [blocks] }      // 在该段落之后插入
 *   { before: { text: '课本习题四' }, insert: [blocks] }
 *   { append: [blocks] }                                    // 追加到文末（sectPr 之前）
 * blocks 同 newDocx：{type:'p'|'h1'|'h2'|'h3'|'bullet'|'code'|'table'|'pagebreak'|'spacer', text|rows}
 *
 * 锚点找不到时：记录 warning，并在文末兜底追加该 op 的内容（保留模板原文）。
 *
 * @returns {{filePath:string, applied:any[], warnings:string[], docxText:string}}
 */
export function fillDocxTemplate(templatePath, ops = [], outPath) {
  if (!outPath) throw new Error('fillDocxTemplate：缺少 outPath');
  const fileBuf = fs.readFileSync(templatePath);
  const entries = readZip(fileBuf);
  const docEntry = entries.find((e) => e.name === 'word/document.xml');
  if (!docEntry) throw new Error(`不是有效的 docx（缺少 word/document.xml）：${templatePath}`);
  const documentXml = docEntry.data.toString('utf8');
  const bodyStart = documentXml.indexOf('<w:body');
  const openEnd = documentXml.indexOf('>', bodyStart);
  if (bodyStart < 0 || openEnd < 0) throw new Error('模板 document.xml 缺少 <w:body>');
  const bodyEnd = documentXml.lastIndexOf('</w:body>');
  const prefix = documentXml.slice(0, openEnd + 1);
  const suffix = documentXml.slice(bodyEnd);
  const inner = documentXml.slice(openEnd + 1, bodyEnd);
  const items = splitBodyItems(inner);
  const headingStyleIds = detectHeadingStyles(entries);

  // 把 body 表示为「节点序列」：item 节点（段落/表格）+ gap 节点（其余原始 XML，
  // 例如 sectPr、书签、空格），这样增删段落时不会丢 sectPr/页面设置。
  const nodes = [];
  {
    let pos = 0;
    for (const item of items) {
      if (item.start > pos) nodes.push({ kind: 'gap', xml: inner.slice(pos, item.start) });
      nodes.push({ kind: 'item', item, xml: item.xml });
      pos = item.end;
    }
    if (pos < inner.length) nodes.push({ kind: 'gap', xml: inner.slice(pos) });
  }

  const applied = [];
  const warnings = [];
  let fallbackBlocks = [];
  // 同一锚点多次插入时的游标：保证后插入的内容排在已插入内容之后（而不是反向插入）
  const insertCursors = new Map();

  const appendBlocks = (blocks, marker, detail) => {
    const xml = blocks.map((b) => blockXml(b, { headingStyleIds })).join('');
    // 追加位置：最后一个包含 sectPr 的节点之前；没有则文末
    let at = -1;
    for (let idx = nodes.length - 1; idx >= 0; idx--) {
      if (nodes[idx].xml.includes('<w:sectPr')) {
        at = idx;
        break;
      }
    }
    if (at < 0) at = nodes.length;
    nodes.splice(at, 0, { kind: 'raw', xml });
    applied.push({ op: marker, mode: 'append', ok: true, detail });
  };

  ops.forEach((op, opIndex) => {
    if (!op || typeof op !== 'object') return;
    if (op.append) {
      appendBlocks(op.append, opIndex, `追加 ${op.append.length} 个块`);
      return;
    }
    if (op.find !== undefined) {
      let count = 0;
      for (const node of nodes) {
        if (!node.item || node.item.kind !== 'p') continue;
        const replaced = replaceInParagraphXml(node.item.xml, op.find, op.replace ?? '');
        if (replaced) {
          node.item.xml = replaced;
          node.xml = replaced;
          count++;
          if (op.all === false) break;
        }
      }
      applied.push({ op: opIndex, mode: 'replace', ok: count > 0, detail: `替换 ${count} 处：${op.find}` });
      if (count === 0) warnings.push(`占位符未找到：${op.find}`);
      return;
    }
    const anchorText = (op.after && op.after.text) || (op.before && op.before.text) || null;
    if (anchorText) {
      let targetNodeIdx = -1;
      for (let idx = 0; idx < nodes.length; idx++) {
        const node = nodes[idx];
        if (!node.item || node.item.kind !== 'p') continue;
        if (paragraphText(node.item.xml).includes(anchorText)) {
          targetNodeIdx = idx;
          break;
        }
      }
      if (targetNodeIdx >= 0) {
        // 普通段落沿用锚点段落的 pPr（保持模板排版），标题/表格用自身样式
        const anchorPPr = paragraphPPr(nodes[targetNodeIdx].item.xml);
        const xml = (op.insert || [])
          .map((b) => blockXml(b, { headingStyleIds, anchorPPr }))
          .join('');
        let at;
        if (op.before) {
          at = targetNodeIdx;
        } else {
          at = insertCursors.has(anchorText) ? insertCursors.get(anchorText) : targetNodeIdx + 1;
        }
        nodes.splice(at, 0, { kind: 'raw', xml });
        if (!op.before) insertCursors.set(anchorText, at + 1);
        applied.push({
          op: opIndex,
          mode: op.before ? 'insert-before' : 'insert-after',
          ok: true,
          detail: anchorText,
        });
      } else {
        warnings.push(`锚点未找到：${anchorText}（内容已兜底追加到文末，模板原文保留）`);
        fallbackBlocks = fallbackBlocks.concat(op.insert || []);
        applied.push({ op: opIndex, mode: 'fallback-pending', ok: false, detail: anchorText });
      }
    }
  });

  if (fallbackBlocks.length) {
    appendBlocks(fallbackBlocks, 'fallback', `兜底追加 ${fallbackBlocks.length} 个块`);
  }

  const newInner = nodes.map((n) => n.xml).join('');
  const newDocXml = `${prefix}${newInner}${suffix}`;
  const newEntries = replaceZipEntry(entries, 'word/document.xml', Buffer.from(newDocXml, 'utf8'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, writeZip(newEntries));
  const parsed = parseDocx(outPath);
  return {
    filePath: outPath,
    applied,
    warnings,
    docxText: parsed.text,
    paragraphs: parsed.paragraphs,
    tables: parsed.tables,
  };
}

/** 模板里所有占位符（{{x}} 形式） */
export function listPlaceholders(filePath) {
  const text = docxToText(filePath);
  const found = new Set();
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let m;
  while ((m = re.exec(text))) found.add(m[0]);
  return [...found];
}

/** 去掉空白与常见标点，用于模板锚点模糊匹配 */
function normalizeForMatch(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[、，。；：:;,.!?！？（）()《》【】\[\]"'“”‘’]/g, '')
    .toLowerCase();
}

/**
 * 把 AI 生成的 blocks（markdown 展开后）映射到模板段落锚点，生成 fillDocxTemplate 的 ops。
 * 策略：
 *   1. 标题类 block 用其文字去匹配模板段落（整段包含 / 规范化包含 / 题号 token 匹配）；
 *   2. 命中后，后续普通 block 全部插到该锚点段落之后；
 *   3. 无法匹配的 block 收集起来，作为 append 兜底（追加文末）。
 *
 * @param {{paragraphs:{text:string,style:string}[], tables:any[]}} parsedTemplate parseDocx() 结果
 * @param {any[]} blocks markdownToBlocks() 结果
 * @param {{excludeAnchors?:string[]}} [opts] excludeAnchors：不应作为锚点的文字（如作业标题行）
 * @returns {{ops:any[], unmatched:any[], matchedAnchors:string[]}}
 */
export function buildTemplateOps(parsedTemplate, blocks = [], { excludeAnchors = [] } = {}) {
  const paragraphs = parsedTemplate?.paragraphs || [];
  const exclude = excludeAnchors.map(normalizeForMatch).filter(Boolean);
  const normParagraphs = paragraphs.map((p) => ({
    raw: p.text,
    norm: normalizeForMatch(p.text),
  }));
  const isExcluded = (norm) => exclude.some((e) => e && (norm === e || norm.includes(e)));
  const HEADING_TYPES = new Set(['title', 'h1', 'h2', 'h3', 'heading']);
  const findAnchor = (headingText) => {
    const norm = normalizeForMatch(headingText);
    if (!norm) return null;
    // 1) 整段规范化后完全相同（最可靠）
    const exact = normParagraphs.find((p) => p.norm && p.norm === norm && !isExcluded(p.norm));
    if (exact) return exact.raw;
    // 2) 模板段落包含标题文字（跳过标题/页眉等排除项）
    const direct = normParagraphs.find(
      (p) => p.norm && p.norm.includes(norm) && !isExcluded(p.norm)
    );
    if (direct) return direct.raw;
    // 3) 题号 token（「三」「四.13」「第三题」「1.2」也可出现在正文中）：
    //    要求模板段落是题目/章节行，取最短候选（最贴近题号行）
    const tokenMatch = /(?:第)?([一二三四五六七八九十百]+(?:[.．]\d+)?|\d+(?:[.．]\d+)?)/.exec(
      String(headingText)
    );
    if (tokenMatch) {
      const tryTokens = [normalizeForMatch(tokenMatch[0])];
      const numeral = /^(?:第)?([一二三四五六七八九十百]+|\d+)/.exec(tokenMatch[0]);
      if (numeral) tryTokens.push(normalizeForMatch(numeral[1]));
      for (const tk of tryTokens) {
        if (!tk) continue;
        const candidates = normParagraphs.filter(
          (p) =>
            p.norm &&
            !isExcluded(p.norm) &&
            p.norm.includes(tk) &&
            /(习题|题目|题|作业|练习|实验|任务)/.test(p.raw)
        );
        if (candidates.length) {
          candidates.sort((a, b) => a.norm.length - b.norm.length);
          return candidates[0].raw;
        }
      }
    }
    return null;
  };

  const ops = [];
  const opByAnchor = new Map();
  const unmatched = [];
  const matchedAnchors = [];
  let current = null;
  for (const block of blocks) {
    const type = block && block.type;
    if (HEADING_TYPES.has(type)) {
      const anchor = findAnchor(block.text);
      if (anchor) {
        // 多个 Markdown 标题映射到同一模板章节时合并为一个 op，保持内容顺序
        let op = opByAnchor.get(anchor);
        if (!op) {
          op = { after: { text: anchor }, insert: [] };
          opByAnchor.set(anchor, op);
          ops.push(op);
          matchedAnchors.push(anchor);
        }
        current = op;
      } else {
        current = null;
        unmatched.push(block);
      }
      continue;
    }
    if (current) current.insert.push(block);
    else unmatched.push(block);
  }
  // 去掉空 insert 的 op
  const filtered = ops.filter((op) => op.insert.length > 0);
  if (unmatched.length) filtered.push({ append: unmatched });
  return { ops: filtered, unmatched, matchedAnchors };
}

/* 未实现的其它格式（保持接口清晰，避免误用） */
export function xlsxToText() {
  throw new Error('xlsxToText 尚未实现（当前版本只需 docx）');
}
export function pptxToText() {
  throw new Error('pptxToText 尚未实现（当前版本只需 docx）');
}

/** 记录 document.xml 内的 sectPr（调试用） */
export function inspectDocx(filePath) {
  const entries = readZipFile(filePath);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  const xml = doc ? doc.data.toString('utf8') : '';
  const items = splitBodyItems(bodyInner(xml));
  return {
    entries: entries.map((e) => ({ name: e.name, size: e.data.length, isDir: !!e.isDir })),
    itemKinds: items.map((i) => i.kind),
    paragraphCount: items.filter((i) => i.kind === 'p').length,
    tableCount: items.filter((i) => i.kind === 'tbl').length,
    hasSectPr: /<w:sectPr\b/.test(xml),
  };
}
