/**
 * 日志模块 — 基于 winston（企业级结构化输出）
 *
 * 输出：
 *   - app.log / error.log：JSON Lines 格式（机器可解析，对接 ELK/Loki）
 *   - 控制台（dev 环境，带颜色）
 * 轮转：单文件 10MB，保留 5 个历史文件
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// 结构化 JSON 格式（生产/文件）
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: jsonFormat,
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

// 开发环境控制台输出（带颜色，人类可读）
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const extra = Object.keys(meta).length > 1
          ? ' ' + JSON.stringify(meta)
          : '';
        return `${timestamp} ${level}: ${message}${extra}`;
      })
    ),
  }));
}

module.exports = logger;
