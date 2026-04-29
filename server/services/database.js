/**
 * 数据库服务模块（SQLite 版本）
 * 使用 better-sqlite3，WAL 模式支持并发
 */

const db = require('./sqlite');
const { v4: uuidv4 } = require('uuid');

// 会话状态常量
const CONVERSATION_STATUS = {
  ACTIVE: 'active',
  IDLE: 'idle',
  CLOSED: 'closed'
};

const TIMEOUT_CONFIG = {
  IDLE_TIMEOUT: 5 * 60 * 1000,
  CLOSE_TIMEOUT: 10 * 60 * 1000,
  CHECK_INTERVAL: 30 * 1000
};

const CONVERSATION_MODE = {
  AI: 'ai',
  QUEUE: 'queue',
  HUMAN: 'human'
};

// 会话服务
const conversations = {
  create: (id, visitorId, visitorName) => {
    // 先关闭该访客之前的活跃会话
    const existingActive = conversations.getActiveByVisitor(visitorId);
    if (existingActive) {
      conversations.close(existingActive.id, 'new_session');
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO conversations (id, visitor_id, visitor_name, created_at, updated_at, last_message_at, status, mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, visitorId, visitorName || '访客', now, now, now, CONVERSATION_STATUS.ACTIVE, CONVERSATION_MODE.AI);

    console.log(`[会话] 创建新会话: ${id}, 访客: ${visitorId}`);
    return conversations.getById(id);
  },

  getById: (id) => {
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return row || null;
  },

  getActiveByVisitor: (visitorId) => {
    const row = db.prepare(`
      SELECT * FROM conversations WHERE visitor_id = ? AND status != ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(visitorId, CONVERSATION_STATUS.CLOSED);
    return row || null;
  },

  updateLastMessage: (id) => {
    const c = conversations.getById(id);
    if (c && c.status !== CONVERSATION_STATUS.CLOSED) {
      const now = new Date().toISOString();
      const updates = { status: c.status === CONVERSATION_STATUS.IDLE ? CONVERSATION_STATUS.ACTIVE : c.status };
      db.prepare(`
        UPDATE conversations SET last_message_at = ?, updated_at = ?, status = ? WHERE id = ?
      `).run(now, now, updates.status, id);
      if (c.status === CONVERSATION_STATUS.IDLE) {
        console.log(`[会话] ${id} 从idle恢复为active`);
      }
      return true;
    }
    return false;
  },

  setIdle: (id) => {
    const c = conversations.getById(id);
    if (c && c.status === CONVERSATION_STATUS.ACTIVE) {
      db.prepare(`
        UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?
      `).run(CONVERSATION_STATUS.IDLE, new Date().toISOString(), id);
      console.log(`[会话] ${id} 标记为idle`);
      return true;
    }
    return false;
  },

  close: (id, reason = 'manual') => {
    const c = conversations.getById(id);
    if (c && c.status !== CONVERSATION_STATUS.CLOSED) {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE conversations SET status = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?
      `).run(CONVERSATION_STATUS.CLOSED, now, reason, now, id);
      console.log(`[会话] ${id} 已关闭，原因: ${reason}`);
      return true;
    }
    return false;
  },

  checkTimeouts: () => {
    const now = new Date();
    const rows = db.prepare("SELECT * FROM conversations WHERE status != ?").all(CONVERSATION_STATUS.CLOSED);
    let idleCount = 0, closeCount = 0;

    for (const c of rows) {
      const lastTime = new Date(c.last_message_at || c.updated_at);
      const idleTime = now - lastTime;

      if (idleTime >= TIMEOUT_CONFIG.CLOSE_TIMEOUT) {
        conversations.close(c.id, 'timeout');
        closeCount++;
      } else if (idleTime >= TIMEOUT_CONFIG.IDLE_TIMEOUT && c.status === CONVERSATION_STATUS.ACTIVE) {
        conversations.setIdle(c.id);
        idleCount++;
      }
    }

    if (idleCount > 0 || closeCount > 0) {
      console.log(`[会话超时检查] idle: ${idleCount}, closed: ${closeCount}`);
    }
    return { idleCount, closeCount };
  },

  getStats: () => {
    const total = db.prepare('SELECT COUNT(*) as count FROM conversations').get().count;
    const active = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE status = ?").get(CONVERSATION_STATUS.ACTIVE).count;
    const idle = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE status = ?").get(CONVERSATION_STATUS.IDLE).count;
    const closed = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE status = ?").get(CONVERSATION_STATUS.CLOSED).count;
    return { total, active, idle, closed };
  },

  list: (limit = 100) => {
    return db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit);
  },

  setMode: (id, mode, agentInfo = null) => {
    const c = conversations.getById(id);
    if (c && c.status !== CONVERSATION_STATUS.CLOSED) {
      if (agentInfo) {
        db.prepare(`
          UPDATE conversations SET mode = ?, assigned_agent = ?, agent_name = ?, updated_at = ? WHERE id = ?
        `).run(mode, agentInfo.id, agentInfo.name, new Date().toISOString(), id);
      } else {
        db.prepare(`
          UPDATE conversations SET mode = ?, updated_at = ? WHERE id = ?
        `).run(mode, new Date().toISOString(), id);
      }
      console.log(`[会话] ${id} 模式切换为: ${mode}`);
      return true;
    }
    return false;
  },

  STATUS: CONVERSATION_STATUS,
  TIMEOUT: TIMEOUT_CONFIG,
  MODE: CONVERSATION_MODE
};

