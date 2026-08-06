/**
 * 未匹配查询服务（知识库反馈闭环）
 * 记录 AI 未能通过知识库回答的查询，支持运营补充知识
 */
const db = require('./sqlite');
const { v4: uuidv4 } = require('uuid');

class UnansweredService {
  /**
   * 记录一条未匹配查询
   * 如果相同 query 已存在且状态为 pending，count+1
   */
  recordQuery(query) {
    if (!query || !query.trim()) return;
    const clean = query.trim().slice(0, 200);

    // 查是否已有相同的 pending 记录
    const existing = db.prepare(
      "SELECT id, count FROM unanswered_queries WHERE query = ? AND status = 'pending'"
    ).get(clean);

    if (existing) {
      db.prepare(
        "UPDATE unanswered_queries SET count = count + 1, last_seen = ? WHERE id = ?"
      ).run(new Date().toISOString(), existing.id);
    } else {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO unanswered_queries (id, query, count, first_seen, last_seen, status, created_at)
        VALUES (?, ?, 1, ?, ?, 'pending', ?)
      `).run(uuidv4(), clean, now, now, now);
    }
  }

  /**
   * 获取未匹配查询列表
   * @param {string} status - 'pending' | 'added' | 'dismissed' | 'all'
   * @param {number} limit
   */
  list(status = 'pending', limit = 100) {
    let rows;
    if (status === 'all') {
      rows = db.prepare(
        'SELECT * FROM unanswered_queries ORDER BY count DESC, last_seen DESC LIMIT ?'
      ).all(limit);
    } else {
      rows = db.prepare(
        'SELECT * FROM unanswered_queries WHERE status = ? ORDER BY count DESC, last_seen DESC LIMIT ?'
      ).all(status, limit);
    }
    return rows;
  }

  /**
   * 补充答案并添加到知识库
   */
  approve(id, answer, createdBy) {
    if (!answer || !answer.trim()) return { success: false, error: '答案不能为空' };

    const item = db.prepare('SELECT * FROM unanswered_queries WHERE id = ?').get(id);
    if (!item) return { success: false, error: '记录不存在' };

    // 添加到知识库
    const knowledgeService = require('./knowledge');
    const result = knowledgeService.addItem(item.query, answer.trim());

    // 更新状态
    db.prepare(
      "UPDATE unanswered_queries SET status = 'added', answer = ?, created_by = ? WHERE id = ?"
    ).run(answer.trim(), createdBy || 'admin', id);

    return { success: true, knowledgeId: result.id, question: item.query };
  }

  /**
   * 忽略该查询
   */
  dismiss(id) {
    const item = db.prepare('SELECT * FROM unanswered_queries WHERE id = ?').get(id);
    if (!item) return { success: false, error: '记录不存在' };

    db.prepare("UPDATE unanswered_queries SET status = 'dismissed' WHERE id = ?").run(id);
    return { success: true };
  }

  /**
   * 统计信息
   */
  stats() {
    const pending = db.prepare("SELECT COUNT(*) as count FROM unanswered_queries WHERE status = 'pending'").get();
    const added = db.prepare("SELECT COUNT(*) as count FROM unanswered_queries WHERE status = 'added'").get();
    const dismissed = db.prepare("SELECT COUNT(*) as count FROM unanswered_queries WHERE status = 'dismissed'").get();
    const topPending = db.prepare(
      "SELECT query, count FROM unanswered_queries WHERE status = 'pending' ORDER BY count DESC LIMIT 10"
    ).all();
    return {
      pending: pending.count,
      added: added.count,
      dismissed: dismissed.count,
      topPending
    };
  }

  /**
   * 每日趋势（近 N 天）
   */
  trend(days = 30) {
    const rows = db.prepare(
      "SELECT substr(first_seen,1,10) as day, COUNT(*) as new_count FROM unanswered_queries GROUP BY day ORDER BY day DESC LIMIT ?"
    ).all(days);

    // 按日期正序排列
    rows.reverse();

    // 累计统计
    let cumulative = 0;
    const result = rows.map(r => {
      cumulative += r.new_count;
      // 当日 solved（added + dismissed）
      const solved = db.prepare(
        "SELECT COUNT(*) as c FROM unanswered_queries WHERE substr(first_seen,1,10) = ? AND status IN ('added','dismissed')"
      ).get(r.day);
      return {
        date: r.day,
        newCount: r.new_count,
        solved: solved.c,
        pending: cumulative - (solved.c || 0),
        cumulative
      };
    });

    const latest = rows.length > 0 ? rows[rows.length - 1].day : null;
    return {
      data: result,
      total: result.length > 0 ? result[result.length - 1].cumulative : 0,
      latestDate: latest
    };
  }
}

module.exports = new UnansweredService();
