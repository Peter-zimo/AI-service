/**
 * sensitive 模块对外出口
 *
 * 敏感词过滤：词库加载、检测、命中日志（AES-256-CBC 加密存储）。
 * 实现见 sensitive.service.js。
 */

'use strict';

module.exports = require('./sensitive.service');
