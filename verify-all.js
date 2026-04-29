/**
 * 全量API自测脚本
 * 用法: node verify-all.js
 */
const http = require('http');

const BASE = 'http://localhost:3456';
const AUTH = 'admin:admin123';

function req(method, path, body = null, auth = AUTH) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(auth).toString('base64'),
        'Content-Type': 'application/json',
      }
    };
    const chunks = [];
    const req = http.request(options, (res) => {
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = chunks.join('').toString();
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data, raw: raw.slice(0, 300) });
      });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function check(name, condition, detail = '') {
  const icon = condition ? '✅' : '❌';
  const msg = condition ? '通过' : '失败';
  console.log(`  ${icon} ${name}: ${msg}${detail ? ' → ' + detail : ''}`);
  return condition;
}

async function run() {
  console.log('\n========== 第一轮：后端API自测 ==========\n');
  let passed = 0, failed = 0;

  // 1. 健康检查
  process.stdout.write('【基础】\n');
  const h = await req('GET', '/api/health');
  if (check('健康检查 /api/health', h.status === 200 && h.data?.status === 'ok', `HTTP ${h.status}`)) passed++; else failed++;

  // 2. 品牌配置（公开）
  const brand = await req('GET', '/api/config/brand');
  if (check('品牌配置 /api/config/brand（公开）', brand.status === 200 && brand.data?.success)) passed++; else failed++;

  // 3. 知识库（认证）
  process.stdout.write('\n【知识库】\n');
  const kb = await req('GET', '/api/knowledge');
  if (check('知识库列表 /api/knowledge', kb.status === 200 && kb.data?.success, `共${kb.data?.data?.length || 0}条`)) passed++; else failed++;

  const kbAdd = await req('POST', '/api/knowledge', { question: '测试问题', answer: '测试答案', keywords: ['测试'] });
  if (check('知识库添加 /api/knowledge[POST]', kbAdd.status === 200 && kbAdd.data?.success)) passed++; else failed++;

  // 4. 统计API
  process.stdout.write('\n【统计】\n');
  const ov = await req('GET', '/api/stats/overview');
  if (check('统计概览 /api/stats/overview', ov.status === 200 && ov.data?.success, `总对话${ov.data?.data?.totalConversations || 0}条`)) passed++; else failed++;

  const trend = await req('GET', '/api/stats/trend?days=7');
  if (check('趋势图 /api/stats/trend', trend.status === 200 && trend.data?.success, `返回${trend.data?.data?.length || 0}天`)) passed++; else failed++;

  const sat = await req('GET', '/api/stats/satisfaction');
  if (check('满意度 /api/stats/satisfaction', sat.status === 200 && sat.data?.success)) passed++; else failed++;

  const convs = await req('GET', '/api/stats/conversations?page=1&pageSize=5');
  if (check('对话列表 /api/stats/conversations', convs.status === 200 && convs.data?.success)) passed++; else failed++;

  const topQ = await req('GET', '/api/stats/top-questions');
  if (check('高频问题 /api/stats/top-questions', topQ.status === 200 && topQ.data?.success)) passed++; else failed++;

  const statsExport = await req('GET', '/api/stats/export/csv');
  if (check('统计导出 /api/stats/export/csv', statsExport.status === 200)) passed++; else failed++;

  // 5. 配置
  process.stdout.write('\n【配置】\n');
  const aiStatus = await req('GET', '/api/config/ai');
  if (check('AI状态 /api/config/ai', aiStatus.status === 200 && aiStatus.data?.success)) passed++; else failed++;

  const aiDetail = await req('GET', '/api/config/ai/detail');
  if (check('AI配置详情 /api/config/ai/detail', aiDetail.status === 200 && aiDetail.data?.success)) passed++; else failed++;

  const brandDetail = await req('GET', '/api/config/brand/detail');
  if (check('品牌详情 /api/config/brand/detail', brandDetail.status === 200 && brandDetail.data?.success)) passed++; else failed++;

  // 6. 敏感词
  process.stdout.write('\n【敏感词】\n');
  const sw = await req('GET', '/api/sensitive/words');
  if (check('敏感词列表 /api/sensitive/words', sw.status === 200 && sw.data?.success, `共${sw.data?.words?.length || 0}条`)) passed++; else failed++;

  const swDetect = await req('POST', '/api/sensitive/detect', { text: '测试内容' });
  if (check('敏感词检测 /api/sensitive/detect', swDetect.status === 200 && swDetect.data?.success)) passed++; else failed++;

  const swLogs = await req('GET', '/api/sensitive/logs');
  if (check('敏感词日志 /api/sensitive/logs', swLogs.status === 200 && swLogs.data?.success)) passed++; else failed++;

  // 7. 聊天（访客端，无认证）
  process.stdout.write('\n【聊天（访客端）】\n');
  const create = await req('POST', '/api/chat/create', { visitorId: 'test_user_001', visitorName: '测试用户' }, '');
  const cid = create.data?.conversationId;
  if (check('创建会话 /api/chat/create', create.status === 200 && !!cid, cid ? cid.slice(0, 8) + '...' : '失败')) passed++; else failed++;

  const send = await req('POST', '/api/chat/message', { conversationId: cid, message: '你好，你们的营业时间是几点' }, '');
  if (check('发送消息 /api/chat/message', send.status === 200 && send.data?.success)) passed++; else failed++;

  const hist = await req('GET', `/api/chat/history/${cid}`, null, '');
  if (check('对话历史 /api/chat/history/:id', hist.status === 200 && hist.data?.success)) passed++; else failed++;

  // 8. 对话管理（需认证）
  process.stdout.write('\n【对话管理】\n');
  const chatList = await req('GET', '/api/chat/list');
  if (check('对话列表 /api/chat/list', chatList.status === 200 && chatList.data?.success)) passed++; else failed++;

  const rate = await req('POST', '/api/chat/rate', { conversationId: cid, score: 5, comment: '测试评价' });
  if (check('评价对话 /api/chat/rate', rate.status === 200 && rate.data?.success)) passed++; else failed++;

  const close = await req('POST', '/api/chat/close', { conversationId: cid });
  if (check('关闭会话 /api/chat/close', close.status === 200 && close.data?.success)) passed++; else failed++;

  const convStats = await req('GET', '/api/chat/conversation-stats');
  if (check('会话统计 /api/chat/conversation-stats', convStats.status === 200 && convStats.data?.success)) passed++; else failed++;

  // 9. 人工客服
  process.stdout.write('\n【人工客服】\n');
  const agentList = await req('GET', '/api/human/agents');
  if (check('客服列表 /api/human/agents', agentList.status === 200 && agentList.data?.success)) passed++; else failed++;

  const queue = await req('GET', '/api/human/queue');
  if (check('排队队列 /api/human/queue', queue.status === 200 && queue.data?.success)) passed++; else failed++;

  // 10. 知识库搜索
  process.stdout.write('\n【知识库搜索】\n');
  const kbSearch = await req('GET', '/api/knowledge/search/query?q=营业时间');
  if (check('知识库搜索 /api/knowledge/search/query', kbSearch.status === 200 && kbSearch.data?.success)) passed++; else failed++;

  // 11. 知识库导出
  const kbExport = await req('GET', '/api/knowledge/export/json');
  if (check('知识库导出 /api/knowledge/export/json', kbExport.status === 200)) passed++; else failed++;

  // 12. 敏感词导出
  const swExport = await req('GET', '/api/sensitive/export/json');
  if (check('敏感词导出 /api/sensitive/export/json', swExport.status === 200)) passed++; else failed++;

  // 13. 对话导出
  const chatExport = await req('GET', '/api/chat/export/csv');
  if (check('对话导出 /api/chat/export/csv', chatExport.status === 200)) passed++; else failed++;

  // 14. 401认证检查
  process.stdout.write('\n【认证检查】\n');
  const noAuthKb = await req('GET', '/api/knowledge', null, '');
  if (check('未认证访问知识库 → 401', noAuthKb.status === 401)) passed++; else {
    check('未认证访问知识库 → 返回' + noAuthKb.status, noAuthKb.status === 200 || noAuthKb.status === 401, '注意：无认证也能访问');
    if (noAuthKb.status === 200) { console.log('  ⚠️  知识库接口缺少认证保护！'); failed++; } else failed++;
  }

  console.log(`\n========== 第一轮结果 ==========`);
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  console.log(`总计: ${passed + failed} 项\n`);

  if (failed > 0) {
    console.log('以下测试失败，请修复后重新运行脚本：');
    console.log('(重新运行: node verify-all.js)\n');
  } else {
    console.log('🎉 所有测试通过！\n');
  }
}

run();
