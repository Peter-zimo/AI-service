/**
 * 知识库导出
 *
 * 支持 JSON 与 CSV。CSV 列顺序固定为 问题/答案/关键词，下游脚本依赖。
 */

'use strict';

const { toCsv } = require('../../utils/csv');

/** 转成导出用的行（关键词用逗号拼接） */
function buildRows(items) {
  return items.map(item => ({
    '问题': item.question,
    '答案': item.answer,
    '关键词': (item.keywords || []).join(','),
  }));
}

/** CSV 文本（带 BOM，Excel 打开不乱码） */
function buildCsv(items) {
  return '\uFEFF' + toCsv(buildRows(items));
}

function filename(format) {
  const date = new Date().toISOString().slice(0, 10);
  return `knowledge_${date}.${format}`;
}

module.exports = { buildRows, buildCsv, filename };
