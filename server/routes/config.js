/**
 * 系统配置路由
 * 处理AI大模型配置的保存和读取（支持智谱AI和DeepSeek双接口）
 */

const express = require('express');
const router = express.Router();
const aiService = require('../services/ai');
const { readAIConfig, saveAIConfig, readBrandConfig, saveBrandConfig, DEFAULT_BRAND } = require('../utils/config');

// 获取AI配置状态（公开接口，不返回API Key）
router.get('/ai', async (req, res) => {
  try {
    const status = aiService.getConfigStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('读取AI配置失败:', error);
    res.status(500).json({
      success: false,
      message: '读取配置失败'
    });
  }
});

// 获取完整配置（管理后台使用，API Key 脱敏显示）
router.get('/ai/detail', async (req, res) => {
  try {
    const config = await readAIConfig();
    // API Key 脱敏：只显示前4位和后4位
    const maskKey = (key) => {
      if (!key || key.length < 8) return key || '';
      return key.slice(0, 4) + '****' + key.slice(-4);
    };
    res.json({
      success: true,
      data: {
        zhipu: {
          enabled: config.zhipu.enabled,
          apiKey: config.zhipu.apiKey || '',
          apiKeyMasked: maskKey(config.zhipu.apiKey),
          model: config.zhipu.model
        },
        deepseek: {
          enabled: config.deepseek.enabled,
          apiKey: config.deepseek.apiKey || '',
          apiKeyMasked: maskKey(config.deepseek.apiKey),
          model: config.deepseek.model
        },
        defaultProvider: config.defaultProvider,
        systemPrompt: config.systemPrompt,
        updatedAt: config.updatedAt
      }
    });
  } catch (error) {
    console.error('读取AI配置详情失败:', error);
    res.status(500).json({
      success: false,
      message: '读取配置失败'
    });
  }
});

// 保存智谱AI配置
router.post('/ai/zhipu', async (req, res) => {
  try {
    const { apiKey, model = 'glm-4-flash', enabled = true } = req.body;
    
    if (!apiKey || apiKey.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: 'API Key格式不正确'
      });
    }

    const config = await readAIConfig();
    config.zhipu = {
      enabled,
      apiKey: apiKey.trim(),
      model: model.trim()
    };

    await saveAIConfig(config);

    res.json({
      success: true,
      message: '智谱AI配置保存成功',
      data: {
        enabled: config.zhipu.enabled,
        model: config.zhipu.model
      }
    });
  } catch (error) {
    console.error('保存智谱AI配置失败:', error);
    res.status(500).json({
      success: false,
      message: '保存配置失败'
    });
  }
});

// 保存DeepSeek配置
router.post('/ai/deepseek', async (req, res) => {
  try {
    const { apiKey, model = 'deepseek-chat', enabled = true } = req.body;
    
    if (!apiKey || apiKey.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: 'API Key格式不正确'
      });
    }

    const config = await readAIConfig();
    config.deepseek = {
      enabled,
      apiKey: apiKey.trim(),
      model: model.trim()
    };

    await saveAIConfig(config);

    res.json({
      success: true,
      message: 'DeepSeek配置保存成功',
      data: {
        enabled: config.deepseek.enabled,
        model: config.deepseek.model
      }
    });
  } catch (error) {
    console.error('保存DeepSeek配置失败:', error);
    res.status(500).json({
      success: false,
      message: '保存配置失败'
    });
  }
});

// 设置默认提供商
router.post('/ai/default-provider', async (req, res) => {
  try {
    const { provider } = req.body;
    
    if (!['zhipu', 'deepseek'].includes(provider)) {
      return res.status(400).json({
        success: false,
        message: '无效的提供商，请选择 zhipu 或 deepseek'
      });
    }

    const config = await readAIConfig();
    config.defaultProvider = provider;
    await saveAIConfig(config);

    res.json({
      success: true,
      message: `默认AI提供商已设置为 ${provider}`,
      data: { defaultProvider: provider }
    });
  } catch (error) {
    console.error('设置默认提供商失败:', error);
    res.status(500).json({
      success: false,
      message: '设置失败'
    });
  }
});

// 更新系统提示词
router.post('/ai/system-prompt', async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt || prompt.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: '系统提示词太短'
      });
    }

    const config = await readAIConfig();
    config.systemPrompt = prompt.trim();
    await saveAIConfig(config);

    res.json({
      success: true,
      message: '系统提示词已更新'
    });
  } catch (error) {
    console.error('更新系统提示词失败:', error);
    res.status(500).json({
      success: false,
      message: '更新失败'
    });
  }
});

