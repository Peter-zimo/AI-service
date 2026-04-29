const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============ 加密存储（防止敏感日志明文泄露） ============
const LOG_KEY = (process.env.SENSITIVE_LOG_KEY || '').slice(0, 32);
if (process.env.NODE_ENV === 'production' && !process.env.SENSITIVE_LOG_KEY) {
  console.error('[敏感词] ⚠️ 严重警告：生产环境必须设置 SENSITIVE_LOG_KEY 环境变量，否则日志加密无效！');
}
function encryptText(t) {
  if (!t) return t;
  try { const iv=crypto.randomBytes(16), c=crypto.createCipheriv('aes-256-cbc',Buffer.from(LOG_KEY),iv); return iv.toString('hex')+':'+c.update(t,'utf8','hex')+c.final('hex'); } catch { return t; }
}
function decryptText(t) {
  if (!t||!t.includes(':')) return t;
  try { const p=t.split(':'), d=crypto.createDecipheriv('aes-256-cbc',Buffer.from(LOG_KEY),Buffer.from(p[0],'hex')); return d.update(p[1],'hex','utf8')+d.final('utf8'); } catch { return t; }
}

// ============ 默认敏感词库（已修复误杀） ============
// advertisement 移除了【扫码】【二维码】【支付宝】【微信支付】——正常业务词，非广告
const defaultSensitiveWords = {
  political: [
    '反动', '暴乱', '独裁', '专政', '颠覆', '分裂国家', '恐怖主义',
    '法轮功', '台独', '藏独', '疆独', '香港独立', '颜色革命'
  ],
  pornographic: [
    '淫秽', '色情', '做爱', '性服务', '卖淫', '嫖娼', '裸聊', '裸照',
    '黄色', 'av', '毛片', '成人视频', '性交易'
  ],
  violent: [
    '杀人', '凶杀', '爆炸', '炸弹', '枪击', '恐怖袭击', '暴力',
    '血腥', '残忍', '虐待', '自残', '自杀'
  ],
  advertisement: [
    '加微信', '加QQ', '转账', '汇款',
    '银行卡号', '信用卡', '套现', '刷单', '兼职赚钱'
  ],
  fraud: [
    '诈骗', '骗局', '传销', '非法集资', '洗钱', '黑钱', '假币',
    '钓鱼网站', '木马', '病毒', '黑客', '盗号'
  ]
};

// 敏感词命中记录
let sensitiveLogs = [];
const LOG_MAX_SIZE = 1000; // 最多保留1000条记录

class SensitiveService {
  constructor() {
    this.sensitiveWords = {};
    this.allWords = new Set();
    this.loadWords();
    this.loadLogs();
  }

  // 加载敏感词库
  loadWords() {
    const dataPath = path.join(__dirname, '../data/sensitive-words.json');
    try {
      if (fs.existsSync(dataPath)) {
        const data = fs.readFileSync(dataPath, 'utf-8');
        this.sensitiveWords = JSON.parse(data);
        console.log('[敏感词] 已加载自定义词库');
      } else {
        this.sensitiveWords = { ...defaultSensitiveWords };
        this.saveWords();
        console.log('[敏感词] 已创建默认词库');
      }
      this.buildWordSet();
    } catch (e) {
      console.error('[敏感词] 加载词库失败:', e.message);
      this.sensitiveWords = { ...defaultSensitiveWords };
      this.buildWordSet();
    }
  }

  // 保存敏感词库
  saveWords() {
    const dataPath = path.join(__dirname, '../data/sensitive-words.json');
    try {
      fs.writeFileSync(dataPath, JSON.stringify(this.sensitiveWords, null, 2), 'utf-8');
    } catch (e) {
      console.error('[敏感词] 保存词库失败:', e.message);
    }
  }

  // 构建快速查找集合
  buildWordSet() {
    this.allWords = new Set();
    for (const category in this.sensitiveWords) {
      for (const word of this.sensitiveWords[category]) {
        this.allWords.add(word.toLowerCase());
      }
    }
    console.log(`[敏感词] 词库共 ${this.allWords.size} 个词汇`);
  }

