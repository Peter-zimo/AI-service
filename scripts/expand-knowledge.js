/**
 * 知识库扩充脚本：25 → 55 条（共享单车主题）
 *
 * - 以 DB 为准（service_init.db 的 knowledge 表，现有 25 条运行时数据）
 * - 新增 30 条常见问题（避开现有主题），INSERT 进 DB
 * - 同步重写 knowledge.json（合并后全量），根治 DB/JSON 不同步
 * - 幂等：已存在的 question 跳过，可安全重复运行
 *
 * 用法：node scripts/expand-knowledge.js
 * 注意：执行前先停止服务（避免 SQLite WAL 锁）
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(ROOT, 'server', 'data', 'service_init.db');
const JSON_PATH = path.join(ROOT, 'server', 'data', 'knowledge.json');

// ===== 新增 30 条（共享单车主题，避开现有 25 条）=====
// 注意：keywords 必须是 JSON 数组字符串（loadKnowledge 会 JSON.parse）
const NEW_ITEMS = [
  { question: '骑行会员如何开通？', answer: '打开APP进入"我的-会员中心"，选择会员类型（月卡/季卡/年卡）并支付即可开通。开通后立即生效，可享受每日免费骑行次数和专属优惠券。', keywords: ['会员', '开通', '购买'] },
  { question: '会员月卡和年卡有什么区别？', answer: '月卡和年卡的核心权益相同（每日免费骑行次数+专属优惠券），主要区别在有效期和价格：月卡按月付费灵活，年卡一次性付费性价比更高（相当于月卡8折）。可在APP"我的-会员中心"查看对比。', keywords: ['会员', '月卡', '年卡', '区别'] },
  { question: '骑行卡可以退吗？', answer: '骑行卡（会员卡）购买后默认不支持退款。如因特殊原因（如长期不使用）需要退卡，请联系在线客服申请，客服将根据实际情况处理。', keywords: ['骑行卡', '退', '退款'] },
  { question: '怎么查看会员权益？', answer: '打开APP"我的-会员中心"，即可查看您的会员等级、剩余免费骑行次数、专属优惠券和会员权益说明。', keywords: ['会员', '权益', '查看'] },
  { question: '开锁失败怎么办？', answer: '开锁失败请先检查：1.手机蓝牙是否开启；2.车辆是否被他人占用；3.网络是否正常。如仍失败，请点击"故障上报"或联系客服，我们会尽快处理并补偿。', keywords: ['开锁', '失败'] },
  { question: '蓝牙开锁连不上怎么办？', answer: '蓝牙开锁失败时：1.确认手机蓝牙已打开并靠近车辆（1米内）；2.尝试关闭蓝牙重新打开；3.在APP中开启"扫码用车"用扫码方式开锁。仍不行请上报故障。', keywords: ['蓝牙', '开锁', '连不上'] },
  { question: '骑行中途车锁了怎么开？', answer: '骑行中车辆意外落锁，请在APP订单页点击"继续骑行"解锁；如解锁失败，可能是车辆故障，请点击"故障上报"，本次骑行将免收费用。', keywords: ['中途', '锁', '解锁'] },
  { question: '临时停车超时怎么收费？', answer: '临时停车（临时锁车）前30分钟免费，超过后按骑行计费标准收取"临时停车费"。建议长时间停留时先还车再重新开锁，可避免额外费用。', keywords: ['临时停车', '超时', '收费'] },
  { question: '还车地点有什么要求？', answer: '请在APP地图标注的停车点（P点）内还车。非停车点还车会被收取调度费，且可能影响其他用户用车。', keywords: ['还车', '地点', '停车点'] },
  { question: '停车点已满怎么办？', answer: '停车点已满时，请在APP地图上寻找附近的空闲停车点。若附近无空位，可将车辆停在停车点边缘并拍照留证，点击"还车"时选择"停车点已满"选项，可免调度费。', keywords: ['停车点', '满', '还车'] },
  { question: '可以在小区门口还车吗？', answer: '小区门口若不在APP标注的停车点（P点）内，还车会被收取调度费。建议在最近的P点还车；如有疑问可联系客服咨询。', keywords: ['小区', '还车', '调度费'] },
  { question: '骑行费用怎么计算？', answer: '骑行费用按"基础费用+时长费用"计算：起步价1.5元（含15分钟），超出部分每15分钟1元；夜间骑行（23:00-06:00）有额外费用。具体以APP订单明细为准。', keywords: ['费用', '计算', '计费'] },
  { question: '为什么扣了两次费用？', answer: '如订单被重复扣费，请检查：1.是否为"骑行费+调度费"两笔明细；2.是否为上笔订单未支付成功被补扣。如确认异常，请提供订单号联系客服，我们核实后原路退回。', keywords: ['扣费', '重复', '费用'] },
  { question: '骑行记录里的时长不准怎么办？', answer: '骑行时长以车辆实际开关锁时间为准。若您认为记录不准确，请保留骑行时间段截图，联系在线客服提供订单号，客服将核实调整。', keywords: ['记录', '时长', '不准'] },
  { question: '押金怎么交？怎么退？', answer: '首次注册时可通过APP"我的-押金管理"缴纳押金（支持微信/支付宝）；申请退款后押金将在1-7个工作日内原路退回。信用分达标的用户可申请免押金骑行。', keywords: ['押金', '交', '退'] },
  { question: '押金退款多久到账？', answer: '押金退款申请提交后，一般在1-3个工作日内原路退回（微信/支付宝），高峰期最长不超过7个工作日。可在"押金管理"中查看退款进度。', keywords: ['押金', '退款', '到账'] },
  { question: '账号怎么换绑手机号？', answer: '在APP"我的-设置-账号与安全"中选择"更换手机号"，通过原手机号验证后即可绑定新号码。如原手机号无法接收验证码，请联系客服人工处理。', keywords: ['换绑', '手机号', '账号'] },
  { question: '手机号注销后账号还能用吗？', answer: '手机号注销（运营商销号）后，您的账号仍可正常使用，但无法接收短信验证码。建议及时在APP中更换绑定的手机号，避免影响找回密码等操作。', keywords: ['注销', '手机号', '账号'] },
  { question: '骑行摔倒受伤了怎么办？', answer: '骑行中如发生意外受伤，请第一时间拨打120就医，并通过APP"故障上报"或客服热线报备事故。我们已为车辆投保，将协助您申请保险理赔。', keywords: ['摔倒', '受伤', '事故', '保险'] },
  { question: '车上东西忘拿了怎么办？', answer: '物品遗落在车篮/车锁处：请立即回到原还车点寻找；如车辆已被骑走，请尽快联系客服提供车辆编号和遗忘时间，客服将协助联系下一位用车用户。', keywords: ['遗忘', '东西', '物品'] },
  { question: '头盔怎么租借？', answer: '部分车型自带头盔，可在开锁后从车篮取出佩戴。如需单独租借头盔，可在APP"骑行装备"中选择头盔租借服务（部分城市试点）。', keywords: ['头盔', '租借'] },
  { question: '可以带人骑行吗？', answer: '为安全考虑，每辆车限1人骑行，严禁载人（包括儿童）。载人骑行若被发现将收取违规费用并可能影响信用分。', keywords: ['载人', '带人', '安全'] },
  { question: '未成年可以骑行吗？', answer: '根据相关规定，未满16周岁禁止骑行共享电动车；未满12周岁禁止骑行共享自行车。注册时需如实填写年龄信息。', keywords: ['未成年', '年龄', '骑行'] },
  { question: '骑行优惠券怎么使用？', answer: '优惠券在支付时自动使用（满足使用条件即可抵扣）。可在APP"我的-优惠券"查看券的适用范围和有效期，点击券面可查看使用规则。', keywords: ['优惠券', '使用'] },
  { question: '优惠券可以叠加吗？', answer: '同一笔订单仅可使用一张优惠券，不可叠加。但"会员免费骑行权益"可与优惠券组合使用，具体以支付页面显示为准。', keywords: ['优惠券', '叠加'] },
  { question: '怎么参加骑行活动？', answer: '骑行活动会在APP首页"活动中心"展示，可查看活动规则、奖励和报名方式。参与活动可赢取骑行券、会员天数等奖励。', keywords: ['活动', '参加', '奖励'] },
  { question: '车辆质量问题怎么投诉？', answer: '如遇车辆质量问题（刹车失灵、车身损坏等），请立即停止骑行并点击"故障上报"，选择具体问题类型。我们将在24小时内核实处理，并为您补偿优惠券。', keywords: ['投诉', '质量', '故障'] },
  { question: '客服电话是多少？', answer: '官方客服热线：400-000-0000（服务时间 08:00-22:00）。您也可以在APP中通过"在线客服"直接对话，人工客服响应更快。', keywords: ['客服电话', '热线'] },
  { question: '客服工作时间是几点？', answer: '在线客服工作时间为每天 08:00-22:00；夜间可通过"留言"功能反馈，客服将在次日第一时间处理。紧急情况（如事故）请拨打 400-000-0000。', keywords: ['客服', '时间', '工作时间'] },
  { question: '如何开具骑行发票？', answer: '在APP"我的-发票管理"中选择需要开票的订单，填写抬头信息即可申请电子发票，一般1-3个工作日内发送至邮箱。', keywords: ['发票', '开票'] },
];

// 重置默认数据（knowledge.js 内置，需清理以免混入共享单车库）
const DEFAULT_QUESTIONS = ['营业时间', '如何联系客服', '退款政策', '会员积分', '优惠活动', '单车坏了怎么办'];

// ===== 执行 =====
const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');

// 清理：删除本次新增的同名旧数据（幂等）+ 默认重置数据
const delByQuestion = db.prepare('DELETE FROM knowledge WHERE question = ?');
let cleaned = 0;
for (const item of NEW_ITEMS) { cleaned += delByQuestion.run(item.question).changes; }
for (const q of DEFAULT_QUESTIONS) { cleaned += delByQuestion.run(q).changes; }
if (cleaned > 0) console.log(`已清理旧/默认数据: ${cleaned} 条`);

// 现有 question 集合（DB 为准）
const existing = new Set(
  db.prepare('SELECT question FROM knowledge').all().map(r => r.question)
);
console.log(`DB 现有知识库: ${existing.size} 条`);

// 幂等：跳过已存在的
const toInsert = NEW_ITEMS.filter(i => !existing.has(i.question));
console.log(`待新增: ${toInsert.length} 条（已存在跳过 ${NEW_ITEMS.length - toInsert.length} 条）`);

const now = new Date().toISOString();
const insert = db.prepare(
  'INSERT INTO knowledge (id, question, answer, keywords, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)'
);
const ts = Date.now();
let inserted = 0;
db.transaction(() => {
  toInsert.forEach((item, i) => {
    insert.run(`k${ts}_${i + 1}`, item.question, item.answer, JSON.stringify(item.keywords), now, now);
    inserted++;
  });
})();

// 同步重写 knowledge.json（DB 为准，全量；格式须匹配 loadKnowledge: {knowledge: [...]}）
const allRows = db.prepare('SELECT id, question, answer, keywords, created_at, updated_at FROM knowledge ORDER BY created_at').all();
const jsonItems = allRows.map(r => ({
  id: r.id,
  question: r.question,
  answer: r.answer,
  keywords: JSON.parse(r.keywords || '[]'),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
}));
fs.writeFileSync(JSON_PATH, JSON.stringify({ version: 2, knowledge: jsonItems }, null, 2), 'utf-8');

console.log(`已插入: ${inserted} 条 → 知识库共 ${allRows.length} 条`);
console.log(`knowledge.json 已同步（${jsonItems.length} 条）`);
db.close();