// 消息服务
const messages = {
  add: (id, convId, role, content, aiConf = null) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, ai_confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, convId, role, content, aiConf, now);

    db.prepare(`
      UPDATE conversations SET updated_at = ? WHERE id = ?
    `).run(now, convId);

    return { id, conversation_id: convId, role, content, ai_confidence: aiConf, created_at: now };
  },

  getByConversation: (convId) => {
    return db.prepare(`
      SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
    `).all(convId);
  },

  countByConversation: (convId) => {
    return db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?').get(convId).count;
  }
};

// 评价服务
const ratings = {
  add: (id, convId, score, comment = null) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO ratings (id, conversation_id, score, comment, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, convId, score, comment, now);
    return { id, conversation_id: convId, score, comment, created_at: now };
  },

  getByConversation: (convId) => {
    return db.prepare('SELECT * FROM ratings WHERE conversation_id = ?').get(convId) || null;
  },

  getAverage: () => {
    const row = db.prepare('SELECT AVG(score) as avg FROM ratings').get();
    return row.avg || 0;
  },

  getAll: () => {
    return db.prepare('SELECT * FROM ratings ORDER BY created_at DESC').all();
  }
};

// 统计服务
const stats = {
  _today: () => new Date().toISOString().split('T')[0],

  _getOrCreate: (date) => {
    let s = db.prepare('SELECT * FROM stats WHERE date = ?').get(date);
    if (!s) {
      db.prepare(`
        INSERT INTO stats (date, total_conversations, total_messages, ai_handled)
        VALUES (?, 0, 0, 0)
      `).run(date);
      s = db.prepare('SELECT * FROM stats WHERE date = ?').get(date);
    }
    return s;
  },

  getToday: () => stats._getOrCreate(stats._today()),

  incrementConversations: () => {
    const date = stats._today();
    stats._getOrCreate(date);
    db.prepare('UPDATE stats SET total_conversations = total_conversations + 1 WHERE date = ?').run(date);
  },

  incrementMessages: () => {
    const date = stats._today();
    stats._getOrCreate(date);
    db.prepare('UPDATE stats SET total_messages = total_messages + 1 WHERE date = ?').run(date);
  },

  incrementAiHandled: () => {
    const date = stats._today();
    stats._getOrCreate(date);
    db.prepare('UPDATE stats SET ai_handled = ai_handled + 1 WHERE date = ?').run(date);
  },

  getRecent: (days = 7) => {
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const s = db.prepare('SELECT * FROM stats WHERE date = ?').get(dateStr);
      result.push(s || { date: dateStr, total_conversations: 0, total_messages: 0, ai_handled: 0 });
    }
    return result;
  },

  getSummary: () => {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(total_conversations), 0) as total_conversations,
        COALESCE(SUM(total_messages), 0) as total_messages,
        COALESCE(SUM(ai_handled), 0) as ai_handled
      FROM stats
    `).get();
    row.avg_satisfaction = ratings.getAverage();
    return row;
  },

  // 获取数据库中的原始数据（供路由使用）
  getAll: () => {
    return db.prepare('SELECT * FROM stats ORDER BY date DESC').all();
  }
};

// 启动定时检查
function startTimeoutChecker() {
  setInterval(() => {
    conversations.checkTimeouts();
  }, conversations.TIMEOUT.CHECK_INTERVAL);
  console.log('[会话] 超时检查定时器已启动，每30秒检查一次');
}

// 启动
startTimeoutChecker();

// 初始化日志
const convCount = db.prepare('SELECT COUNT(*) as count FROM conversations').get().count;
console.log(`[数据库] SQLite 初始化完成，会话数：${convCount}`);

// 暴露原始数组（兼容 stats.js 中的数组方法）
let _conversations = [];
let _messages = [];
let _ratings = [];

// 刷新内存缓存
function refreshCache() {
  _conversations = db.prepare('SELECT * FROM conversations').all();
  _messages = db.prepare('SELECT * FROM messages').all();
  _ratings = db.prepare('SELECT * FROM ratings').all();
}

// 定期刷新缓存（每 5 秒）
// 注意：读写存在短暂竞态窗口（约5秒内的脏读），对统计精度要求高的场景建议改为直接查SQLite
let _cacheTimer = null;
function startCacheRefresh() {
  refreshCache();
  _cacheTimer = setInterval(refreshCache, 5000);
}
function stopCacheRefresh() {
  if (_cacheTimer) { clearInterval(_cacheTimer); _cacheTimer = null; }
}
startCacheRefresh();

// 对话统计服务
const convSvc = conversations;
const msgSvc = messages;
const ratingSvc = ratings;
const statsSvc = stats;

// chat.js 用 db.conversations，stats.js 用解构变量
// 所有引用统一通过 module.exports
module.exports = {
  // Service API（chat.js 用 db.conversations.xxx）
  conversations: convSvc,
  messages: msgSvc,
  ratings: ratingSvc,
  stats: statsSvc,
  // Array data（stats.js 用 conversations.filter 等）
  _conversations: () => _conversations,
  _messages: () => _messages,
  _ratings: () => _ratings,
  // 原始 SQLite 实例（用于直接 .prepare() 调用）
  _db: db,
  refreshCache,
  stopCacheRefresh
};
