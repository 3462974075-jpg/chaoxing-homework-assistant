/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.4.0
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
/**
 * 离线解析单测（不联网、不开浏览器）
 *
 * 样本：示例目录\
 *   - uav_dowork5.html      作答页（1 道"其它"附件题）
 *   - task5.html            作答页（17 道单选题，选项文本）
 *   - view3.html            作业详情页（15 题，含 LaTeX 公式题）
 *   - worklist2.html        作业列表（7 条）
 *   - math_worklist.html    作业列表（4 条，含"待重做"）
 *   - exam_list.html        考试列表（不是作业列表：断言识别 + 0 条）
 *   - attachment_dialog.html UEditor 附件上传对话框（无下载链接：断言 0 条不崩）
 *
 * 运行：node test\parse.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWorkList,
  parseQuestionsFromHtml,
  getAttachments,
  isExamListPage,
  computeKind,
  decodeEntities,
  stripTags,
  cleanText,
  decodeLatexData,
} from '../works.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(HERE, '..', '..', '..', '学习通_作业自动化');

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

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function read(name) {
  const f = path.join(SAMPLE_DIR, name);
  if (!fs.existsSync(f)) throw new Error(`缺少测试样本：${f}`);
  return fs.readFileSync(f, 'utf8');
}

function section(title) {
  console.log(`\n[${title}]`);
}

// ---------------------------------------------------------------- 作业列表
section('作业列表解析 parseWorkList');
{
  const html = read('worklist2.html');
  const works = parseWorkList(html);
  eq('worklist2 条数', works.length, 7);
  ok('worklist2 每条都有 workId', works.every((w) => /^\d+$/.test(w.workId)));
  const first = works[0];
  eq('第一条 workId', first.workId, '57985656');
  eq('第一条 名称', first.name, '第5章选择结构程序设计_前测');
  eq('第一条 状态', first.status, '未交');
  eq('第一条 剩余时间', first.left, '35小时29分钟');
  ok('第一条 URL 是作答入口', /\/mooc2\/work\/task\?/.test(first.url) && /workId=57985656/.test(first.url));
  ok(
    '解析出多种状态',
    new Set(works.map((w) => w.status)).size >= 2,
    works.map((w) => w.status).join('/')
  );
  ok('每条都有 kind 字段', works.every((w) => ['quiz', 'attach', 'mixed', 'unknown'].includes(w.kind)));
}
{
  const works = parseWorkList(read('math_worklist.html'));
  eq('math_worklist 条数', works.length, 4);
  eq('math_worklist 第一条 workId', works[0].workId, '57986827');
  eq('math_worklist 第一条 状态', works[0].status, '待重做');
}
{
  // 抗改版：单引号、onclick 带空格、属性顺序变化、name/status 顺序互换
  const variant = `<div class="bottomList"><ul>
    <li data='https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=1&classId=2&cpi=3&workId=9001&answerId=0&enc=abc'
        onkeydown="if(event.keyCode == 13){goTask(this);}" onclick = "goTask( this ) ;" tabindex="0">
      <div class="right-content">
        <p class='status fl'>未交</p>
        <p class="overHidden2 fl">改版兼容作业 &lt;测试&gt;</p>
        <div class='time notOver'>剩余 2小时</div>
      </div>
    </li>
    <li onclick='goTask(this)' data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?courseId=1&classId=2&cpi=3&workId=9002&answerId=0&enc=xyz">
      <p class="overHidden2 fl">第二份作业</p><p class="status fl">已完成</p>
    </li>
  </ul></div>`;
  const works = parseWorkList(variant);
  eq('改版样本 条数', works.length, 2);
  eq('改版样本 名称实体解码', works[0].name, '改版兼容作业 <测试>');
  eq('改版样本 状态（属性顺序互换）', works[0].status, '未交');
  eq('改版样本 剩余', works[0].left, '2小时');
  eq('改版样本 第二条 workId', works[1].workId, '9002');
}
{
  const html = read('exam_list.html');
  eq('exam_list 不是作业列表（0 条）', parseWorkList(html).length, 0);
  ok('exam_list 能被识别为"考试列表"', isExamListPage(html));
  ok('worklist2 不会被误判为考试列表', !isExamListPage(read('worklist2.html')));
  eq('空列表页返回 0 条', parseWorkList('<html><body><div class="bottomList"><ul></ul></div></body></html>').length, 0);
}

// ---------------------------------------------------------------- 抓题
section('抓题解析 parseQuestionsFromHtml');
{
  const html = read('uav_dowork5.html');
  const qs = parseQuestionsFromHtml(html);
  eq('uav 题目数', qs.length, 1);
  const q = qs[0];
  eq('uav qid', q.qid, '406462171');
  eq('uav 题型', q.type, 'attach');
  eq('uav 中文题型', q.typename, '其它');
  eq('uav 附件数量', q.attachments.length, 1);
  eq('uav 附件文件名', q.attachments[0].name, '学号_姓名_第5次作业 循环结构.docx');
  ok('uav 附件带 objectid', /^[0-9a-f]{20,}$/i.test(q.attachments[0].objectid || ''));
}
{
  const html = read('task5.html');
  const qs = parseQuestionsFromHtml(html);
  eq('task5 题目数', qs.length, 17);
  ok('task5 全部识别为单选', qs.every((q) => q.type === 'single'), qs.map((q) => q.type).join(','));
  const q1 = qs[0];
  eq('task5 第一题 qid', q1.qid, '405236745');
  eq('task5 第一题选项数', q1.opts.length, 4);
  eq('task5 第一题 A 选项', q1.opts[0].text, 'the output data is 7');
  eq('task5 第一题 D 选项', q1.opts[3].text, 'the output data is 0');
  ok('task5 选项 key 为 A-D', q1.opts.map((o) => o.key).join('') === 'ABCD');
  ok('task5 题干包含题目正文', /please input a and b/.test(q1.stem), q1.stem.slice(0, 80));
  eq('task5 第二题 A 选项', qs[1].opts[0].text, '10,0,0');
  ok('task5 题干已去掉题号前缀', !/^1\./.test(q1.stem));
}
{
  const html = read('view3.html');
  const qs = parseQuestionsFromHtml(html);
  eq('view3 题目数', qs.length, 15);
  const q1 = qs[0];
  eq('view3 第一题 qid', q1.qid, '405808879');
  ok('view3 标记为 LaTeX 题', q1.latex === true);
  ok('view3 题干解码出公式源码', /\\lim_\{x\\to \\infty\}/.test(q1.stem), q1.stem.slice(0, 80));
  eq('view3 第一题选项数', q1.opts.length, 4);
  eq('view3 选项 A 公式', q1.opts[0].text, 'e^{2}');
  eq('view3 选项 C 文本', q1.opts[2].text, '2');
  ok('view3 题干不含残留 img 标签', !/<img/i.test(q1.stem));
  ok('view3 题干不含 %22 之类未解码内容', !/%22|%5C/.test(q1.stem));
}

// ---------------------------------------------------------------- 附件
section('附件列表 getAttachments');
{
  const list = getAttachments(read('uav_dowork5.html'));
  ok('uav 解析出附件', list.length >= 1);
  const item = list.find((a) => a.name.includes('第5次作业'));
  ok('uav 附件名正确', Boolean(item), JSON.stringify(list));
  ok('uav 附件带 objectid', Boolean(item && item.objectid));
  ok('uav 附件 URL 已绝对化', Boolean(item && /^https?:\/\//.test(item.url || '')));
  eq('attachment_dialog 没有下载链接', getAttachments(read('attachment_dialog.html')).length, 0);
  eq('空 HTML 返回空数组', getAttachments('').length, 0);
  // 人工构造：普通下载链接 + UEditor 附件 iframe
  const synthetic = `<a href="https://mooc1.chaoxing.com/coursedata/downloadData?dataId=1">作业模板.docx</a>
    <iframe class="attach-iframe" filename="要求.pdf" objectid="0123456789abcdef0123456789abcdef" src="/ananas/common-modules/attachment/insertCloud.html"></iframe>`;
  const list2 = getAttachments(synthetic, { baseUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=1' });
  ok('合成样本解析出 2 个附件', list2.length === 2, JSON.stringify(list2));
  ok('下载链接已绝对化', list2.some((x) => x.url && x.url.startsWith('https://mooc1.chaoxing.com/coursedata/downloadData')));
  ok('iframe 附件名解析', list2.some((x) => x.name === '要求.pdf' && x.objectid));
}

// ---------------------------------------------------------------- kind 判定
section('kind 判定 computeKind');
{
  const single = [{ qid: '1', type: 'single' }];
  const short = [{ qid: '2', type: 'short' }];
  const attach = [{ qid: '3', type: 'attach' }];
  eq('纯客观题 -> quiz', computeKind(single, ''), 'quiz');
  eq('纯主观题 -> quiz', computeKind(short, ''), 'quiz');
  eq('纯附件题 -> attach', computeKind(attach, ''), 'attach');
  eq('客观+附件 -> mixed', computeKind([...single, ...attach], ''), 'mixed');
  eq('无题目 -> unknown', computeKind([], ''), 'unknown');
  eq('题干带附件 iframe -> attach', computeKind([{ qid: '9', type: 'short', attachments: [{ name: 'x' }] }], ''), 'mixed');
}

// ---------------------------------------------------------------- 工具函数
section('文本工具');
{
  eq('decodeEntities &amp;', decodeEntities('a&amp;b'), 'a&b');
  eq('decodeEntities 数字实体', decodeEntities('&#65;&#x42;'), 'AB');
  eq('stripTags 去标签', cleanText(stripTags('<p>a</p><p><strong>b</strong></p>')), 'a\n\nb');
  eq('stripTags 行内标签不拆行', cleanText(stripTags('<p>a<strong>b</strong></p>')), 'ab');
  eq('decodeLatexData 直接 JSON', decodeLatexData('%22e%5E%7B2%7D%22'), 'e^{2}');
  eq('decodeLatexData 非 JSON 原样', decodeLatexData('x%2By'), 'x+y');
}

// ---------------------------------------------------------------- 汇总
console.log(`\n结果：${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败项：');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
