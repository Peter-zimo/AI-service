/**
 * .env 加载（不覆盖已有环境变量）
 * 供 server/index.js 与脚本共用，避免两套解析逻辑分叉。
 */

'use strict';

const fs = require('fs');

function loadEnv(envPath) {
  if (!envPath || !fs.existsSync(envPath)) return false;

  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;

    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
  return true;
}

module.exports = { loadEnv };
