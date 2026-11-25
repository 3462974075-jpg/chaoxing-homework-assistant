/**
 * 学习通作业助手 (Chaoxing Homework Assistant) v1.7.2
 * Copyright (c) 2026 七号玩家 (sevenplayer / Lsy). All rights reserved.
 * SPDX-License-Identifier: MIT
 * Powered by DeepSeek（AI 辅助开发）
 */
﻿import { mergeSecrets, getSecrets, secretSummary, clearSecrets } from './secret.mjs';
const obj = { deepseek: { apiKey: 'sk-test-1234567890' }, chaoxing: { username: '13800000000', password: 'p@ss 中文' } };
await mergeSecrets(obj);
const back = await getSecrets();
console.log('roundtrip:', JSON.stringify(back) === JSON.stringify(obj));
console.log('summary:', JSON.stringify(await secretSummary()));
await clearSecrets();
console.log('summary2:', JSON.stringify(await secretSummary()));
