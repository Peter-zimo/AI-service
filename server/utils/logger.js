/**
 * 日志模块 — 基于 winston
 * 
 * 日志输出：
 *   - 控制台（带颜色，方便开发调试）
 *   - 文件（logs/app.log — 全部级别）
 *   - 文件（logs/error.log — 仅 error）
 * 
 * 日志轮转：单文件超过 10MB 自动切分，最多保留 5 个历史文件
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// 确保 logs 目录存在
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
      let line = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
      // 附加元数据
      if (Object.keys(meta).length > 0) {
        line += ' ' + JSON.stringify(meta);
      }
      // error 级别附带调用栈
      if (stack) {
        line += '\n' + stack;
      }
      return line;
    })
  ),
  transports: [
    // 全量日志
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    // 仅错误日志
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true
    })
  ]
});

// 开发环境同时输出到控制台（带颜色）
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp} ${level}: ${message}`;
      })
    )
  }));
}

module.exports = logger;
