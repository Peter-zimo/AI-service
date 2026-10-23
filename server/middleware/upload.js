/**
 * 文件上传中间件（知识库导入用）
 *
 * 只负责「收文件、落到临时目录、校验类型与大小」，不解析内容。
 * 临时文件由业务侧用完即删，这里再兜底清理 1 小时前的残留。
 */

'use strict';

const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { removeTemp } = require('../utils/temp-file');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
const ALLOWED_EXTENSIONS = new Set(['.csv', '.json']);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const STALE_MS = 60 * 60 * 1000; // 1 小时

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureUploadDir();
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    // 只保留安全字符，防止路径遍历
    const safeName = Date.now() + '-' + Math.random().toString(36).slice(2, 8) +
      path.extname(file.originalname).toLowerCase();
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error(`不支持的文件类型 ${ext}，仅允许 csv/json`));
    }
    cb(null, true);
  },
});

/** 清理超过 1 小时的残留上传文件 */
function cleanupOldUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return;

  for (const file of fs.readdirSync(UPLOAD_DIR)) {
    const filePath = path.join(UPLOAD_DIR, file);
    try {
      if (Date.now() - fs.statSync(filePath).mtimeMs > STALE_MS) {
        fs.unlinkSync(filePath);
      }
    } catch (_) {
      // 文件可能已被并发删除，忽略
    }
  }
}

// 启动时清理一次（与原 routes/knowledge.js 行为一致）
cleanupOldUploads();

module.exports = { upload, UPLOAD_DIR, ALLOWED_EXTENSIONS, MAX_FILE_SIZE, cleanupOldUploads, removeTemp };
