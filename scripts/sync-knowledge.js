/**
 * 将 server/data/knowledge.json 同步到 SQLite 知识库。
 *
 * 默认只新增或更新同问题的条目，不删除运行库已有记录；可安全重复执行。
 * 用法：node scripts/sync-knowledge.js
 *       SQLITE_DB_PATH=/path/to/service.db node scripts/sync-knowledge.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'server', 'data', 'knowledge.json');
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(ROOT, 'server', 'data', 'service.db');

function loadSource() {
  const parsed = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const items = Array.isArray(parsed) ? parsed : parsed.knowledge;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('knowledge.json 中没有可同步的知识条目');
  }
  for (const item of items) {
    if (!item.question || !item.answer || !Array.isArray(item.keywords)) {
      throw new Error(`知识条目格式无效: ${item.id || item.question || 'unknown'}`);
    }
  }
  return items;
}

function syncKnowledge() {
  const items = loadSource();
  const db = new Database(DB_PATH);
  const findByQuestion = db.prepare('SELECT id FROM knowledge WHERE question = ?');
  const findById = db.prepare('SELECT id FROM knowledge WHERE id = ?');
  const update = db.prepare(`UPDATE knowledge
    SET answer = ?, keywords = ?, updated_at = ? WHERE id = ?`);
  const insert = db.prepare(`INSERT INTO knowledge
    (id, question, answer, keywords, embedding, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)`);
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;

  db.transaction(() => {
    for (const item of items) {
      const existing = findByQuestion.get(item.question);
      if (existing) {
        update.run(item.answer, JSON.stringify(item.keywords), now, existing.id);
        updated++;
        continue;
      }
      const id = findById.get(item.id) ? `sync_${item.id}` : item.id;
      insert.run(id, item.question, item.answer, JSON.stringify(item.keywords), now, now);
      inserted++;
    }
  })();

  const count = db.prepare('SELECT COUNT(*) AS count FROM knowledge').get().count;
  db.close();
  return { source: items.length, inserted, updated, count };
}

if (require.main === module) {
  try {
    const result = syncKnowledge();
    console.log(`知识库已同步：源 ${result.source} 条，新增 ${result.inserted} 条，更新 ${result.updated} 条，运行库共 ${result.count} 条`);
  } catch (error) {
    console.error(`知识库同步失败: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { loadSource, syncKnowledge };
