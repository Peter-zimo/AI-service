/**
 * 统计模块数据访问层
 *
 * 两类数据：
 *   1. 快照（conversations / messages / ratings 全量数组）—— 5 秒刷新的内存缓存，
 *      避免每次统计请求都全表扫描。代价是存在最多 5 秒的脏读窗口，可接受。
 *   2. 日报表（stats 表）—— 按天累计的会话数/消息数/AI 处理数。
 *
 * 这是 stats 模块唯一允许写 SQL 的地方。
 */

'use strict';

const db = require('../../infra/db');

const CACHE_REFRESH_MS = 5 * 1000;

// ============ 快照缓存 ============

let _conversations = [];
let _messages = [];
let _ratings = [];
let _cacheTimer = null;

async function refresh() {
  _conversations = await db.prepare('SELECT * FROM conversations').all();
  _messages = await db.prepare('SELECT * FROM messages').all();
  _ratings = await db.prepare('SELECT * FROM ratings').all();
}

function startCache() {
  refresh().catch(e => console.error('[统计缓存] 首次刷新失败:', e.message));
  _cacheTimer = setInterval(
    () => refresh().catch(e => console.error('[统计缓存] 刷新失败:', e.message)),
    CACHE_REFRESH_MS
  );
  _cacheTimer.unref();
}

function stopCache() {
  if (_cacheTimer) {
    clearInterval(_cacheTimer);
    _cacheTimer = null;
  }
}

/** 取当前快照（返回引用，调用方只读不要改） */
function snapshot() {
  return { conversations: _conversations, messages: _messages, ratings: _ratings };
}

// ============ 日报表 ============

const today = () => new Date().toISOString().split('T')[0];

async function getOrCreate(date) {
  let row = await db.prepare('SELECT * FROM stats WHERE date = ?').get(date);
  if (!row) {
    await db.prepare(`
      INSERT INTO stats (date, total_conversations, total_messages, ai_handled)
      VALUES (?, 0, 0, 0)
    `).run(date);
    row = await db.prepare('SELECT * FROM stats WHERE date = ?').get(date);
  }
  return row;
}

async function getToday() {
  return getOrCreate(today());
}

async function bump(column) {
  const date = today();
  await getOrCreate(date);
  await db.prepare(`UPDATE stats SET ${column} = ${column} + 1 WHERE date = ?`).run(date);
}

const incrementConversations = () => bump('total_conversations');
const incrementMessages = () => bump('total_messages');
const incrementAiHandled = () => bump('ai_handled');

async function getRecent(days = 7) {
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const row = await db.prepare('SELECT * FROM stats WHERE date = ?').get(dateStr);
    result.push(row || {
      date: dateStr, total_conversations: 0, total_messages: 0, ai_handled: 0,
    });
  }
  return result;
}

async function getSummary() {
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(total_conversations), 0) as total_conversations,
      COALESCE(SUM(total_messages), 0) as total_messages,
      COALESCE(SUM(ai_handled), 0) as ai_handled
    FROM stats
  `).get();

  const avg = await db.prepare('SELECT AVG(score) as avg FROM ratings').get();
  row.avg_satisfaction = avg.avg || 0;
  return row;
}

async function getAllDaily() {
  return db.prepare('SELECT * FROM stats ORDER BY date DESC').all();
}

module.exports = {
  // 快照
  snapshot,
  refresh,
  startCache,
  stopCache,
  // 日报
  getToday,
  getRecent,
  getSummary,
  getAllDaily,
  incrementConversations,
  incrementMessages,
  incrementAiHandled,
};
