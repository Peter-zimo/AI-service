/**
 * 备份调度纯函数（便于单测，不依赖数据库）
 */

'use strict';

/** 本地日期 YYYY-MM-DD（不要用 toISOString，避免 UTC 与本地 03:00 混用） */
function localDateStr(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 距离下一个本地 03:00 的毫秒数（恰好 03:00:00.000 时排到次日） */
function nextBackupDelay(now = new Date()) {
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

module.exports = { localDateStr, nextBackupDelay };
