/**
 * 任务模块入口
 *
 * 加载内置处理器后，对外暴露 registry。
 */

'use strict';

const registry = require('./registry');

require('./handlers');

module.exports = registry;
