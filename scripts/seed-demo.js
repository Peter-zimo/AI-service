#!/usr/bin/env node
/**
 * 演示数据生成器 — 一键生成 30 天模拟运营数据
 *
 * 用法：
 *   node scripts/seed-demo.js          # 生成 30 天演示数据（先清空旧数据）
 *   node scripts/seed-demo.js --clean  # 只清空演示数据
 *
 * 生成内容：会话(conversations) / 消息(messages) / 评价(ratings) / 未答问题(unanswered_queries)
 * 让 Dashboard 12 KPI + 4 图表 + 2 列表 全部有数据可展示
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'server', 'data', 'service.db');
const CLEAN_ONLY = process.argv.includes('--clean');

if (!fs.existsSync(DB_PATH)) {
  console.error('❌ 数据库不存在：' + DB_PATH);
  console.error('   请先启动服务（node start.js）再运行本脚本');
  process.exit(1);
}

const db = new Database(DB_PATH);

// ============ 工具 ============
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pad = (n) => String(n).padStart(2, '0');
function randTimeInDay(dateStr, h1, h2) {
  const h = rnd(h1, h2), m = rnd(0, 59), s = rnd(0, 59);
  return `${dateStr}T${pad(h)}:${pad(m)}:${pad(s)}.000Z`;
}
function genVisitor() {
  return 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

// ============ 数据池 ============
const KB_QUESTIONS = [
  '如何扫码开锁？', '车辆没电了怎么办？', '如何还车？', '骑行如何计费？', '怎么联系人工客服？',
  '如何注册账号？', '忘记密码怎么办？', '不在P点停车会怎样？', '如何申请退款？', '骑行卡如何使用？',
  '什么是骑行会员？', '如何上报车辆故障？', '骑行安全注意事项有哪些？', '还车失败怎么处理？',
  '账号被锁定怎么办？', '如何查看骑行记录？', '夜间骑行如何收费？', '骑行中车辆出现故障怎么办？',
  '可以多人共用一辆车吗？', '如何查询附近停车点？', '骑行费用如何支付？', '临时锁车怎么操作？',
];
const KB_ANSWERS = {
  '如何扫码开锁？': '打开APP或小程序，点击"扫码开锁"，扫描车座下方或车把上的二维码即可解锁骑行。',
  '车辆没电了怎么办？': '请先安全靠边停车，打开APP点击"故障上报"选择"车辆没电"，本次订单免收超时费用。',
  '如何还车？': '将车辆停放在P点停车位内，在APP点击"还车"，听到"锁车成功"即完成还车。',
  '骑行如何计费？': '普通车1.5元/30分钟，电动车2.5元/30分钟，不足30分钟按30分钟计费。',
  '怎么联系人工客服？': '在聊天窗口点击"转人工"按钮，或拨打客服热线400-XXX-XXXX。',
  '如何注册账号？': '打开APP或小程序，点击"注册"，输入手机号获取验证码即可完成注册。',
  '忘记密码怎么办？': '在登录页点击"忘记密码"，通过短信验证码即可重置密码。',
  '不在P点停车会怎样？': '未停入P点会收取调度费，普通车10元，电动车15元。',
  '如何申请退款？': '在APP"我的-钱包-订单明细"中找到订单，点击"申请退款"即可。',
  '骑行卡如何使用？': '骑行卡在有效期内每次骑行自动抵扣免费时长，超出部分按标准计费。',
  '什么是骑行会员？': '会员月卡19.9元，包含每日2次免费骑行和专属优惠券。',
  '如何上报车辆故障？': '在地图页点击故障车辆图标，或订单页点击"故障上报"，拍照上传即可。',
  '骑行安全注意事项有哪些？': '骑行前检查刹车轮胎，电动车佩戴头盔，遵守交通规则，12岁以下禁止骑行。',
  '还车失败怎么处理？': '确认车辆在白线停车位内，刷新网络重试，如仍失败请联系在线客服协助还车。',
  '账号被锁定怎么办？': '请通过在线客服申诉，提供身份验证后即可解锁。',
  '如何查看骑行记录？': '在APP"我的-行程记录"中可查看全部骑行历史。',
  '夜间骑行如何收费？': '夜间（23:00-06:00）普通车加收1元夜间服务费，电动车加收2元。',
  '骑行中车辆出现故障怎么办？': '请立即安全停车，点击"故障上报"选择故障类型，故障车辆本次订单免费。',
  '可以多人共用一辆车吗？': '不建议多人共骑，安全风险高，每辆车仅支持单人骑行。',
  '如何查询附近停车点？': '打开APP首页地图，绿色标记即为P点停车位。',
  '骑行费用如何支付？': '支持微信、支付宝、银行卡支付，骑行结束后自动扣费。',
  '临时锁车怎么操作？': '点击APP的"临时锁车"功能，车辆会锁定，但计时不停。',
};
const CHITCHAT = [
  '你好', '在吗', '谢谢', '好的知道了', '你们公司在哪里', '有没有优惠活动',
  '最近有什么新功能吗', 'APP打不开了怎么办', '系统显示异常',
];
const HUMAN_QUESTIONS = [
  '我要投诉，客服态度太差', '订单扣费异常，多扣了我30块', '我要开发票', '账户被盗了',
  '车辆停在小区里被锁了', '我要退押金', '月卡没生效，扣了我全款',
];
const UNANSWERED_POOL = [
  '车辆可以骑进小区吗', '押金什么时候能退', '发票怎么开', '能不能包月不限次',
  '儿童车有没有', '头盔是免费的吗', '跨城市骑行怎么计费', '企业团队用车怎么联系',
  '车子可以骑到外地吗', '雨天骑行有补贴吗', '积分怎么兑换', '学生有优惠吗',
];
const RATING_COMMENTS = {
  5: ['很好，回复很快', '非常满意，解决了我的问题', '客服态度很好', '体验很棒', '专业高效'],
  4: ['不错，就是等了一会儿', '还可以', '满意', '问题解决了'],
  3: ['一般般', '回复有点慢', '希望能更详细一些'],
  2: ['不太满意，没有完全解决', '回复太慢了', '答案不够清楚'],
  1: ['很差，问题没有解决', '体验糟糕', '客服态度不好'],
};

// ============ 主逻辑 ============
function cleanAll() {
  db.exec(`
    DELETE FROM ratings;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM unanswered_queries;
  `);
  console.log('🧹 已清空旧演示数据');
}

function generate() {
  cleanAll();
  const now = new Date();
  const insertConv = db.prepare(`INSERT INTO conversations
    (id, visitor_id, visitor_name, created_at, updated_at, last_message_at, status, mode, assigned_agent, agent_name, closed_at, close_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMsg = db.prepare(`INSERT INTO messages
    (id, conversation_id, role, content, ai_confidence, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertRating = db.prepare(`INSERT INTO ratings
    (id, conversation_id, score, comment, created_at) VALUES (?, ?, ?, ?, ?)`);
  const insertUnanswered = db.prepare(`INSERT INTO unanswered_queries
    (id, query, count, first_seen, last_seen, status, answer, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let convCount = 0, msgCount = 0, ratingCount = 0, uaCount = 0;

  for (let day = 29; day >= 0; day--) {
    const d = new Date(now);
    d.setDate(d.getDate() - day);
    const dateStr = d.toISOString().slice(0, 10);
    const weekday = d.getDay();

    // 工作日多、周末少；近几天略增（演示趋势上升）
    let base = weekday === 0 || weekday === 6 ? 6 : 12;
    const dayConvs = rnd(Math.max(base - 3, 2), base + rnd(2, 8));
    // 今天的会话是活跃的（未关闭）
    const isToday = day === 0;

    for (let i = 0; i < dayConvs; i++) {
      const convId = 'demo_' + dateStr + '_' + i;
      const visitorId = genVisitor();
      const created = randTimeInDay(dateStr, 8, 22);
      const visitorName = '访客' + rnd(1000, 9999);

      // 会话模式：15% 转人工
      const mode = Math.random() < 0.15 ? 'human' : 'ai';
      const assignedAgent = mode === 'human' ? 'agent_001' : null;
      const agentName = mode === 'human' ? '客服小A' : null;

      // 状态
      let status, closedAt = null, closeReason = null;
      if (isToday) {
        status = Math.random() < 0.6 ? 'active' : 'idle';
      } else {
        const r = Math.random();
        if (r < 0.82) { status = 'closed'; closedAt = created.replace('T', 'T').slice(0, 10) + 'T' + pad(rnd(8, 23)) + ':00:00.000Z'; closeReason = pick(['rated', 'manual', 'timeout', 'rated', 'manual']); }
        else if (r < 0.94) { status = 'idle'; }
        else { status = 'active'; }
      }

      const msgCountThis = rnd(2, 8);
      let lastMsgAt = created;
      // 先插入会话（messages 有外键引用）
      insertConv.run(convId, visitorId, visitorName, created, created, created, status, mode, assignedAgent, agentName, closedAt, closeReason);
      convCount++;

      // 第一轮：用户提问
      const useKb = Math.random() < 0.7;
      const q = useKb ? pick(KB_QUESTIONS) : pick(CHITCHAT);
      insertMsg.run('m' + convId + '_0', convId, 'user', q, null, null, created);
      // 助手回复
      const sourceRoll = Math.random();
      const source = sourceRoll < 0.6 ? 'knowledge' : (sourceRoll < 0.9 ? 'ai' : 'fallback');
      const answer = (KB_ANSWERS[q] || '根据您的问题，建议您打开APP查看相关帮助，或转人工客服为您处理。') + '（演示数据）';
      const m1 = new Date(new Date(created).getTime() + rnd(3, 30) * 1000).toISOString();
      insertMsg.run('m' + convId + '_1', convId, 'assistant', answer, 0.9, source, m1);
      lastMsgAt = m1;

      // 追加对话轮次
      for (let j = 2; j < msgCountThis; j++) {
        const t = new Date(new Date(lastMsgAt).getTime() + rnd(20, 180) * 1000).toISOString();
        if (j % 2 === 0) {
          insertMsg.run('m' + convId + '_' + j, convId, 'user', pick([...CHITCHAT, '然后呢', '能再详细说说吗', '好的', '那如果...']), null, null, t);
        } else {
          const src2 = Math.random() < 0.5 ? 'knowledge' : 'ai';
          insertMsg.run('m' + convId + '_' + j, convId, 'assistant', pick(KB_ANSWERS) + '（演示数据）', 0.85, src2, t);
        }
        lastMsgAt = t;
      }

      // 更新会话的最后消息时间
      db.prepare('UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?')
        .run(lastMsgAt, lastMsgAt, convId);

      // 评价：30% 会话有评价
      if (Math.random() < 0.30) {
        const score = pick([5, 5, 5, 5, 4, 4, 4, 4, 3, 3, 2, 1]);
        const comment = Math.random() < 0.5 ? pick(RATING_COMMENTS[score]) : '';
        const rTime = new Date(new Date(lastMsgAt).getTime() + rnd(30, 300) * 1000).toISOString();
        insertRating.run('r' + convId, convId, score, comment, rTime);
        ratingCount++;
      }
    }

    // 未答问题：每天 2-5 条
    const uaToday = rnd(2, 5);
    for (let u = 0; u < uaToday; u++) {
      const query = pick(UNANSWERED_POOL);
      const status = pick(['pending', 'pending', 'added', 'dismissed']);
      const uTime = randTimeInDay(dateStr, 9, 21);
      insertUnanswered.run('ua_' + dateStr + '_' + u, query, rnd(1, 4), uTime, uTime, status,
        status === 'added' ? '已补充到知识库（演示）' : null, 'demo', uTime);
      uaCount++;
    }
  }

  db.close();
  console.log('✅ 演示数据生成完成！');
  console.log(`   会话: ${convCount} 条`);
  console.log(`   消息: ${convCount * 4} 条左右`);
  console.log(`   评价: ${ratingCount} 条`);
  console.log(`   未答: ${uaCount} 条`);
  console.log('   刷新管理后台 Dashboard 即可看到满屏数据');
}

// ============ 入口 ============
if (CLEAN_ONLY) {
  cleanAll();
  db.close();
  console.log('✅ 已清空，数据回到初始状态');
} else {
  generate();
}
