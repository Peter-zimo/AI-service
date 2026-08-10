/**
 * 知识库服务（SQLite 版本）
 * 
 * 检索策略：混合检索（Hybrid Retrieval）
 * 1. FTS5 全文搜索（BM25 算法，关键词层）
 * 2. 向量语义检索（DeepSeek/智谱 Embedding API，语义层）
 * 3. RRF 融合排序（Reciprocal Rank Fusion）
 * 
 * 降级策略：
 * - Embedding API 不可用 → 仅 FTS5 检索
 * - FTS5 不可用 → 降级为传统 JS 循环匹配
 */

const db = require('./sqlite');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// ============ 配置读取 ============

function readAIConfig() {
  try {
    const configPath = path.join(__dirname, '../data/ai-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (e) {
    console.error('[知识库] 读取 AI 配置失败:', e.message);
  }
  return null;
}

function getConfigValue(provider, key) {
  // 优先级: 环境变量 > ai-config.json（新结构 llm/fallback，兼容旧 deepseek/zhipu）
  const envMap = {
    deepseek: { apiKey: ['LLM_API_KEY', 'DEEPSEEK_API_KEY'], baseUrl: ['LLM_BASE_URL', 'DEEPSEEK_BASE_URL'], model: ['LLM_MODEL', 'DEEPSEEK_MODEL'] },
    zhipu: { apiKey: ['FALLBACK_API_KEY', 'ZHIPU_API_KEY'], baseUrl: ['FALLBACK_BASE_URL', 'ZHIPU_BASE_URL'], model: ['FALLBACK_MODEL', 'ZHIPU_MODEL'] }
  };
  const envKeys = envMap[provider]?.[key];
  if (envKeys) {
    for (const k of envKeys) {
      if (process.env[k]) return process.env[k];
    }
  }
  const config = readAIConfig();
  if (!config) return '';
  // 新结构：llm = 主模型（deepseek 语义），fallback = 备用模型（zhipu 语义）
  const node = provider === 'zhipu' ? config.fallback : config.llm;
  if (node) {
    const val = node[key] || node[key === 'apiKey' ? 'apiKey' : key] || '';
    if (val && val !== 'your_deepseek_api_key_here' && val !== 'your_zhipu_api_key_here') return val;
  }
  // 兼容旧结构
  const legacyVal = config?.[provider]?.[key] || '';
  if (legacyVal && legacyVal !== 'your_deepseek_api_key_here' && legacyVal !== 'your_zhipu_api_key_here') return legacyVal;
  return '';
}

// ============ Embedding API 调用 ============
// 用 DeepSeek embedding API，失败时降级到智谱 embedding

const EMBEDDING_DIM = 1024;  // text-embedding-v2 输出维度

async function computeEmbedding(text) {
  if (!text || !text.trim()) return null;
  const input = text.trim().slice(0, 512); // 截断过长文本

  // 1. 尝试 DeepSeek
  const dsKey = getConfigValue('deepseek', 'apiKey');
  if (dsKey) {
    try {
      const res = await axios.post('https://api.deepseek.com/v1/embeddings', {
        input,
        model: 'text-embedding-v2'
      }, {
        headers: { 'Authorization': `Bearer ${dsKey}`, 'Content-Type': 'application/json' },
        timeout: 10000
      });
      if (res.data?.data?.[0]?.embedding) return res.data.data[0].embedding;
    } catch (e) {
      console.error('[知识库 Embedding] DeepSeek 失败:', e.message);
    }
  }

  // 2. 降级到智谱
  const zpKey = getConfigValue('zhipu', 'apiKey');
  if (zpKey) {
    try {
      const res = await axios.post('https://open.bigmodel.cn/api/paas/v4/embeddings', {
        input,
        model: 'embedding-2'
      }, {
        headers: { 'Authorization': `Bearer ${zpKey}`, 'Content-Type': 'application/json' },
        timeout: 10000
      });
      if (res.data?.data?.[0]?.embedding) return res.data.data[0].embedding;
    } catch (e) {
      console.error('[知识库 Embedding] 智谱失败:', e.message);
    }
  }

  // 3. 本地 fallback（零依赖，保证 RAG 演示始终可用）
  // 用字符 unigram+bigram 哈希到 128 维向量，配合余弦相似度做语义近似
  return localEmbedding(input);
}

// ============ 本地 Embedding（零依赖 fallback） ============

const LOCAL_DIM = 128;

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function localEmbedding(text) {
  const vec = new Array(LOCAL_DIM).fill(0);
  const chars = String(text || '').replace(/\s+/g, '').slice(0, 300);
  for (let i = 0; i < chars.length; i++) {
    vec[hashCode(chars[i]) % LOCAL_DIM] += 1;
    if (i + 1 < chars.length) {
      vec[hashCode(chars[i] + chars[i + 1]) % LOCAL_DIM] += 2;
    }
  }
  return vec;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : dot / norm;
}

// ============ RRF 融合 ============

function rrfFusion(ftsResults, semanticResults, k = 60) {
  const scoreMap = new Map(); // id -> { item, score }

  ftsResults.forEach((item, idx) => {
    scoreMap.set(item.id, {
      item,
      score: 1 / (k + idx + 1),
      source: 'fts'
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
        source: 'semantic'
      });
    }
  });

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ============ 默认知识库 ============

const defaultKnowledge = [
  {
    id: 'k1',
    question: '营业时间',
    answer: '我们的营业时间是每天 9:00-22:00，欢迎光临！',
    keywords: ['营业时间', '几点开门', '几点关门', '开门时间', '关门时间']
  },
  {
    id: 'k2',
    question: '如何联系客服',
    answer: '您可以通过以下方式联系我们：电话 400-123-4567，微信客服 abc123456，邮箱 support@example.com',
    keywords: ['联系', '客服', '电话', '微信', '邮箱', '怎么联系']
  },
  {
    id: 'k3',
    question: '退款政策',
    answer: '我们支持7天内无理由退款，15天内质量问题可换货。退款将在1-3个工作日内原路返回。',
    keywords: ['退款', '退钱', '退货', '换货', '售后', '取消订单']
  },
  {
    id: 'k4',
    question: '会员积分',
    answer: '每消费1元积1分，100积分可抵扣1元。会员生日当月消费双倍积分。',
    keywords: ['积分', '会员', '兑换', '抵扣', '怎么用积分']
  },
  {
    id: 'k5',
    question: '优惠活动',
    answer: '当前活动：新用户首单立减10元，满99元包邮，每周三会员日8折优惠。',
    keywords: ['优惠', '折扣', '活动', '促销', '满减', '打折']
  },
  {
    id: 'k6',
    question: '单车坏了怎么办',
    answer: '如果单车出现故障，请拍摄故障照片并通过App报障，系统会立即冻结该车并安排维修团队处理。',
    keywords: ['单车', '故障', '坏了', '报障', '维修', '车坏了']
  }
];

// ============ 表结构初始化 ============

function initKnowledgeTable() {
  // 1. 基础表
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      keywords TEXT NOT NULL,
      embedding TEXT DEFAULT NULL,
      created_at TEXT,
      updated_at TEXT
    )
  `);

  // 2. 给旧表加 embedding 列（幂等；PG 模式表结构由 ensureSchema 定义，跳过）
  if (process.env.DB_TYPE !== 'postgres') {
    try {
      db.exec("ALTER TABLE knowledge ADD COLUMN embedding TEXT DEFAULT NULL");
      console.log('[知识库] 新增 embedding 列');
    } catch (_) {
      // 列已存在，忽略
    }
  }

  // 3. FTS5 全文搜索虚拟表（独立表，避免 content sync 的 rowid 映射问题）
  //    仅 SQLite 支持 FTS5；PG 模式跳过（检索自动降级为语义/传统匹配）
  // 先删除旧表（兼容之前错误的创建），再重建
  if (process.env.DB_TYPE !== 'postgres') {
    try { db.exec("DROP TABLE IF EXISTS knowledge_fts"); } catch (_) {}
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        question, answer, keywords
      )
    `);
  }

  console.log('[知识库] 数据库表初始化完成');
}

