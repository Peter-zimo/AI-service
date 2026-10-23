/**
 * 知识库数据访问层（Repository）
 *
 * 本文件是 knowledge 模块中唯一允许出现 SQL 的地方。
 * 上层 service 只调这里的方法，不关心底层是 SQLite 还是 PostgreSQL。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../../infra/db');
const { chineseSegment } = require('./segment');
const { defaultKnowledge } = require('./defaults');

const IS_PG = () => process.env.DB_TYPE === 'postgres';
const JSON_SEED_PATH = path.join(__dirname, '../../data/knowledge.json');

// ============ 表结构 ============

/**
 * 建表（幂等）。包含 FTS5 虚拟表，PG 模式跳过 FTS5。
 */
function initTable() {
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

  if (!IS_PG()) {
    // 给旧表补 embedding 列（列已存在会抛错，忽略即可）
    try {
      db.exec('ALTER TABLE knowledge ADD COLUMN embedding TEXT DEFAULT NULL');
      console.log('[知识库] 新增 embedding 列');
    } catch (_) {
      // 列已存在
    }

    // FTS5 独立表，避免 content sync 的 rowid 映射问题
    try { db.exec('DROP TABLE IF EXISTS knowledge_fts'); } catch (_) {}
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        question, answer, keywords
      )
    `);
  }

  console.log('[知识库] 数据库表初始化完成');
}

// ============ 查询 ============

/** 当前知识条目总数（迁移判空用，保持同步语义） */
function count() {
  return db.prepare('SELECT COUNT(*) as count FROM knowledge').get().count;
}

/** 全量读取，按 id 排序 */
async function allRows() {
  return db.prepare('SELECT * FROM knowledge ORDER BY id').all();
}

/** 按 id 读取单条 */
async function findById(id) {
  return db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id);
}

// ============ 写入 ============

/**
 * 全量替换：先清空再逐条插入，最后重建 FTS 索引。
 * @param {Array<{id:string,question:string,answer:string,keywords:string[],embedding:number[]|null}>} items
 */
async function replaceAll(items) {
  await db.exec('DELETE FROM knowledge');

  const insert = db.prepare(`
    INSERT INTO knowledge (id, question, answer, keywords, embedding, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  for (const item of items) {
    await insert.run(
      item.id,
      item.question,
      item.answer,
      JSON.stringify(item.keywords || []),
      item.embedding ? JSON.stringify(item.embedding) : null,
      now,
      now
    );
  }

  rebuildFts();
}

/** 更新单条向量 */
async function updateEmbedding(id, vector) {
  await db.prepare('UPDATE knowledge SET embedding = ? WHERE id = ?')
    .run(JSON.stringify(vector), id);
}

// ============ FTS5 索引 ============

/** 重建 FTS5 索引：清空后逐行分词插入。PG 模式无 FTS5，直接跳过。 */
function rebuildFts() {
  if (IS_PG()) return;

  try {
    db.exec('DELETE FROM knowledge_fts');

    const insert = db.prepare(`
      INSERT INTO knowledge_fts(rowid, question, answer, keywords)
      VALUES (?, ?, ?, ?)
    `);
    const rows = db.prepare('SELECT rowid, question, answer, keywords FROM knowledge').all();

    const txn = db.transaction(() => {
      for (const row of rows) {
        // keywords 是 JSON 文本，先还原成数组再分词，避免引号大括号干扰
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

/**
 * FTS5 检索
 * @param {string} matchExpression 已构造好的 MATCH 表达式
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function searchFts(matchExpression, limit) {
  const rows = await db.prepare(`
    SELECT k.id, k.question, k.answer, k.keywords, knowledge_fts.rank
    FROM knowledge_fts
    JOIN knowledge k ON k.rowid = knowledge_fts.rowid
    WHERE knowledge_fts MATCH ?
    ORDER BY knowledge_fts.rank
    LIMIT ?
  `).all(matchExpression, limit);

  return rows.map(r => ({
    id: r.id,
    question: r.question,
    answer: r.answer,
    keywords: JSON.parse(r.keywords || '[]'),
    embedding: null,
    score: Math.round((1 / (1 + Math.abs(r.rank))) * 100) / 100 || 0.1,
    _ftsScore: true,
  }));
}

// ============ 初始化数据 ============

/** 写入种子数据（默认 6 条） */
function resetToDefault() {
  const now = new Date().toISOString();

  const insert = db.prepare(IS_PG()
    ? `INSERT INTO knowledge (id, question, answer, keywords, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         question = EXCLUDED.question,
         answer = EXCLUDED.answer,
         keywords = EXCLUDED.keywords,
         embedding = EXCLUDED.embedding,
         updated_at = EXCLUDED.updated_at`
    : `INSERT OR REPLACE INTO knowledge (id, question, answer, keywords, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`);

  for (const item of defaultKnowledge) {
    insert.run(item.id, item.question, item.answer,
      JSON.stringify(item.keywords), null, now, now);
  }

  rebuildFts();
  console.log('[知识库] 重置为默认数据');
}

/**
 * 首次启动时把 knowledge.json 迁移进数据库（仅当表为空）。
 */
function migrateFromJSON() {
  if (!fs.existsSync(JSON_SEED_PATH)) {
    console.log('[知识库] 无旧JSON数据，初始化默认数据');
    resetToDefault();
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(JSON_SEED_PATH, 'utf-8'));
    const items = Array.isArray(data) ? data : (data.knowledge || []);

    if (items.length === 0) {
      console.log('[知识库] JSON为空，初始化默认数据');
      resetToDefault();
      return;
    }

    if (count() === 0) {
      const insert = db.prepare(`
        INSERT INTO knowledge (id, question, answer, keywords, embedding, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();

      for (const item of items) {
        insert.run(item.id, item.question, item.answer,
          JSON.stringify(item.keywords || []), null, now, now);
      }

      rebuildFts();
      console.log(`[知识库] 从JSON迁移 ${items.length} 条数据`);
    }
  } catch (e) {
    console.error('[知识库] 迁移失败:', e.message);
    resetToDefault();
  }
}

module.exports = {
  initTable,
  count,
  allRows,
  findById,
  replaceAll,
  updateEmbedding,
  rebuildFts,
  searchFts,
  resetToDefault,
  migrateFromJSON,
};
