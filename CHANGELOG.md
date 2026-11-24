# 更新记录 / Changelog

## v1.4.0（2026-11-24）· 最终版

- **修复 AI 引擎自检失败 / “AI 引擎不可用”**：
  - 新增 DSH_HOME 初始化逻辑：先让 DSH 生成基础 profile（`cordis.yml`），再写隐私补丁，避免 patch-only 目录导致 DSH 启动失败；
  - 修复隐私补丁与 DSH 默认空 patch（`[]`）合并产生非法 YAML 的问题；
  - 每次创建引擎/运行前自动把 DPAPI 中保存的 API Key 同步到 DSH_HOME；
  - 自检失败按缺 Key / 运行目录损坏 / 网络 / 模型配置显示具体原因。
- 版权与作者署名：七号玩家（sevenplayer / Lsy），Powered by DeepSeek（AI 辅助开发），MIT License。

## v1.3.0（2026-11-24）

- 完成版权、作者、LICENSE、开源 README 与源码包。
- 标记 Powered by DeepSeek（AI 辅助开发）。

## v1.2.0（2026-11-23）

- 修复同学电脑已装/未装 Node、DSH 时启动找不到 DSH：Node 先入 PATH、扩展 DSH 搜索、缺失时自动补装。
- 图片资料自动识题（DeepSeek 视觉模型 + OCR 缓存）。
- 附件作业直接上传修复；批量选择题分批/拆单题/内容审核兜底。

## v1.1.0（2026-11-23）

- 图片资料 OCR、附件题直接上传、文档生成循环/超时重试。

## v1.0.0（2026-11-22）

- 首个绿色免安装版：学习通登录、作业列表、客观题/主观题/附件题、自动提交、隐私隔离、简易 UI。
