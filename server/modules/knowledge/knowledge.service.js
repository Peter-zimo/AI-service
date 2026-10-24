/**
 * 知识库业务服务
 *
 * 职责：维护内存中的知识库快照，编排 CRUD 与向量计算，对外提供检索能力。
 * 不写 SQL（走 repo），不碰 HTTP（无 req/res）。
 *
 * 数据流：repo（持久层） ←→ 本服务（内存快照 + 业务规则） → retrieval（检索策略）
 */

'use strict';

const { RETRIEVAL } = require('../../config/constants');
const { getConfigValue } = require('../../config/ai-keys');
const { env } = require('../../config');
const langchain = require('../../infra/clients/langchain');
const repo = require('./knowledge.repo');
const embedding = require('./embedding');
const { extractKeywords } = require('./keywords');
const { createRetrieval } = require('./retrieval');

const BATCH_DELAY_MS = RETRIEVAL.EMBEDDING_BATCH_DELAY_MS;
const MAX_AUTO_KEYWORDS = 10;

/** 远程调用加超时：Python 抖动时快速回退本地，不拖住请求 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时(${ms}ms)`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class KnowledgeService {
  constructor() {
    /** @type {Array<{id:string,question:string,answer:string,keywords:string[],embedding:number[]|null}>} */
    this.knowledgeBase = [];
    this._embeddingsReady = false;

    this._retrieval = createRetrieval({
      repo,
      getKnowledgeBase: () => this.knowledgeBase,
      embedding,
    });

    // 异步初始化（SQLite 同步快、PG 异步）：检索/CRUD 前 await this._ready
    this._ready = this._init();
  }

  async _init() {
    await this.loadKnowledge();
    repo.rebuildFts();
    console.log(`[知识库] 加载完成，共 ${this.knowledgeBase.length} 条`);
    // 缺失向量的补算不阻塞启动
    this._batchComputeEmbeddings();
  }

  // ============ 数据装载 ============

  async loadKnowledge() {
    const rows = await repo.allRows();
    this.knowledgeBase = rows.map(r => ({
      id: r.id,
      question: r.question,
      answer: r.answer,
      keywords: JSON.parse(r.keywords || '[]'),
      embedding: r.embedding ? JSON.parse(r.embedding) : null,
    }));
    return this.knowledgeBase;
  }

  async saveAll() {
    await repo.replaceAll(this.knowledgeBase);
  }

  // ============ 工具 ============

  extractKeywords(text) {
    return extractKeywords(text);
  }

  // ============ 检索（委托 retrieval，统一在这里等 _ready） ============

  async searchFTS5(query) {
    await this._ready;
    return this._retrieval.searchFTS5(query);
  }

  async searchSemantic(query) {
    await this._ready;
    return this._retrieval.searchSemantic(query);
  }

  async searchHybrid(query) {
    await this._ready;
    return this._retrieval.searchHybrid(query);
  }

  searchLegacy(query) {
    return this._retrieval.searchLegacy(query);
  }

  async search(query) {
    await this._ready;
    return this._retrieval.search(query);
  }

  async getBestMatch(query) {
    await this._ready;
    return this._retrieval.getBestMatch(query);
  }

  // ============ 远程检索（Python 为唯一权威） ============

  /**
   * 远程检索。ok=false 表示 Python 不可用，调用方应回退本地。
   * @returns {Promise<{ok:boolean, results?:Array}>}
   */
  async searchRemote(query) {
    if (!env.knowledge.remoteFirst) return { ok: false };

    try {
      const res = await withTimeout(
        langchain.searchKnowledge(query),
        env.knowledge.remoteTimeoutMs,
        '远程检索'
      );
      if (!res || res.success !== true) return { ok: false };
      return { ok: true, results: Array.isArray(res.data) ? res.data : [] };
    } catch (_) {
      return { ok: false };
    }
  }

  /**
   * 远程最佳匹配。ok=true 且 match=null 表示「确实没有匹配」，调用方不应再用本地兜底。
   * @returns {Promise<{ok:boolean, match?:object|null}>}
   */
  async getBestMatchRemote(query) {
    if (!env.knowledge.remoteFirst) return { ok: false };

    try {
      const res = await withTimeout(
        langchain.getBestMatch(query),
        env.knowledge.remoteTimeoutMs,
        '远程最佳匹配'
      );
      if (!res || res.success !== true) return { ok: false };
      return { ok: true, match: res.data || null };
    } catch (_) {
      return { ok: false };
    }
  }

  // ============ 读 ============

  async getAll() {
    await this._ready;
    return this.knowledgeBase.map(item => ({
      id: item.id,
      question: item.question,
      answer: item.answer,
      keywords: item.keywords,
      embedding: undefined, // 不对外暴露向量
    }));
  }

  async getById(id) {
    await this._ready;
    const item = this.knowledgeBase.find(k => k.id === id);
    if (!item) return null;
    return {
      id: item.id,
      question: item.question,
      answer: item.answer,
      keywords: item.keywords,
      embedding: undefined,
    };
  }

  // ============ 写 ============

  async addItem(question, answer, keywords = []) {
    await this._ready;

    const item = {
      id: 'k' + Date.now(),
      question,
      answer,
      keywords: keywords.length > 0 ? keywords : extractKeywords(question),
      embedding: null,
    };

    this.knowledgeBase.push(item);
    await this.saveAll();
    this._computeSingleEmbedding(item);

    return { id: item.id, question: item.question, answer: item.answer, keywords: item.keywords };
  }

  async updateItem(id, question, answer, keywords = []) {
    await this._ready;

    const index = this.knowledgeBase.findIndex(k => k.id === id);
    if (index === -1) return null;

    const item = this.knowledgeBase[index];
    item.question = question;
    item.answer = answer;
    item.keywords = keywords.length > 0 ? keywords : extractKeywords(question);
    item.embedding = null; // 标记待重算

    await this.saveAll();
    this._computeSingleEmbedding(item);

    return { id: item.id, question: item.question, answer: item.answer, keywords: item.keywords };
  }

  async deleteItem(id) {
    await this._ready;

    const index = this.knowledgeBase.findIndex(k => k.id === id);
    if (index === -1) return null;

    const deleted = this.knowledgeBase.splice(index, 1)[0];
    await this.saveAll();

    return { id: deleted.id, question: deleted.question, answer: deleted.answer, keywords: deleted.keywords };
  }

  async clearAll() {
    await this._ready;
    this.knowledgeBase = [];
    await this.saveAll();
    return { success: true };
  }

  async batchAdd(items, { waitForEmbeddings = false } = {}) {
    await this._ready;

    const existingQuestions = new Set(this.knowledgeBase.map(k => k.question.trim()));
    const newItems = [];
    let added = 0;
    let skipped = 0;

    for (const item of items) {
      const question = (item.question || '').trim();
      const answer = (item.answer || '').trim();

      if (!question || !answer || existingQuestions.has(question)) {
        skipped++;
        continue;
      }

      const newItem = {
        id: 'k' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        question,
        answer,
        keywords: Array.isArray(item.keywords) && item.keywords.length > 0
          ? item.keywords.slice(0, MAX_AUTO_KEYWORDS)
          : extractKeywords(question),
        embedding: null,
      };

      this.knowledgeBase.push(newItem);
      existingQuestions.add(question);
      newItems.push(newItem);
      added++;
    }

    if (added > 0) {
      await this.saveAll();
      if (waitForEmbeddings) {
        await this._batchComputeEmbeddingsFor(newItems);
      } else {
        this._batchComputeEmbeddingsFor(newItems);
      }
    }

    return { added, skipped };
  }

  async resetToDefault() {
    await this._ready;
    repo.resetToDefault();
    await this.loadKnowledge();
    this._batchComputeEmbeddings();
    return { success: true, count: this.knowledgeBase.length };
  }

  // ============ 向量维护 ============

  async _computeSingleEmbedding(item) {
    const vec = await embedding.computeEmbedding(item.question);
    if (!vec) return;

    item.embedding = vec;
    await repo.updateEmbedding(item.id, vec);
  }

  async _batchComputeEmbeddingsFor(items) {
    for (const item of items) {
      const vec = await embedding.computeEmbedding(item.question);
      if (vec) {
        item.embedding = vec;
        await repo.updateEmbedding(item.id, vec);
      }
      // 节流，避免瞬时打满
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  async _batchComputeEmbeddings() {
    const pending = this.knowledgeBase.filter(k => !k.embedding);

    if (pending.length === 0) {
      this._embeddingsReady = true;
      return;
    }

    console.log(`[知识库] 开始异步计算 ${pending.length} 条 embedding...`);
    await this._batchComputeEmbeddingsFor(pending);
    this._embeddingsReady = true;
    console.log('[知识库] Embedding 计算完成');
  }

  /** 是否配置了可用的 embedding 服务密钥 */
  hasEmbeddingAPI() {
    return !!(getConfigValue('deepseek', 'apiKey') || getConfigValue('zhipu', 'apiKey'));
  }

  /**
   * 重算指定条目（或全量）的向量，供异步任务调用。
   * @param {string[]|null} ids
   * @returns {Promise<{total:number, updated:number}>}
   */
  async recomputeEmbeddings(ids = null) {
    await this._ready;

    const targets = Array.isArray(ids) && ids.length > 0
      ? this.knowledgeBase.filter(item => ids.includes(item.id))
      : this.knowledgeBase;

    for (const item of targets) item.embedding = null;
    await this._batchComputeEmbeddingsFor(targets);

    return {
      total: targets.length,
      updated: targets.filter(item => item.embedding).length,
    };
  }
}

module.exports = { KnowledgeService };
