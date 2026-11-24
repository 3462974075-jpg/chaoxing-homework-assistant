# v1.4.0 · 学习通作业助手

## 重点修复

- 修复 **AI 引擎自检失败 / AI 引擎不可用**：
  - 全新电脑或旧版数据中，DSH 运行目录可能只有隐私补丁而缺少基础 profile（`cordis.yml`），DSH 启动即失败；
  - 隐私补丁与 DSH 默认空 patch（`[]`）合并会产生非法 YAML；
  - API Key 只保存在 DPAPI、未同步进 DSH_HOME。
- v1.4 启动时自动初始化/修复 DSH 运行目录，自动同步已保存的 API Key；自检失败显示具体原因。

## 安装

1. 下载 `chaoxing-homework-assistant_v1.4.0_windows.zip`，解压到普通文件夹。
2. 首次双击 `01_环境准备（首次）.cmd`。
3. 双击 `02_启动.cmd`，填写 DeepSeek API Key 与学习通账号。
4. 用完双击 `03_停止服务.cmd`。

## 文件校验（SHA-256）

```
chaoxing-homework-assistant_v1.4.0_windows.zip  263bc702e2faeae14849fb403e6b479eecec762828e3cb776d01864f5d59397c
chaoxing-homework-assistant_v1.4.0_source.zip   af9827c6089a86dfcea60cef6d2856ec79a86a585b55609df12de74052de7223
```

## 作者

- 七号玩家（sevenplayer / Lsy）
- Powered by DeepSeek（AI 辅助开发）
- License: MIT
