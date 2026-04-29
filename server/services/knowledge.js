/**
 * 知识库服务（SQLite 版本）
 */

const db = require('./sqlite');
const path = require('path');
const fs = require('fs');

// 默认知识库数据
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

// 初始化知识库表
function initKnowledgeTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      keywords TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  console.log('[知识库] 数据库表初始化完成');
}

// 迁移旧 JSON 数据
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
        INSERT INTO knowledge (id, question, answer, keywords, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const item of items) {
        insert.run(item.id, item.question, item.answer, JSON.stringify(item.keywords || []), now, now);
      }
      console.log(`[知识库] 从JSON迁移 ${items.length} 条数据`);
    }
  } catch (e) {
    console.error('[知识库] 迁移失败:', e.message);
    resetToDefault();
  }
}

function resetToDefault() {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO knowledge (id, question, answer, keywords, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const item of defaultKnowledge) {
    insert.run(item.id, item.question, item.answer, JSON.stringify(item.keywords), now, now);
  }
  console.log('[知识库] 重置为默认数据');
}

class KnowledgeService {
  constructor() {
    this.knowledgeBase = [];
    this.loadKnowledge();
    console.log(`[知识库] 加载完成，共 ${this.knowledgeBase.length} 条`);
  }

  loadKnowledge() {
    const rows = db.prepare('SELECT * FROM knowledge ORDER BY id').all();
    this.knowledgeBase = rows.map(r => ({
      id: r.id,
      question: r.question,
      answer: r.answer,
      keywords: JSON.parse(r.keywords || '[]')
    }));
  }

  saveAll() {
    // 全量覆盖（简单粗暴，生产环境可优化）
    db.exec('DELETE FROM knowledge');
    const insert = db.prepare(`
      INSERT INTO knowledge (id, question, answer, keywords, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const item of this.knowledgeBase) {
      insert.run(item.id, item.question, item.answer, JSON.stringify(item.keywords), now, now);
    }
  }

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

  // 关键词匹配检索
  search(query) {
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

  getBestMatch(query) {
    const results = this.search(query);
    if (results.length > 0 && results[0].score >= 2) {
      return results[0];
    }
    return null;
  }

  getAll() {
    return this.knowledgeBase.map(item => ({ ...item }));
  }

  getById(id) {
    return this.knowledgeBase.find(item => item.id === id) || null;
  }

  addItem(question, answer, keywords = []) {
    const item = {
      id: 'k' + Date.now(),
      question,
      answer,
      keywords: keywords.length > 0 ? keywords : this.extractKeywords(question)
    };
    this.knowledgeBase.push(item);
    this.saveAll();
    return item;
  }

  updateItem(id, question, answer, keywords = []) {
    const index = this.knowledgeBase.findIndex(k => k.id === id);
    if (index !== -1) {
      this.knowledgeBase[index] = {
        ...this.knowledgeBase[index],
        question,
        answer,
        keywords: keywords.length > 0 ? keywords : this.extractKeywords(question)
      };
      this.saveAll();
      return this.knowledgeBase[index];
    }
    return null;
  }

  deleteItem(id) {
    const index = this.knowledgeBase.findIndex(k => k.id === id);
    if (index !== -1) {
      const deleted = this.knowledgeBase.splice(index, 1)[0];
      this.saveAll();
      return deleted;
    }
    return null;
  }

  clearAll() {
    this.knowledgeBase = [];
    this.saveAll();
    return { success: true };
  }

  batchAdd(items) {
    const existingQuestions = new Set(this.knowledgeBase.map(k => k.question.trim()));
    let added = 0, skipped = 0;

    for (const item of items) {
      const question = (item.question || '').trim();
      const answer = (item.answer || '').trim();
      if (!question || !answer) { skipped++; continue; }

      if (existingQuestions.has(question)) {
        skipped++;
        continue;
      }

      this.knowledgeBase.push({
        id: 'k' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        question,
        answer,
        keywords: Array.isArray(item.keywords) && item.keywords.length > 0
          ? item.keywords.slice(0, 10)
          : this.extractKeywords(question)
      });
      existingQuestions.add(question);
      added++;
    }

    if (added > 0) this.saveAll();
    return { added, skipped };
  }

  resetToDefault() {
    resetToDefault();
    this.loadKnowledge();
    return { success: true, count: this.knowledgeBase.length };
  }
}

// 初始化
initKnowledgeTable();
migrateFromJSON();

module.exports = new KnowledgeService();
