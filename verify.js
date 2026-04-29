// 验证模块加载是否正确
console.log('=== 模块加载验证 ===\n');

// 1. 验证 utils/config
try {
  const config = require('./server/utils/config');
  console.log('✅ utils/config 加载成功');
  console.log('  - readAIConfig:', typeof config.readAIConfig);
  console.log('  - saveAIConfig:', typeof config.saveAIConfig);
} catch (e) {
  console.log('❌ utils/config 加载失败:', e.message);
}

// 2. 验证 services/ai
try {
  const ai = require('./server/services/ai');
  console.log('\n✅ services/ai 加载成功');
  console.log('  - ai type:', typeof ai);
  console.log('  - testProvider:', typeof ai.testProvider);
  console.log('  - getConfigStatus:', typeof ai.getConfigStatus);
  console.log('  - generateAnswer:', typeof ai.generateAnswer);
} catch (e) {
  console.log('\n❌ services/ai 加载失败:', e.message);
}

// 3. 验证 routes/config
try {
  const routes = require('./server/routes/config');
  console.log('\n✅ routes/config 加载成功');
  console.log('  - router:', typeof routes.router);
} catch (e) {
  console.log('\n❌ routes/config 加载失败:', e.message);
}

console.log('\n=== 验证完成 ===');
