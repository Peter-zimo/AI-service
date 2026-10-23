/**
 * 知识库模块对外出口
 *
 * 模块结构：
 *   knowledge.repo.js     数据访问（唯一写 SQL 的地方）
 *   knowledge.service.js  业务编排 + 内存快照
 *   retrieval.js          检索策略（FTS5 / 语义 / 混合 / 传统降级）
 *   embedding.js          向量计算
 *   segment.js            中文分词
 *   keywords.js           关键词抽取
 *   defaults.js           种子数据
 *
 * 外部模块只允许 require('../modules/knowledge')，不要深引内部文件。
 */

'use strict';

const repo = require('./knowledge.repo');
const embedding = require('./embedding');
const { KnowledgeService } = require('./knowledge.service');
const { createRetrieval, buildFtsMatchExpression, rrfFusion } = require('./retrieval');
const { chineseSegment } = require('./segment');
const { extractKeywords } = require('./keywords');

// ============ 初始化（建表 + 首次种子迁移） ============

repo.initTable();
repo.migrateFromJSON();

// ============ 单例 ============

const knowledgeService = new KnowledgeService();

// 单元测试用的内部接缝（保持历史契约：knowledge._test.computeEmbedding）
knowledgeService._test = {
  computeEmbedding: embedding.computeEmbedding,
  localEmbedding: embedding.localEmbedding,
  cosineSimilarity: embedding.cosineSimilarity,
  chineseSegment,
  extractKeywords,
  buildFtsMatchExpression,
  rrfFusion,
};

module.exports = knowledgeService;

// 具名导出，供需要自行实例化或单独测试的场景使用
module.exports.KnowledgeService = KnowledgeService;
module.exports.createRetrieval = createRetrieval;
module.exports.embedding = embedding;
module.exports.repo = repo;
