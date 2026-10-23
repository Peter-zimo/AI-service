/**
 * 统计模块的日期工具
 *
 * 统计口径高度依赖「按天切分」，这里统一处理，避免各计算函数各写一套。
 */

'use strict';

/** 解析为 Date，非法返回 null */
function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 取最近 N 天的起止时间（含今天） */
function getDateRange(days) {
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const start = new Date();
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);

  return { start, end };
}

/** 格式化为 YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

/** 分钟差（四舍五入） */
function diffMinutes(d1, d2) {
  return Math.round((d2 - d1) / 60000);
}

/** 最近 N 天的日期字符串，从早到晚 */
function lastNDates(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push({ date: d, dateStr: fmtDate(d) });
  }
  return dates;
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

module.exports = { parseDate, getDateRange, fmtDate, diffMinutes, lastNDates, WEEKDAY_LABELS };
