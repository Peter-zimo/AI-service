/**
 * 知识库路由
 *
 * 只做「取参 → 调 service → 返回」。解析/导入/导出逻辑在 modules/knowledge，
 * 文件上传在 middleware/upload。
 */

'use strict';

const express = require('express');
const knowledgeService = require('../modules/knowledge');
const { upload } = require('../middleware/upload');
const { expandKnowledge } = require('../infra/clients/langchain');

const router = express.Router();

function guard(res, error, logLabel, clientMessage) {
  console.error(`${logLabel}:`, error);
  res.status(500).json({ success: false, error: clientMessage });
}

/** multer 错误统一转 400 */
function uploadError(res, err) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, error: '文件超过5MB大小限制' });
  }
  return res.status(400).json({ success: false, error: err.message || '文件上传失败' });
}

// ============ 增删改查 ============

router.get('/', async (req, res) => {
  try {
    const knowledge = await knowledgeService.getAll();
    res.json({ success: true, data: knowledge, total: knowledge.length });
  } catch (error) {
    guard(res, error, '获取知识库失败', '获取知识库失败');
  }
});

router.post('/', async (req, res) => {
  try {
    const { question, answer, keywords } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ success: false, error: '问题和答案不能为空' });
    }

    const item = await knowledgeService.addItem(question, answer, keywords);
    res.json({ success: true, message: '添加成功', data: item });
  } catch (error) {
    guard(res, error, '添加知识库失败', '添加知识库失败');
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { question, answer, keywords } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ success: false, error: '问题和答案不能为空' });
    }

    const item = await knowledgeService.updateItem(req.params.id, question, answer, keywords);
    if (!item) {
      return res.status(404).json({ success: false, error: '知识库条目不存在' });
    }

    res.json({ success: true, message: '更新成功', data: item });
  } catch (error) {
    guard(res, error, '更新知识库失败', '更新知识库失败');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await knowledgeService.deleteItem(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: '知识库条目不存在' });
    }
    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    guard(res, error, '删除知识库失败', '删除知识库失败');
  }
});

router.delete('/', async (req, res) => {
  try {
    res.json(await knowledgeService.clearAll());
  } catch (error) {
    guard(res, error, '清空知识库失败', '清空知识库失败');
  }
});

router.post('/reset', async (req, res) => {
  try {
    const result = await knowledgeService.resetToDefault();
    res.json({ success: true, message: '已重置为默认数据', ...result });
  } catch (error) {
    guard(res, error, '重置知识库失败', '重置知识库失败');
  }
});

// ============ AI 扩写 ============

router.post('/expand', async (req, res) => {
  const { question, answer } = req.body || {};
  if (!question || !answer) {
    return res.status(400).json({ success: false, error: '问题和答案不能为空' });
  }

  try {
    const result = await expandKnowledge(question, answer);
    res.status(result.success ? 200 : 502).json(result);
  } catch (error) {
    console.error('AI 扩写失败:', error);
    res.status(502).json({ success: false, error: 'AI 扩写服务暂不可用' });
  }
});

// ============ 导入：解析预览 ============

router.post('/import/parse', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return uploadError(res, err);
    if (!req.file) return res.status(400).json({ success: false, error: '请上传文件' });

    try {
      const rows = knowledgeService.parseImportFile(req.file.path, req.file.originalname);
      const result = await knowledgeService.buildImportPreview(rows);
      res.json({ success: true, ...result });
    } catch (error) {
      if (error.unsupported) {
        return res.status(400).json({ success: false, error: '仅支持 csv/json 格式' });
      }
      console.error('导入解析失败:', error);
      res.status(500).json({ success: false, error: '文件解析失败: ' + error.message });
    }
  });
});

// ============ 导入：确认写入 ============

router.post('/import/confirm', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: '没有可导入的数据' });
    }

    const result = await knowledgeService.batchAdd(items);
    res.json({
      success: true,
      imported: result.added,
      skipped: result.skipped,
      message: `成功导入 ${result.added} 条，跳过 ${result.skipped} 条重复`,
    });
  } catch (error) {
    console.error('导入确认失败:', error);
    res.status(500).json({ success: false, error: '导入失败: ' + error.message });
  }
});

// ============ 批量导入（文件或 items） ============

router.post('/batch', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return uploadError(res, err);

    try {
      const items = knowledgeService.collectBatchItems(
        (req.body || {}).items,
        req.file && req.file.path,
        req.file && req.file.originalname
      );

      if (items === null) {
        return res.status(400).json({ success: false, error: '请提供文件或items参数' });
      }
      if (items.length === 0) {
        return res.status(400).json({
          success: false,
          error: '文件中没有可导入的数据，请检查列名是否为「问题」和「答案」',
        });
      }

      const result = await knowledgeService.batchAdd(items);
      res.json({
        success: true,
        message: `成功添加 ${result.added} 条，跳过 ${result.skipped} 条（重复）`,
        data: result,
      });
    } catch (error) {
      console.error('批量导入失败:', error);
      res.status(500).json({ success: false, error: '批量导入失败: ' + error.message });
    }
  });
});

// ============ 导出 ============

router.get('/export/:format', async (req, res) => {
  try {
    const { format } = req.params;
    const knowledge = await knowledgeService.getAll();

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=knowledge.json');
      return res.json(knowledge);
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename=${knowledgeService.exportFilename('csv')}`);
      return res.send(knowledgeService.buildExportCsv(knowledge));
    }

    res.status(400).json({ success: false, error: '不支持的格式，请使用 json / csv' });
  } catch (error) {
    guard(res, error, '导出失败', '导出失败');
  }
});

// ============ 搜索 ============

router.get('/search/query', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, error: '缺少搜索关键词' });
    }

    const results = await knowledgeService.search(q);
    res.json({
      success: true,
      query: q,
      results,
      hybrid: true,
      note: '混合检索（FTS5 + 语义向量 + RRF）',
    });
  } catch (error) {
    guard(res, error, '搜索失败', '搜索失败');
  }
});

// ============ 单条查询（通配符路由必须最后） ============

router.get('/:id', async (req, res) => {
  try {
    const item = await knowledgeService.getById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, error: '知识库条目不存在' });
    }
    res.json({ success: true, data: item });
  } catch (error) {
    guard(res, error, '获取知识库失败', '获取知识库失败');
  }
});

module.exports = router;