// ============ 中文分词（FTS5 兼容层） ============
// FTS5 的 unicode61 tokenizer 把整句中文字符串当做一个 token，
// MATCH '营业' 匹配不上 token "营业时间"。
// 这里用应用层分词：单字+双字组合，解决中文全文搜索问题

function chineseSegment(text) {
  if (!text) return '';
  const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ').trim();
  if (!clean) return '';
  const tokens = new Set();
  for (const ch of clean) {
    if (/[\u4e00-\u9fa5]/.test(ch)) tokens.add(ch);    // 单字
  }
  for (let i = 0; i < clean.length - 1; i++) {
    const pair = clean.substring(i, i + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(pair)) tokens.add(pair); // 双字
  }
  for (const word of clean.split(/\s+/)) {
    if (/^[a-zA-Z0-9]+$/.test(word) && word.length > 0) tokens.add(word.toLowerCase()); // 英文/数字
  }
  return Array.from(tokens).join(' ');
}

// 重建 FTS5 索引（独立表：清空后，逐行分词后插入）
function rebuildFTS5() {
  // PG 无 FTS5，跳过（检索走语义/传统降级）
  if (process.env.DB_TYPE === 'postgres') return;
  try {
    db.exec("DELETE FROM knowledge_fts");
    const insert = db.prepare(`
      INSERT INTO knowledge_fts(rowid, question, answer, keywords)
      VALUES (?, ?, ?, ?)
    `);
    const all = db.prepare("SELECT rowid, question, answer, keywords FROM knowledge").all();
    const txn = db.transaction(() => {
      for (const row of all) {
        // 把 keywords 文本也分词（去掉 JSON 的引号和大括号干扰）
        const kwText = (JSON.parse(row.keywords || '[]') || []).join(' ');
        insert.run(
          row.rowid,
          chineseSegment(row.question),
          chineseSegment(row.answer),
          chineseSegment(kwText)
        );
      }
    });
    txn();
  } catch (e) {
    console.error('[知识库] FTS5 重建失败:', e.message);
  }
}

