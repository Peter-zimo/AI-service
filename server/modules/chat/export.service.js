/**
 * 会话数据导出（CSV）
 *
 * 每条消息一行，会话信息重复填充。列顺序对外约定，改动会影响下游解析脚本。
 * 数据量有上限，避免大库导出把内存打满。
 */

'use strict';

const { toCsv } = require('../../utils/csv');
const conversationRepo = require('./conversation.repo');
const messageRepo = require('./message.repo');
const ratingRepo = require('./rating.repo');

const EXPORT_LIMITS = { MAX_CONVS: 500, MAX_ROWS: 5000 };

const MODE_LABEL = { ai: 'AI', queue: '排队中', human: '人工' };
const STATUS_LABEL = { active: '进行中', idle: '等待中', closed: '已结束' };

const fmtTime = (value) => (value ? value.replace('T', ' ').slice(0, 19) : '');

/**
 * 导出对话记录
 * @returns {Promise<{csv: string, filenameDate: string}>}
 */
async function exportConversationsCsv() {
  const conversations = await conversationRepo.list(EXPORT_LIMITS.MAX_CONVS);
  const allRatings = await ratingRepo.getAll();

  const rows = [];
  let rowCount = 0;

  for (const conv of conversations) {
    if (rowCount >= EXPORT_LIMITS.MAX_ROWS) break;

    const msgs = await messageRepo.getByConversation(conv.id);
    const rating = allRatings.find(r => r.conversation_id === conv.id);

    const modeLabel = MODE_LABEL[conv.mode] || conv.mode;
    const statusLabel = STATUS_LABEL[conv.status] || conv.status;
    const ratingLabel = rating ? `${rating.score}星` : '未评价';
    const comment = rating ? rating.comment || '' : '';
    const createdLabel = fmtTime(conv.created_at);

    if (msgs.length > 0) {
      for (const msg of msgs) {
        if (rowCount >= EXPORT_LIMITS.MAX_ROWS) break;
        rows.push({
          '对话ID': conv.id,
          '访客': conv.visitor_name || '访客',
          '消息内容': msg.content,
          '角色': msg.role === 'user' ? '访客' : (msg.role === 'agent' ? '客服' : 'AI'),
          '处理方式': modeLabel,
          '会话状态': statusLabel,
          '满意度': ratingLabel,
          '评价内容': comment,
          '消息时间': fmtTime(msg.created_at),
          '会话创建时间': createdLabel,
        });
        rowCount++;
      }
    } else {
      // 无消息的会话不计入行数上限
      rows.push({
        '对话ID': conv.id,
        '访客': conv.visitor_name || '访客',
        '消息内容': '(无消息)',
        '角色': '',
        '处理方式': modeLabel,
        '会话状态': statusLabel,
        '满意度': ratingLabel,
        '评价内容': comment,
        '消息时间': '',
        '会话创建时间': createdLabel,
      });
    }
  }

  if (rows.length >= EXPORT_LIMITS.MAX_ROWS) {
    console.log(`[导出] 数据量已达上限(${EXPORT_LIMITS.MAX_ROWS}行)，如有需要请分批导出`);
  }

  return {
    csv: '\uFEFF' + toCsv(rows),
    filenameDate: new Date().toISOString().slice(0, 10),
  };
}

module.exports = { exportConversationsCsv, EXPORT_LIMITS };
