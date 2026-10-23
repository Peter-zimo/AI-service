/**
 * 关键词抽取
 *
 * 从问题文本里抽取 2 字以上的中文片段作为关键词候选，
 * 用于知识条目新增时自动补 keywords。
 */

'use strict';

const HAN = /[\u4e00-\u9fa5]/;
const MAX_KEYWORDS = 5;
const MIN_LEN = 2;

/**
 * @param {string} text
 * @returns {string[]} 去重后的关键词，最多 5 个
 */
function extractKeywords(text) {
  if (!text) return [];

  const words = [];
  let current = '';

  for (const char of String(text)) {
    if (HAN.test(char)) {
      current += char;
      if (current.length >= MIN_LEN) words.push(current);
    } else {
      if (current.length >= MIN_LEN) words.push(current);
      current = '';
    }
  }
  if (current.length >= MIN_LEN) words.push(current);

  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

module.exports = { extractKeywords };
