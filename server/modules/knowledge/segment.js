/**
 * 中文分词（FTS5 兼容层）
 *
 * 背景：FTS5 的 unicode61 tokenizer 会把整句中文当成一个 token，
 * MATCH '营业' 匹配不上 token "营业时间"。
 * 这里在应用层做分词：单字 + 双字组合，解决中文全文搜索问题。
 */

'use strict';

const HAN = /[\u4e00-\u9fa5]/;
const HAN_PAIR = /^[\u4e00-\u9fa5]{2}$/;
const ALNUM = /^[a-zA-Z0-9]+$/;

/**
 * 把一段中文文本切成 FTS5 可用的 token 串。
 * @param {string} text
 * @returns {string} 空格分隔的 token
 */
function chineseSegment(text) {
  if (!text) return '';
  const clean = String(text).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ').trim();
  if (!clean) return '';

  const tokens = new Set();

  // 单字
  for (const ch of clean) {
    if (HAN.test(ch)) tokens.add(ch);
  }

  // 双字
  for (let i = 0; i < clean.length - 1; i++) {
    const pair = clean.substring(i, i + 2);
    if (HAN_PAIR.test(pair)) tokens.add(pair);
  }

  // 英文 / 数字
  for (const word of clean.split(/\s+/)) {
    if (ALNUM.test(word) && word.length > 0) tokens.add(word.toLowerCase());
  }

  return Array.from(tokens).join(' ');
}

module.exports = { chineseSegment, HAN, HAN_PAIR, ALNUM };