  // 加载日志
  loadLogs() {
    const logPath = path.join(__dirname, '../data/sensitive-logs.json');
    try {
      if (fs.existsSync(logPath)) {
        const data = fs.readFileSync(logPath, 'utf-8');
        sensitiveLogs = JSON.parse(data);
      }
    } catch (e) {
      sensitiveLogs = [];
    }
  }

  // 保存日志（容量+时间双重清理）
  saveLogs() {
    const logPath = path.join(__dirname, '../data/sensitive-logs.json');
    try {
      // 【修复】1. 按容量限制：只保留最近的 LOG_MAX_SIZE 条
      // 【新增】2. 按时间限制：只保留最近 30 天内的记录
      const THIRTY_DAYS_AGO = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const logsToSave = sensitiveLogs
        .slice(-LOG_MAX_SIZE)
        .filter(log => new Date(log.created_at).getTime() > THIRTY_DAYS_AGO);
      fs.writeFileSync(logPath, JSON.stringify(logsToSave, null, 2), 'utf-8');
    } catch (e) {
      console.error('[敏感词] 保存日志失败:', e.message);
    }
  }

  // 检测文本是否包含敏感词
  detect(text) {
    if (!text || typeof text !== 'string') {
      return { hasSensitive: false, words: [], categories: [] };
    }

    const lowerText = text.toLowerCase();
    const foundWords = [];
    const foundCategories = new Set();

    // 遍历所有敏感词进行检测
    for (const category in this.sensitiveWords) {
      for (const word of this.sensitiveWords[category]) {
        if (lowerText.includes(word.toLowerCase())) {
          foundWords.push(word);
          foundCategories.add(category);
        }
      }
    }

    return {
      hasSensitive: foundWords.length > 0,
      words: foundWords,
      categories: Array.from(foundCategories)
    };
  }

  // 记录敏感词命中日志（原文加密存储，防止泄露）
  logDetection(conversationId, source, text, detectionResult, visitorId = null) {
    const log = {
      id: `sl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversation_id: conversationId,
      visitor_id: visitorId,
      source, // 'user' 或 'ai'
      original_text: encryptText(text.slice(0, 500)), // 【修复】原文加密存储
      detected_words: detectionResult.words,
      categories: detectionResult.categories,
      created_at: new Date().toISOString()
    };

    sensitiveLogs.push(log);
    this.saveLogs();
    console.log(`[敏感词] 命中记录: ${detectionResult.words.join(', ')} [${source}]`);
    return log;
  }

  // 获取所有敏感词（按分类）
  getAllWords() {
    return { ...this.sensitiveWords };
  }

  // 添加敏感词
  addWord(category, word) {
    if (!this.sensitiveWords[category]) {
      this.sensitiveWords[category] = [];
    }
    if (!this.sensitiveWords[category].includes(word)) {
      this.sensitiveWords[category].push(word);
      this.buildWordSet();
      this.saveWords();
      return true;
    }
    return false;
  }

  // 删除敏感词
  removeWord(category, word) {
    if (this.sensitiveWords[category]) {
      const index = this.sensitiveWords[category].indexOf(word);
      if (index > -1) {
        this.sensitiveWords[category].splice(index, 1);
        this.buildWordSet();
        this.saveWords();
        return true;
      }
    }
    return false;
  }

  // 添加分类
  addCategory(category) {
    if (!this.sensitiveWords[category]) {
      this.sensitiveWords[category] = [];
      this.saveWords();
      return true;
    }
    return false;
  }

  // 获取检测日志（解密原文）
  getLogs(limit = 100) {
    return sensitiveLogs.slice(-limit).reverse().map(log => ({
      ...log,
      original_text: decryptText(log.original_text) // 【修复】返回时解密
    }));
  }

  // 清空日志
  clearLogs() {
    sensitiveLogs = [];
    this.saveLogs();
  }
}

module.exports = new SensitiveService();
