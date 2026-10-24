/**
 * 检索策略（Retrieval Strategies）
 *
 * 三层检索 + 融合 + 降级，全部收敛在这里：
 *   1. FTS5 全文检索（关键词层，BM25）
 *   2. 向量语义检索（语义层，余弦相似度）
 *   3. RRF 融合排序（Reciprocal Rank Fusion）
 *   4. 降级链：混合 → FTS5 → 传统关键词匹配
 *
 * 本模块不碰数据库，只通过注入的 repo 取数；
 * 也不持有状态，知识库内容通过 getKnowledgeBase() 实时读取。
 */

'use strict';

const { RETRIEVAL } = require('../../config/constants');
const { chineseSegment } = require('./segment');

const HAN_SINGLE = /^[\u4e00-\u9fa5]$/;
const HAN_PAIR = /^[\u4e00-\u9fa5]{2}$/;
const HAN_ONLY = /^[\u4e00-\u9fa5]+$/;
const PUNCT_FULL = /[？?，。！!.,!？、；：""''「」【】]/g;
const PUNCT_LIGHT = /[？?，。！!.,!]/g;

/** 口语问法里没有业务含义的泛词，参与匹配会造成答非所问 */
const GENERIC_BIGRAMS = new Set(['什么', '怎么', '如何', '可以', '你们', '我们', '一下']);

/**
 * 把用户 query 转成 FTS5 的 MATCH 表达式。
 * 单字用 AND（必须都出现），双字与非中文用 OR（加分项，不阻塞）。
 * @param {string} query
 * @returns {string} 空串表示无法构造有效表达式
 */
function buildFtsMatchExpression(query) {
  const cleanQuery = String(query || '').replace(PUNCT_FULL, ' ').trim();
  if (!cleanQuery) return '';

  const terms = chineseSegment(cleanQuery).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return '';

  const uniChars = terms.filter(t => HAN_SINGLE.test(t));
  const biWords = terms.filter(t => HAN_PAIR.test(t));
  const otherTerms = terms.filter(t => !HAN_ONLY.test(t) && t.length > 0);

  const mustParts = uniChars.map(t => `"${t.replace(/"/g, '""')}"`);
  const orParts = [
    ...biWords.map(t => `"${t.replace(/"/g, '""')}"`),
    ...otherTerms.map(t => `"${t.replace(/"/g, '""')}"`),
  ];

  if (mustParts.length === 0 && orParts.length === 0) return '';

  let match = mustParts.join(' AND ');
  if (orParts.length > 0 && mustParts.length > 0) {
    match += ` AND (${orParts.join(' OR ')})`;
  } else if (orParts.length > 0) {
    match = orParts.join(' OR ');
  }

  return match;
}

/**
 * RRF 融合：按名次而非分数融合两路结果，避免量纲不一致。
 * @param {Array} ftsResults
 * @param {Array} semanticResults
 * @param {number} k
 */
function rrfFusion(ftsResults, semanticResults, k = RETRIEVAL.RRF_K) {
  const scoreMap = new Map(); // id -> { item, score, source }

  ftsResults.forEach((item, idx) => {
    scoreMap.set(item.id, {
      item,
      score: 1 / (k + idx + 1),
      source: 'fts',
    });
  });

  semanticResults.forEach((item, idx) => {
    if (scoreMap.has(item.id)) {
      scoreMap.get(item.id).score += 1 / (k + idx + 1);
      scoreMap.get(item.id).source = 'hybrid';
    } else {
      scoreMap.set(item.id, {
        item,
        score: 1 / (k + idx + 1),
        source: 'semantic',
      });
    }
  });

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, RETRIEVAL.SEMANTIC_LIMIT);
}

/**
 * 创建检索器
 * @param {object} deps
 * @param {object} deps.repo           知识库数据访问层
 * @param {Function} deps.getKnowledgeBase 返回当前知识库数组（实时）
 * @param {object} deps.embedding      向量模块
 */
