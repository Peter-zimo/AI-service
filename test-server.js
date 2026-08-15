/**
 * 服务器接口测试脚本
 * 测试AI配置测试接口
 */

const http = require('http');

function makeRequest(path, method, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3456,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function main() {
  console.log('=== 服务器接口测试 ===\n');

  // 测试健康检查
  try {
    const health = await makeRequest('/api/health', 'GET');
    console.log('健康检查:', health.status === 200 ? '✅ 正常' : '❌ 失败');
    console.log('  响应:', JSON.stringify(health.data));
  } catch (error) {
    console.log('健康检查: ❌ 失败 -', error.message);
    console.log('\n请先启动服务器: node server/index.js');
    process.exit(1);
  }

  console.log();

  // 测试AI配置详情
  try {
    const detail = await makeRequest('/api/config/ai/detail', 'GET');
    console.log('AI配置详情:', detail.status === 200 ? '✅ 正常' : '❌ 失败');
    console.log('  响应:', JSON.stringify(detail.data, null, 2));
  } catch (error) {
    console.log('AI配置详情: ❌ 失败 -', error.message);
  }

  console.log();

  // 测试智谱AI连接
  try {
    console.log('测试智谱AI连接...');
    const zhipu = await makeRequest('/api/config/ai/test', 'POST', { provider: 'zhipu' });
    console.log('  状态码:', zhipu.status);
    console.log('  响应:', JSON.stringify(zhipu.data, null, 2));
  } catch (error) {
    console.log('智谱AI测试: ❌ 失败 -', error.message);
  }

  console.log();

  // 测试DeepSeek连接
  try {
    console.log('测试DeepSeek连接...');
    const deepseek = await makeRequest('/api/config/ai/test', 'POST', { provider: 'deepseek' });
    console.log('  状态码:', deepseek.status);
    console.log('  响应:', JSON.stringify(deepseek.data, null, 2));
  } catch (error) {
    console.log('DeepSeek测试: ❌ 失败 -', error.message);
  }
}

main();
