/**
 * 知识库导入
 *
 * 两步式：先 parse 出预览（含重复标记与错误行），用户确认后再写库。
 * 支持 CSV / JSON；CSV 列名同时接受中文与英文。
 *
 * 这些函数需要 knowledgeService 实例，由 index.js 注入，避免与入口循环依赖。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../../utils/csv');
const { removeTemp } = require('../../utils/temp-file');

const QUESTION_KEYS = ['问题', 'question'];
const ANSWER_KEYS = ['答案', 'answer'];
const KEYWORD_KEYS = ['关键词', 'keywords'];

function pick(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return '';
}

/**
 * 从上传文件解析出原始行
 * @param {string} filePath 临时文件路径
 * @param {string} originalName 原始文件名（用于判断扩展名）
 * @returns {Array<object>}
 */
function parseFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.csv') {
    return parseCsv(fs.readFileSync(filePath, 'utf-8'));
  }
  if (ext === '.json') {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : (parsed.knowledge || []);
  }

  removeTemp(filePath, '知识库导入');
  const err = new Error('仅支持 csv/json 格式');
  err.unsupported = true;
  throw err;
}

/**
 * 构造导入预览：标出重复项与错误行，不写库
 * @param {object} service knowledgeService 实例
 * @param {Array<object>} rows
 */
async function buildPreview(service, rows) {
  const existing = await service.getAll();
  const existingQuestions = new Set(existing.map(item => item.question.trim()));

  const preview = [];
  const errors = [];

  rows.forEach((row, idx) => {
    const question = pick(row, QUESTION_KEYS).toString().trim();
    const answer = pick(row, ANSWER_KEYS).toString().trim();
    const keywords = pick(row, KEYWORD_KEYS).toString().trim()
      .split(/[,，]/).map(k => k.trim()).filter(Boolean);

    if (!question || !answer) {
      errors.push({ row: idx + 2, reason: '问题或答案为空' });
      return;
    }

    preview.push({
      question,
      answer,
      keywords,
      isDuplicate: existingQuestions.has(question),
    });
  });

  return {
    preview,
    summary: {
      new: preview.filter(i => !i.isDuplicate).length,
      duplicates: preview.filter(i => i.isDuplicate).length,
      errors: errors.length,
    },
    errors,
  };
}

/**
 * 从 /batch 的请求体或文件里取待导入条目
 * @returns {Array<object>}
 */
function collectBatchItems(bodyItems, filePath, originalName) {
  if (filePath) {
    const ext = path.extname(originalName).toLowerCase();
    let items = [];

    if (ext === '.csv') {
      // 注意：批量导入路径下 keywords 保留原始字符串，与预览路径的分词结果不同（历史行为）
      for (const row of parseCsv(fs.readFileSync(filePath, 'utf-8'))) {
        const question = pick(row, QUESTION_KEYS).toString().trim();
        const answer = pick(row, ANSWER_KEYS).toString().trim();
        const keywords = pick(row, KEYWORD_KEYS).toString().trim();
        if (question && answer) items.push({ question, answer, keywords });
      }
    } else {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      items = Array.isArray(parsed) ? parsed : (parsed.knowledge || []);
    }

    removeTemp(filePath, '知识库导入');
    return items;
  }

  if (bodyItems === undefined || bodyItems === null) return null;

  return typeof bodyItems === 'string' ? JSON.parse(bodyItems) : bodyItems;
}

module.exports = { parseFile, buildPreview, collectBatchItems };
