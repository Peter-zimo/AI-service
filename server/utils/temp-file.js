/**
 * 临时文件工具
 *
 * 上传解析完就要删，删除失败不该影响主流程（文件可能已被并发清理）。
 */

'use strict';

const fs = require('fs');

/**
 * 删除文件，失败只记日志
 * @param {string} filePath
 * @param {string} [label] 日志前缀
 */
function removeTemp(filePath, label = '临时文件') {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    console.error(`[${label}] 清理失败:`, e.message);
  }
}

module.exports = { removeTemp };
