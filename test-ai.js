/**
 * AI连接测试脚本
 * 用于验证智谱AI和DeepSeek的连接是否正常
 */

const axios = require('axios');
const { readAIConfig } = require('./server/utils/config');

async function testZhipuAI(apiKey, model) {
  console.log(`[测试] 智谱AI - 模型: ${model}`);
  const response = await axios.post(
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    {
      model: model,
      messages: [
        { role: 'system', content: '你是一个测试助手' },
        { role: 'user', content: '你好，请回复"测试成功"' }
      ],
      temperature: 0.7,
      max_tokens: 100
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 15000
    }
  );

  if (response.data && response.data.choices && response.data.choices[0]) {
    return response.data.choices[0].message.content;
  }
  throw new Error('返回格式异常');
}

async function testDeepSeek(apiKey, model) {
  console.log(`[测试] DeepSeek - 模型: ${model}`);
  const response = await axios.post(
    'https://api.deepseek.com/v1/chat/completions',
    {
      model: model,
      messages: [
        { role: 'system', content: '你是一个测试助手' },
        { role: 'user', content: '你好，请回复"测试成功"' }
      ],
      temperature: 0.7,
      max_tokens: 100
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 15000
    }
  );

  if (response.data && response.data.choices && response.data.choices[0]) {
    return response.data.choices[0].message.content;
  }
  throw new Error('返回格式异常');
}

async function main() {
  console.log('=== AI连接测试 ===\n');
  
  try {
    const config = await readAIConfig();
    console.log('配置读取成功:');
    console.log(`  智谱AI: enabled=${config.zhipu.enabled}, hasKey=${!!config.zhipu.apiKey}, model=${config.zhipu.model}`);
    console.log(`  DeepSeek: enabled=${config.deepseek.enabled}, hasKey=${!!config.deepseek.apiKey}, model=${config.deepseek.model}`);
    console.log();

    // 测试智谱AI
    if (config.zhipu.enabled && config.zhipu.apiKey) {
      try {
        const result = await testZhipuAI(config.zhipu.apiKey, config.zhipu.model);
        console.log('✅ 智谱AI测试成功!');
        console.log(`   响应: ${result.trim()}\n`);
      } catch (error) {
        console.log('❌ 智谱AI测试失败:');
        console.log(`   错误: ${error.message}`);
        if (error.response) {
          console.log(`   状态码: ${error.response.status}`);
          console.log(`   详情: ${JSON.stringify(error.response.data)}`);
        }
        console.log();
      }
    } else {
      console.log('⏭️ 智谱AI未启用或API Key未配置\n');
    }

    // 测试DeepSeek
    if (config.deepseek.enabled && config.deepseek.apiKey) {
      try {
        const result = await testDeepSeek(config.deepseek.apiKey, config.deepseek.model);
        console.log('✅ DeepSeek测试成功!');
        console.log(`   响应: ${result.trim()}\n`);
      } catch (error) {
        console.log('❌ DeepSeek测试失败:');
        console.log(`   错误: ${error.message}`);
        if (error.response) {
          console.log(`   状态码: ${error.response.status}`);
          console.log(`   详情: ${JSON.stringify(error.response.data)}`);
        }
        console.log();
      }
    } else {
      console.log('⏭️ DeepSeek未启用或API Key未配置\n');
    }

  } catch (error) {
    console.error('测试失败:', error.message);
    process.exit(1);
  }
}

main();