function createRetrieval({ repo, getKnowledgeBase, embedding }) {
  const { localEmbedding, cosineSimilarity, computeEmbedding } = embedding;

  /** FTS5 全文检索 */
  async function searchFTS5(query) {
    const match = buildFtsMatchExpression(query);
    if (!match) return [];

    try {
      return await repo.searchFts(match, RETRIEVAL.FTS_LIMIT);
    } catch (e) {
      console.error('[知识库] FTS5 查询失败:', e.message);
      return [];
    }
  }

  /** 向量语义检索 */
  async function searchSemantic(query) {
    const knowledgeBase = getKnowledgeBase();
    const hasEmbeddings = knowledgeBase.some(k => k.embedding);

    // 没有预计算向量时，降级为本地向量实时计算（保证演示可用）
    if (!hasEmbeddings) {
      const queryVec = localEmbedding(query);
      return knowledgeBase
        .map(k => ({
          id: k.id,
          question: k.question,
          answer: k.answer,
          keywords: k.keywords,
          embedding: null,
          score: cosineSimilarity(queryVec, localEmbedding(k.question + ' ' + (k.answer || ''))),
          _semanticScore: true,
        }))
        .filter(k => k.score > RETRIEVAL.LOCAL_SEMANTIC_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, RETRIEVAL.SEMANTIC_LIMIT);
    }

    const queryVec = await computeEmbedding(query);
    if (!queryVec) return [];

    // PG + pgvector：交给数据库做 ANN 检索；无结果时回退 JS 余弦
    if (typeof repo.searchByVector === 'function') {
      const vectorResults = await repo.searchByVector(queryVec, RETRIEVAL.SEMANTIC_LIMIT);
      if (Array.isArray(vectorResults) && vectorResults.length > 0) {
        return vectorResults
          .filter(k => k.score > RETRIEVAL.REMOTE_SEMANTIC_THRESHOLD)
          .slice(0, RETRIEVAL.SEMANTIC_LIMIT);
      }
    }

    return knowledgeBase
      .filter(k => k.embedding)
      .map(k => ({
        id: k.id,
        question: k.question,
        answer: k.answer,
        keywords: k.keywords,
        embedding: null,
        score: cosineSimilarity(queryVec, k.embedding),
        _semanticScore: true,
      }))
      // 哈希向量会在 0.5 附近碰撞，纯语义需要更高置信
      .filter(k => k.score > RETRIEVAL.REMOTE_SEMANTIC_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, RETRIEVAL.SEMANTIC_LIMIT);
  }

  /** 混合检索：FTS5 + 语义 → RRF 融合 */
  async function searchHybrid(query) {
    const ftsResults = await searchFTS5(query);
    const semanticResults = await searchSemantic(query);
    const fused = rrfFusion(ftsResults, semanticResults);

    // 融合为空但 FTS 有结果 → 降级用 FTS
    if (fused.length === 0 && ftsResults.length > 0) {
      return ftsResults.slice(0, RETRIEVAL.HYBRID_LIMIT).map(r => ({
        ...r,
        source: 'fts',
        _bestOriginalScore: r.score,
      }));
    }

    // 正常返回：RRF 分用于排序，原始最佳分用于阈值判断
    return fused.map(r => {
      const ftsMatch = ftsResults.find(f => f.id === r.item.id);
      const semMatch = semanticResults.find(s => s.id === r.item.id);
      const bestOrig = Math.max(ftsMatch?.score || 0, semMatch?.score || 0);

      return {
        id: r.item.id,
        question: r.item.question,
        answer: r.item.answer,
        keywords: r.item.keywords,
        score: Math.round(r.score * 100) / 100,
        _bestOriginalScore: Math.round(bestOrig * 100) / 100,
        source: r.source,
      };
    }).slice(0, RETRIEVAL.HYBRID_LIMIT);
  }

  /** 传统关键词检索（最终兜底，不依赖 FTS5 与向量） */
  function searchLegacy(query) {
    const results = [];
    const cleanQuery = String(query || '').replace(PUNCT_LIGHT, '').trim();
    if (!cleanQuery) return [];

    for (const item of getKnowledgeBase()) {
      let score = 0;
      const cleanQuestion = item.question.replace(PUNCT_LIGHT, '').trim();

      // 1. 精确包含
      if (cleanQuestion.includes(cleanQuery) || cleanQuery.includes(cleanQuestion)) {
        score += RETRIEVAL.SCORE_EXACT_CONTAINS;
      }

      // 2. 业务双字片段重叠（排除"什么/怎么"等泛词）
      const hasBusinessOverlap = Array.from(
        { length: Math.max(0, cleanQuery.length - 1) },
        (_, i) => cleanQuery.slice(i, i + 2)
      ).some(part => !GENERIC_BIGRAMS.has(part) && cleanQuestion.includes(part));
      if (hasBusinessOverlap) score += RETRIEVAL.SCORE_BUSINESS_OVERLAP;

      // 3. 关键词命中
      const matchedKeywords = [];
      for (const keyword of item.keywords || []) {
        if (cleanQuery.includes(keyword) || keyword.includes(cleanQuery)) {
          score += RETRIEVAL.SCORE_KEYWORD_HIT;
          matchedKeywords.push(keyword);
        }
      }

      // 4. 多关键词组合加分
      if (matchedKeywords.length >= 2) {
        score += matchedKeywords.length * RETRIEVAL.SCORE_KEYWORD_COMBO_BONUS;
      }

      if (score > 0) {
        results.push({ ...item, score, matchedKeywords });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, RETRIEVAL.HYBRID_LIMIT);
  }

  /** 主检索入口：混合优先，失败逐级降级 */
  async function search(query) {
    try {
      const hybridResults = await searchHybrid(query);
      if (hybridResults.length > 0) return hybridResults;
    } catch (e) {
      console.error('[知识库] 混合检索失败，降级到 FTS5:', e.message);
      const ftsResults = await searchFTS5(query);
      if (ftsResults.length > 0) return ftsResults;
    }
    return searchLegacy(query);
  }

  /**
   * 最佳匹配（AI 回复策略用）。阈值分档：
   *   - 精确命中：30
   *   - legacy 强命中：>= 20
   *   - FTS/混合：原始分 >= 0.04
   * 达不到就返回 null，让上层走兜底话术，避免答非所问。
   */
  async function getBestMatch(query) {
    const knowledgeBase = getKnowledgeBase();
    const normalizedQuery = String(query || '').replace(PUNCT_LIGHT, '').trim();

    const exact = knowledgeBase.find(
      item => item.question.replace(PUNCT_LIGHT, '').trim() === normalizedQuery
    );
    if (exact) return { ...exact, score: RETRIEVAL.SCORE_EXACT_CONTAINS, source: 'exact' };

    const strongLegacy = searchLegacy(query)[0];
    if (strongLegacy && strongLegacy.score >= RETRIEVAL.LEGACY_STRONG_SCORE) {
      return strongLegacy;
    }

    const results = await search(query);
    if (results.length === 0) return null;

    const first = results[0];
    const isLegacy = first.matchedKeywords !== undefined;

    if (isLegacy) {
      return first.score >= RETRIEVAL.LEGACY_STRONG_SCORE ? first : null;
    }

    const origScore = first._bestOriginalScore || first.score;
    if (origScore >= RETRIEVAL.ORIGINAL_SCORE_THRESHOLD) return first;

    // 混合检索有弱候选时，不能阻断更可靠的关键词兜底
    const legacy = searchLegacy(query)[0];
    if (legacy && legacy.score >= RETRIEVAL.LEGACY_STRONG_SCORE) return legacy;

    return null;
  }

  return {
    buildFtsMatchExpression,
    searchFTS5,
    searchSemantic,
    searchHybrid,
    searchLegacy,
    search,
    getBestMatch,
    rrfFusion,
  };
}

module.exports = { createRetrieval, buildFtsMatchExpression, rrfFusion, GENERIC_BIGRAMS };
