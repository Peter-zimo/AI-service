/**
 * ai 模块对外出口
 *
 * 结构：
 *   ai-config.js   配置加载与热更新（可变对象 + 30 秒 mtime 检查）
 *   providers.js   模型供应商调用（非流式 / 流式 / 连通性测试）
 *   responses.js   兜底话术
 *   ai.service.js  对话编排（知识库优先 → 模型 → 兜底）
 *
 * 对外导出单例，与重构前 services/ai.js 的接口完全一致。
 */

'use strict';

const { AIService } = require('./ai.service');
const config = require('./ai-config');

const aiService = new AIService();

// 配置热更新（每 30 秒检查 ai-config.json 是否变化）
config.startAutoReload();

module.exports = aiService;
