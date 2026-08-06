/**
 * 系统配置路由
 * 处理 AI 大模型配置（主流方式：单一主模型 + 可选备用，OpenAI 兼容 Base URL）
 */

const express = require('express');
const router = express.Router();
const aiService = require('../services/ai');
const { readAIConfig, saveAIConfig, readBrandConfig, saveBrandConfig, DEFAULT_BRAND, DEFAULT_CONFIG } = require('../utils/config');

const PLACEHOLDER_KEYS = ['your_deepseek_api_key_here', 'your_zhipu_api_key_here'];

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
      if (!key || PLACEHOLDER_KEYS.includes(key) || key.length < 8) return key || '';
      return key.slice(0, 4) + '****' + key.slice(-4);
    };
    res.json({
      success: true,
      data: {
        llm: {
          provider: config.llm.provider,
          baseUrl: config.llm.baseUrl,
          apiKey: config.llm.apiKey,
          apiKeyMasked: maskKey(config.llm.apiKey),
          model: config.llm.model,
          temperature: config.llm.temperature
        },
        fallback: {
          baseUrl: config.fallback.baseUrl,
          apiKey: config.fallback.apiKey,
          apiKeyMasked: maskKey(config.fallback.apiKey),
          model: config.fallback.model
        },
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

// 保存AI配置（统一保存主模型 + 备用模型）
router.post('/ai/save', async (req, res) => {
  try {
    const { llm, fallback, systemPrompt } = req.body || {};
    if (!llm || typeof llm !== 'object') {
      return res.status(400).json({ success: false, message: '缺少主模型配置' });
    }
    if (!llm.baseUrl || !llm.model) {
      return res.status(400).json({ success: false, message: 'Base URL 和 Model 不能为空' });
    }

    const config = await readAIConfig();
    const cleanKey = (k) => (k && !PLACEHOLDER_KEYS.includes(k)) ? k : '';

    // 主模型（API Key 留空 = 保留原值）
    config.llm = {
      provider: (llm.provider || config.llm.provider || 'custom').trim(),
      baseUrl: llm.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: llm.apiKey && llm.apiKey.trim() ? cleanKey(llm.apiKey) : config.llm.apiKey,
      model: llm.model.trim(),
      temperature: parseFloat(llm.temperature) || 0.7
    };
    // 备用模型（留空则保持原值；仅当填了 apiKey 或 model 时更新）
    if (fallback && typeof fallback === 'object') {
      const fbHas = fallback.baseUrl || fallback.apiKey || fallback.model;
      if (fbHas) {
        config.fallback = {
          baseUrl: (fallback.baseUrl || config.fallback.baseUrl).trim().replace(/\/+$/, ''),
          apiKey: fallback.apiKey && fallback.apiKey.trim() ? cleanKey(fallback.apiKey) : config.fallback.apiKey,
          model: (fallback.model || config.fallback.model).trim()
        };
      }
    }
    // 系统提示词
    if (systemPrompt && systemPrompt.trim().length >= 10) {
      config.systemPrompt = systemPrompt.trim();
    }

    await saveAIConfig(config);

    res.json({
      success: true,
      message: 'AI 配置保存成功',
      data: {
        llm: { provider: config.llm.provider, baseUrl: config.llm.baseUrl, model: config.llm.model, temperature: config.llm.temperature, hasKey: !!config.llm.apiKey },
        fallback: { baseUrl: config.fallback.baseUrl, model: config.fallback.model, hasKey: !!config.fallback.apiKey }
      }
    });
  } catch (error) {
    console.error('保存AI配置失败:', error);
    res.status(500).json({
      success: false,
      message: '保存配置失败'
    });
  }
});

// 测试AI连接（直接使用传入的配置测试，不依赖已保存状态）
router.post('/ai/test', async (req, res) => {
  try {
    const { baseUrl, apiKey, model } = req.body || {};
    if (!baseUrl || !apiKey || !model) {
      return res.json({ success: false, message: '请先填写 Base URL / API Key / Model 再测试' });
    }
    const result = await aiService.testConnection({ baseUrl, apiKey, model });
    res.json({ success: result.success, message: result.message });
  } catch (error) {
    console.error('[API] 测试AI配置失败:', error);
    res.json({
      success: false,
      message: '服务器内部错误: ' + (error.message || '未知错误'),
      error: error.message
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