// ============ 数据迁移 ============

function migrateFromJSON() {
  const dataPath = path.join(__dirname, '../data/knowledge.json');
  if (!fs.existsSync(dataPath)) {
    console.log('[知识库] 无旧JSON数据，初始化默认数据');
    resetToDefault();
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const items = Array.isArray(data) ? data : (data.knowledge || []);

    if (items.length === 0) {
      console.log('[知识库] JSON为空，初始化默认数据');
      resetToDefault();
      return;
    }

    const count = db.prepare('SELECT COUNT(*) as count FROM knowledge').get().count;
    if (count === 0) {
      const insert = db.prepare(`
        INSERT INTO knowledge (id, question, answer, keywords, embedding, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const item of items) {
        insert.run(item.id, item.question, item.answer,
          JSON.stringify(item.keywords || []), null, now, now);
      }
      rebuildFTS5();
      console.log(`[知识库] 从JSON迁移 ${items.length} 条数据`);
    }
  } catch (e) {
    console.error('[知识库] 迁移失败:', e.message);
    resetToDefault();
  }
}

function resetToDefault() {
  const now = new Date().toISOString();
  // 双引擎兼容：SQLite 用 INSERT OR REPLACE，PG 用 ON CONFLICT
  const isPg = process.env.DB_TYPE === 'postgres';
  const insert = db.prepare(isPg
    ? `INSERT INTO knowledge (id, question, answer, keywords, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         question = EXCLUDED.question,
         answer = EXCLUDED.answer,
         keywords = EXCLUDED.keywords,
         embedding = EXCLUDED.embedding,
         updated_at = EXCLUDED.updated_at`
    : `INSERT OR REPLACE INTO knowledge (id, question, answer, keywords, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of defaultKnowledge) {
    insert.run(item.id, item.question, item.answer,
      JSON.stringify(item.keywords), null, now, now);
  }
  rebuildFTS5();
  console.log('[知识库] 重置为默认数据');
}

// ============ 知识库服务类 ============

class KnowledgeService {
  constructor() {
    this.knowledgeBase = [];
    this._embeddingsReady = false; // embedding 批量计算状态
    // 异步初始化（SQLite 同步快、PG 异步）：检索/CRUD 前 await this._ready
    this._ready = this._init();
  }

  async _init() {
    await this.loadKnowledge();
    rebuildFTS5();
    console.log(`[知识库] 加载完成，共 ${this.knowledgeBase.length} 条`);
    // 异步计算缺失的 embeddings（不阻塞启动）
    this._batchComputeEmbeddings();
  }

  async loadKnowledge() {
    const rows = await db.prepare('SELECT * FROM knowledge ORDER BY id').all();
    this.knowledgeBase = rows.map(r => ({
      id: r.id,
      question: r.question,
      answer: r.answer,
      keywords: JSON.parse(r.keywords || '[]'),
      embedding: r.embedding ? JSON.parse(r.embedding) : null
    }));
  }

  async saveAll() {
    await db.exec('DELETE FROM knowledge');
    const insert = db.prepare(`
      INSERT INTO knowledge (id, question, answer, keywords, embedding, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const item of this.knowledgeBase) {
      await insert.run(item.id, item.question, item.answer,
        JSON.stringify(item.keywords || []),
        item.embedding ? JSON.stringify(item.embedding) : null,
        now, now);
    }
    rebuildFTS5();
  }

  // ============ 工具方法 ============

  extractKeywords(text) {
    if (!text) return [];
    const words = [];
    let current = '';
    for (const char of text) {
      if (/[\u4e00-\u9fa5]/.test(char)) {
        current += char;
        if (current.length >= 2) words.push(current);
      } else {
        if (current.length >= 2) words.push(current);
        current = '';
      }
    }
    if (current.length >= 2) words.push(current);
    return [...new Set(words)].slice(0, 5);
  }

  // ============ FTS5 检索 ============

  async searchFTS5(query) {
    const cleanQuery = query.replace(/[？?，。！!.,!？、；：""''「」【】]/g, ' ').trim();
    if (!cleanQuery) return [];

    try {
      // 查询做中文分词，保证与索引的 token 一致
      const segmented = chineseSegment(cleanQuery);
      const terms = segmented.split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];

      // 分类处理 token
      const uniChars = terms.filter(t => /^[\u4e00-\u9fa5]$/.test(t));
      const biWords = terms.filter(t => /^[\u4e00-\u9fa5]{2}$/.test(t));
      const otherTerms = terms.filter(t => !/^[\u4e00-\u9fa5]+$/.test(t) && t.length > 0);
      if (uniChars.length === 0 && biWords.length === 0 && otherTerms.length === 0) return [];

      // 单字用 AND（必须都出现）
      const mustParts = uniChars.map(t => `"${t.replace(/"/g, '""')}"`);
      // 双字用 OR（加分项，不阻塞）
      const shouldParts = biWords.map(t => `"${t.replace(/"/g, '""')}"`);
      // 其他非中文字符也用 OR
      const otherParts = otherTerms.map(t => `"${t.replace(/"/g, '""')}"`);

      let matchParts = mustParts.join(' AND ');
      const orParts = [...shouldParts, ...otherParts];
      if (orParts.length > 0 && mustParts.length > 0) {
        matchParts += ` AND (${orParts.join(' OR ')})`;
      } else if (orParts.length > 0) {
        matchParts = orParts.join(' OR ');
      }

      const rows = await db.prepare(`
        SELECT k.id, k.question, k.answer, k.keywords, knowledge_fts.rank
        FROM knowledge_fts
        JOIN knowledge k ON k.rowid = knowledge_fts.rowid
        WHERE knowledge_fts MATCH ?
        ORDER BY knowledge_fts.rank
        LIMIT 10
      `).all(matchParts);

      return rows.map(r => ({
        id: r.id,
        question: r.question,
        answer: r.answer,
        keywords: JSON.parse(r.keywords || '[]'),
        embedding: null,
        score: Math.round((1 / (1 + Math.abs(r.rank))) * 100) / 100 || 0.1,
        _ftsScore: true
      }));
    } catch (e) {
      console.error('[知识库] FTS5 查询失败:', e.message);
      return [];
    }
  }

  // ============ 向量语义检索 ============

  async searchSemantic(query) {
    await this._ready;
    // 如果没有 embedding 数据，降级为本地向量实时检索（保证演示可用）
    const hasEmbeddings = this.knowledgeBase.some(k => k.embedding);
    if (!hasEmbeddings) {
      const queryVec = localEmbedding(query);
      const scored = this.knowledgeBase
        .map(k => ({
          id: k.id,
          question: k.question,
          answer: k.answer,
          keywords: k.keywords,
          embedding: null,
          score: cosineSimilarity(queryVec, localEmbedding(k.question + ' ' + (k.answer || ''))),
          _semanticScore: true
        }))
        .filter(k => k.score > 0.25)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      return scored;
    }

    const queryVec = await computeEmbedding(query);
    if (!queryVec) return [];

    // 余弦相似度计算
    const scored = this.knowledgeBase
      .filter(k => k.embedding)
      .map(k => ({
        id: k.id,
        question: k.question,
        answer: k.answer,
        keywords: k.keywords,
        embedding: null,
        score: cosineSimilarity(queryVec, k.embedding),
        _semanticScore: true
      }))
      .filter(k => k.score > 0.45) // 语义阈值 0.45：过滤无关误命中（实测正确命中 0.9+，无关 0.3-0.4）
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return scored;
  }

  // ============ 混合检索（Hybrid） ============

  async searchHybrid(query) {
    await this._ready;
    // 1. FTS5 检索
    const ftsResults = await this.searchFTS5(query);

    // 2. 语义检索
    const semanticResults = await this.searchSemantic(query);

    // 3. RRF 融合
    const fused = rrfFusion(ftsResults, semanticResults);

    // 4. 如果融合结果为空，降级到 FTS5
    if (fused.length === 0 && ftsResults.length > 0) {
      return ftsResults.slice(0, 3).map(r => ({
        ...r,
        source: 'fts',
        _bestOriginalScore: r.score  // 保留原始 FTS5 分数用于阈值判断
      }));
    }

    // 5. 正常返回：保留 RRF 分用于排序，同时带原始最佳分用于阈值判断
    return fused.map(r => {
      // 找到原始匹配项，取最高原始分
      const ftsMatch = ftsResults.find(f => f.id === r.item.id);
      const semMatch = semanticResults.find(s => s.id === r.item.id);
      const bestOrig = Math.max(
        ftsMatch?.score || 0,
        semMatch?.score || 0
      );
      return {
        id: r.item.id,
        question: r.item.question,
        answer: r.item.answer,
        keywords: r.item.keywords,
        score: Math.round(r.score * 100) / 100,       // RRF 分（排序用）
        _bestOriginalScore: Math.round(bestOrig * 100) / 100, // 原始分（阈值用）
        source: r.source
      };
    }).slice(0, 3);
  }

  // ============ 传统关键词检索（降级兜底） ============

  searchLegacy(query) {
    const results = [];
    const cleanQuery = query.replace(/[？?，。！!.,!]/g, '').trim();

    for (const item of this.knowledgeBase) {
      let score = 0;
      const cleanQuestion = item.question.replace(/[？?，。！!.,!]/g, '').trim();

      // 1. 精确包含
      if (cleanQuestion.includes(cleanQuery) || cleanQuery.includes(cleanQuestion)) {
        score += 30;
      }

      // 2. 关键词命中
      const matchedKeywords = [];
      for (const keyword of item.keywords) {
        if (cleanQuery.includes(keyword) || keyword.includes(cleanQuery)) {
          score += 12;
          matchedKeywords.push(keyword);
        }
      }

      // 3. 多关键词组合加分
      if (matchedKeywords.length >= 2) {
        score += matchedKeywords.length * 6;
      }

      if (score > 0) {
        results.push({ ...item, score, matchedKeywords });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 3);
  }

  // ============ 对外接口 ============

  /**
   * 主搜索接口（混合检索）
   * 异步，自动降级
   */
  async search(query) {
    await this._ready;
    try {
      const hybridResults = await this.searchHybrid(query);
      if (hybridResults.length > 0) return hybridResults;
    } catch (e) {
      console.error('[知识库] 混合检索失败，降级到 FTS5:', e.message);
      const ftsResults = await this.searchFTS5(query);
      if (ftsResults.length > 0) return ftsResults;
    }
    // 最终降级
    return this.searchLegacy(query);
  }

  /**
   * 获取最佳匹配（用于 AI 回复策略）
   * - Legacy 结果: score >= 2 (原始关键词评分)
   * - FTS5 结果: _bestOriginalScore >= 0.04 (FTS5 BM25，越小越相关)
   * - 混合结果: _bestOriginalScore >= 0.1 (语义检索)
   */
  async getBestMatch(query) {
    await this._ready;
    const results = await this.search(query);
    if (results.length === 0) return null;

    const first = results[0];
    const isLegacy = first.matchedKeywords !== undefined;

    // legacy 降级路径：阈值 20（仅接受精确包含 30 / 强关键词组合），
    // 过滤"什么/怎么"等 2 字泛词弱命中（12 分）导致的答非所问
    if (isLegacy && first.score >= 20) return first;
    if (!isLegacy) {
      // 用原始分做阈值，RRF 分用于排序
      const origScore = first._bestOriginalScore || first.score;
      if (origScore >= 0.04) return first;
    }

    return null;
  }

  // ============ CRUD ============

  async getAll() {
    await this._ready;
    return this.knowledgeBase.map(item => ({
      id: item.id,
      question: item.question,
      answer: item.answer,
      keywords: item.keywords,
      embedding: undefined // 不暴露 embedding 给前端
    }));
  }

  async getById(id) {
    await this._ready;
    const item = this.knowledgeBase.find(item => item.id === id);
    if (!item) return null;
    return {
      id: item.id,
      question: item.question,
      answer: item.answer,
      keywords: item.keywords,
      embedding: undefined
    };
  }

  async addItem(question, answer, keywords = []) {
    await this._ready;
    const item = {
      id: 'k' + Date.now(),
      question,
      answer,
      keywords: keywords.length > 0 ? keywords : this.extractKeywords(question),
      embedding: null
    };
    this.knowledgeBase.push(item);
    await this.saveAll();
    // 异步计算 embedding
    this._computeSingleEmbedding(item);
    return { id: item.id, question: item.question, answer: item.answer, keywords: item.keywords };
  }

  async updateItem(id, question, answer, keywords = []) {
    await this._ready;
    const index = this.knowledgeBase.findIndex(k => k.id === id);
    if (index !== -1) {
      this.knowledgeBase[index].question = question;
      this.knowledgeBase[index].answer = answer;
      this.knowledgeBase[index].keywords = keywords.length > 0 ? keywords : this.extractKeywords(question);
      this.knowledgeBase[index].embedding = null; // 标记为待更新
      await this.saveAll();
      // 异步计算新 embedding
      this._computeSingleEmbedding(this.knowledgeBase[index]);
      return {
        id: this.knowledgeBase[index].id,
        question: this.knowledgeBase[index].question,
        answer: this.knowledgeBase[index].answer,
        keywords: this.knowledgeBase[index].keywords
      };
    }
    return null;
  }

  async deleteItem(id) {
    await this._ready;
    const index = this.knowledgeBase.findIndex(k => k.id === id);
    if (index !== -1) {
      const deleted = this.knowledgeBase.splice(index, 1)[0];
      await this.saveAll();
      return { id: deleted.id, question: deleted.question, answer: deleted.answer, keywords: deleted.keywords };
    }
    return null;
  }

  async clearAll() {
    await this._ready;
    this.knowledgeBase = [];
    await this.saveAll();
    return { success: true };
  }

  async batchAdd(items) {
    await this._ready;
    const existingQuestions = new Set(this.knowledgeBase.map(k => k.question.trim()));
    let added = 0, skipped = 0;
    const newItems = [];

    for (const item of items) {
      const question = (item.question || '').trim();
      const answer = (item.answer || '').trim();
      if (!question || !answer) { skipped++; continue; }

      if (existingQuestions.has(question)) {
        skipped++;
        continue;
      }

      const newItem = {
        id: 'k' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        question,
        answer,
        keywords: Array.isArray(item.keywords) && item.keywords.length > 0
          ? item.keywords.slice(0, 10)
          : this.extractKeywords(question),
        embedding: null
      };
      this.knowledgeBase.push(newItem);
      existingQuestions.add(question);
      newItems.push(newItem);
      added++;
    }

    if (added > 0) {
      await this.saveAll();
      // 异步批量计算 embeddings
      this._batchComputeEmbeddingsFor(newItems);
    }
    return { added, skipped };
  }

  async resetToDefault() {
    await this._ready;
    resetToDefault();
    this.loadKnowledge();
    // 异步计算 embeddings
    this._batchComputeEmbeddings();
    return { success: true, count: this.knowledgeBase.length };
  }

  // ============ Embedding 异步管理 ============

  async _computeSingleEmbedding(item) {
    const vec = await computeEmbedding(item.question);
    if (vec) {
      item.embedding = vec;
      // 持久化
      await db.prepare('UPDATE knowledge SET embedding = ? WHERE id = ?')
        .run(JSON.stringify(vec), item.id);
    }
  }

  async _batchComputeEmbeddingsFor(items) {
    for (const item of items) {
      const vec = await computeEmbedding(item.question);
      if (vec) {
        item.embedding = vec;
        await db.prepare('UPDATE knowledge SET embedding = ? WHERE id = ?')
          .run(JSON.stringify(vec), item.id);
      }
      // 避免同时发起过多请求，间隔 200ms
      await new Promise(r => setTimeout(r, 200));
    }
  }

  async _batchComputeEmbeddings() {
    const items = this.knowledgeBase.filter(k => !k.embedding);
    if (items.length === 0) {
      this._embeddingsReady = true;
      return;
    }
    console.log(`[知识库] 开始异步计算 ${items.length} 条 embedding...`);
    await this._batchComputeEmbeddingsFor(items);
    this._embeddingsReady = true;
    console.log('[知识库] Embedding 计算完成');
  }

  /**
   * 检查是否有可用的 embedding API
   */
  hasEmbeddingAPI() {
    return !!(getConfigValue('deepseek', 'apiKey') || getConfigValue('zhipu', 'apiKey'));
  }
}

// ============ 模块初始化 ============

initKnowledgeTable();
migrateFromJSON();

module.exports = new KnowledgeService();
