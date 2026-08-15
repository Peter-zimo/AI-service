const express = require('express');
const router = express.Router();
const sensitiveService = require('../services/sensitive');
const { toCsv } = require('../utils/csv');

// 获取所有敏感词（转换为前端期望的格式）
router.get('/words', (req, res) => {
  try {
    const wordsByCategory = sensitiveService.getAllWords();
    // 转换为前端期望的数组格式
    const words = [];
    const now = new Date().toISOString();
    
    for (const [category, wordList] of Object.entries(wordsByCategory)) {
      // 映射分类名
      const catMap = {
        political: 'politics',
        pornographic: 'porn',
        violent: 'violence',
        advertisement: 'ads',
        fraud: 'fraud',
        bike_violation: 'custom',
        inappropriate: 'custom'
      };
      const mappedCategory = catMap[category] || category;
      
      for (const word of wordList) {
        words.push({
          word,
          category: mappedCategory,
          created_at: now
        });
      }
    }
    
    res.json({ success: true, words });
  } catch (error) {
    console.error('获取敏感词失败:', error);
    res.status(500).json({ success: false, error: '获取敏感词失败' });
  }
});

// 添加敏感词
router.post('/words', (req, res) => {
  try {
    const { category, word } = req.body || {};
    if (!category || !word) {
      return res.status(400).json({ success: false, error: '缺少分类或词汇' });
    }
    
    const success = sensitiveService.addWord(category, word);
    if (success) {
      res.json({ success: true, message: '添加成功' });
    } else {
      res.json({ success: false, message: '词汇已存在' });
    }
  } catch (error) {
    console.error('添加敏感词失败:', error);
    res.status(500).json({ success: false, error: '添加敏感词失败' });
  }
});

// 删除敏感词
router.delete('/words', (req, res) => {
  try {
    const { category, word } = req.body || {};
    if (!category || !word) {
      return res.status(400).json({ success: false, error: '缺少分类或词汇' });
    }
    
    const success = sensitiveService.removeWord(category, word);
    if (success) {
      res.json({ success: true, message: '删除成功' });
    } else {
      res.status(404).json({ success: false, message: '词汇不存在' });
    }
  } catch (error) {
    console.error('删除敏感词失败:', error);
    res.status(500).json({ success: false, error: '删除敏感词失败' });
  }
});

// 添加分类
router.post('/category', (req, res) => {
  try {
    const { category } = req.body || {};
    if (!category) {
      return res.status(400).json({ success: false, error: '缺少分类名称' });
    }
    
    const success = sensitiveService.addCategory(category);
    if (success) {
      res.json({ success: true, message: '分类添加成功' });
    } else {
      res.json({ success: false, message: '分类已存在' });
    }
  } catch (error) {
    console.error('添加分类失败:', error);
    res.status(500).json({ success: false, error: '添加分类失败' });
  }
});

// 检测文本
router.post('/detect', (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) {
      return res.status(400).json({ success: false, error: '缺少检测文本' });
    }
    
    const result = sensitiveService.detect(text);
    res.json({ success: true, result });
  } catch (error) {
    console.error('检测失败:', error);
    res.status(500).json({ success: false, error: '检测失败' });
  }
});

// 获取检测日志
router.get('/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = sensitiveService.getLogs(limit);
    res.json({ success: true, logs });
  } catch (error) {
    console.error('获取日志失败:', error);
    res.status(500).json({ success: false, error: '获取日志失败' });
  }
});

// 清空日志
router.delete('/logs', (req, res) => {
  try {
    sensitiveService.clearLogs();
    res.json({ success: true, message: '日志已清空' });
  } catch (error) {
    console.error('清空日志失败:', error);
    res.status(500).json({ success: false, error: '清空日志失败' });
  }
});

// 导出敏感词（支持 XLSX / CSV / JSON）
router.get('/export/:format', (req, res) => {
  try {
    const wordsByCategory = sensitiveService.getAllWords();
    const now = new Date().toISOString().slice(0, 10);

    if (req.params.format === 'json') {
      const words = [];
      for (const [category, wordList] of Object.entries(wordsByCategory)) {
        for (const word of wordList) {
          words.push({ word, category, created_at: now });
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=sensitive_words.json');
      return res.json({ success: true, words });
    }

    const rows = [];
    const catMap = { political: '政治', pornographic: '色情', violent: '暴力', advertisement: '广告', fraud: '欺诈', custom: '自定义' };
    for (const [category, wordList] of Object.entries(wordsByCategory)) {
      for (const word of wordList) {
        rows.push({ '分类': catMap[category] || category, '敏感词': word, '添加时间': now });
      }
    }

    if (req.params.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=sensitive_words_${now}.csv`);
      return res.send('\uFEFF' + toCsv(rows));
    }

    res.status(400).json({ success: false, error: '不支持的格式，请使用 json / csv' });
  } catch (error) {
    console.error('导出失败:', error);
    res.status(500).json({ success: false, error: '导出失败' });
  }
});

module.exports = router;