// 测试AI配置
router.post('/ai/test', async (req, res) => {
  try {
    const { provider = 'zhipu' } = req.body;
    
    if (!['zhipu', 'deepseek'].includes(provider)) {
      return res.status(400).json({
        success: false,
        message: '无效的提供商'
      });
    }

    console.log(`[API] 收到测试${provider}的请求`);
    const result = await aiService.testProvider(provider);
    console.log(`[API] 测试${provider}结果:`, result);
    
    // 无论测试成功还是失败，都返回200状态码，通过success字段区分
    res.json({
      success: result.success,
      message: result.message,
      provider
    });
  } catch (error) {
    console.error('[API] 测试AI配置失败:', error);
    // 返回200状态码，但success为false，避免前端显示HTTP 500错误
    res.json({
      success: false,
      message: '服务器内部错误: ' + (error.message || '未知错误'),
      error: error.message
    });
  }
});

// 禁用指定AI
router.post('/ai/disable', async (req, res) => {
  try {
    const { provider } = req.body;
    
    if (!['zhipu', 'deepseek'].includes(provider)) {
      return res.status(400).json({
        success: false,
        message: '无效的提供商'
      });
    }

    const config = await readAIConfig();
    config[provider].enabled = false;
    await saveAIConfig(config);
    
    res.json({
      success: true,
      message: `${provider === 'zhipu' ? '智谱AI' : 'DeepSeek'}已禁用`
    });
  } catch (error) {
    console.error('禁用AI失败:', error);
    res.status(500).json({
      success: false,
      message: '操作失败'
    });
  }
});

module.exports = {
  router
};

// ========== 品牌配置路由 ==========

// 获取品牌配置（公开接口，访客端使用）
router.get('/brand', async (req, res) => {
  try {
    const config = await readBrandConfig();
    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    console.error('读取品牌配置失败:', error);
    res.status(500).json({
      success: false,
      message: '读取品牌配置失败'
    });
  }
});

// 获取完整品牌配置（管理后台使用）
router.get('/brand/detail', async (req, res) => {
  try {
    const config = await readBrandConfig();
    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    console.error('读取品牌配置详情失败:', error);
    res.status(500).json({
      success: false,
      message: '读取配置失败'
    });
  }
});

// 保存品牌配置
router.post('/brand/save', async (req, res) => {
  try {
    const configData = req.body;
    
    // 基本校验
    if (!configData.name || configData.name.trim().length < 1) {
      return res.status(400).json({
        success: false,
        message: '品牌名称不能为空'
      });
    }

    // 构建保存数据，确保字段类型正确
    const saveData = {
      name: (configData.name || '').trim(),
      logo: (configData.logo || '🤖').trim(),
      description: (configData.description || '').trim(),
      primaryColor: (configData.primaryColor || '#2563eb').trim(),
      headerGradientStart: (configData.headerGradientStart || '#2563eb').trim(),
      headerGradientEnd: (configData.headerGradientEnd || '#1d4ed8').trim(),
      botName: (configData.botName || '小智').trim(),
      welcomeMessage: configData.welcomeMessage || DEFAULT_BRAND.welcomeMessage,
      quickQuestions: Array.isArray(configData.quickQuestions) ? configData.quickQuestions : DEFAULT_BRAND.quickQuestions,
      statusText: configData.statusText || DEFAULT_BRAND.statusText,
      placeholder: (configData.placeholder || '输入您的问题...').trim(),
      footerHint: (configData.footerHint || 'Enter 发送 · Shift+Enter 换行').trim(),
      ratingTitle: (configData.ratingTitle || '本次服务评价').trim(),
      ratingSubtitle: (configData.ratingSubtitle || '您的反馈帮助我们持续改进').trim(),
      hotline: (configData.hotline || '').trim(),
      copyright: (configData.copyright || '').trim()
    };

    await saveBrandConfig(saveData);

    res.json({
      success: true,
      message: '品牌配置保存成功',
      data: saveData
    });
  } catch (error) {
    console.error('保存品牌配置失败:', error);
    res.status(500).json({
      success: false,
      message: '保存失败'
    });
  }
});

// 重置品牌配置为默认值
router.post('/brand/reset', async (req, res) => {
  try {
    const { DEFAULT_BRAND } = require('../utils/config');
    await saveBrandConfig({ ...DEFAULT_BRAND });
    res.json({
      success: true,
      message: '品牌配置已重置为默认值',
      data: { ...DEFAULT_BRAND }
    });
  } catch (error) {
    console.error('重置品牌配置失败:', error);
    res.status(500).json({
      success: false,
      message: '重置失败'
    });
  }
});
