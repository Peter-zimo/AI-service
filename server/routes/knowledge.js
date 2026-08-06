const express = require('express');
const router = express.Router();
const multer = require('multer');
const knowledgeService = require('../services/knowledge');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// 配置文件上传 — 安全加固
const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv', '.json']);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // 文件名只保留安全字符，防止路径遍历
    const safeName = Date.now() + '-' + Math.random().toString(36).slice(2, 8) +
      path.extname(file.originalname).toLowerCase();
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error(`不支持的文件类型 ${ext}，仅允许 xlsx/xls/csv/json`));
    }
    cb(null, true);
  }
});

// 获取所有知识库
router.get('/', (req, res) => {
  try {
    const knowledge = knowledgeService.getAll();
    res.json({
      success: true,
      data: knowledge,
      total: knowledge.length
    });
  } catch (error) {
    console.error('获取知识库失败:', error);
    res.status(500).json({ success: false, error: '获取知识库失败' });
  }
});

// 添加知识库
router.post('/', async (req, res) => {
  try {
    const { question, answer, keywords } = req.body;

    if (!question || !answer) {
      return res.status(400).json({
        success: false,
        error: '问题和答案不能为空'
      });
    }

    const item = knowledgeService.addItem(question, answer, keywords);

    res.json({
      success: true,
      message: '添加成功',
      data: item
    });
  } catch (error) {
    console.error('添加知识库失败:', error);
    res.status(500).json({ success: false, error: '添加知识库失败' });
  }
});

// 更新知识库
router.put('/:id', async (req, res) => {
  try {
    const { question, answer, keywords } = req.body;

    if (!question || !answer) {
      return res.status(400).json({
        success: false,
        error: '问题和答案不能为空'
      });
    }

    const item = knowledgeService.updateItem(req.params.id, question, answer, keywords);

    if (!item) {
      return res.status(404).json({ success: false, error: '知识库条目不存在' });
    }

    res.json({
      success: true,
      message: '更新成功',
      data: item
    });
  } catch (error) {
    console.error('更新知识库失败:', error);
    res.status(500).json({ success: false, error: '更新知识库失败' });
  }
});

// 删除知识库
router.delete('/:id', (req, res) => {
  try {
    const deleted = knowledgeService.deleteItem(req.params.id);

    if (!deleted) {
      return res.status(404).json({ success: false, error: '知识库条目不存在' });
    }

    res.json({
      success: true,
      message: '删除成功'
    });
  } catch (error) {
    console.error('删除知识库失败:', error);
    res.status(500).json({ success: false, error: '删除知识库失败' });
  }
});

// 清空知识库
router.delete('/', (req, res) => {
  try {
    const result = knowledgeService.clearAll();
    res.json(result);
  } catch (error) {
    console.error('清空知识库失败:', error);
    res.status(500).json({ success: false, error: '清空知识库失败' });
  }
});

// 重置为默认数据
router.post('/reset', (req, res) => {
  try {
    const result = knowledgeService.resetToDefault();
    res.json({
      success: true,
      message: '已重置为默认数据',
      ...result
    });
  } catch (error) {
    console.error('重置知识库失败:', error);
    res.status(500).json({ success: false, error: '重置知识库失败' });
  }
});

// ── 导入：第一步 解析预览（前端拖拽上传触发）──────────────────────────────
router.post('/import/parse', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: '文件超过5MB大小限制' });
      }
      return res.status(400).json({ success: false, error: err.message || '文件上传失败' });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: '请上传文件' });
      }
      const ext = path.extname(req.file.originalname).toLowerCase();
      let rows = [];

      if (ext === '.xlsx' || ext === '.xls') {
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      } else if (ext === '.csv') {
        const workbook = XLSX.readFile(req.file.path, { type: 'file', raw: false });
        const sheetName = workbook.SheetNames[0];
        rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      } else {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(400).json({ success: false, error: '仅支持 xlsx/xls/csv 格式' });
      }

      // 用完删除临时文件
      try { fs.unlinkSync(req.file.path); } catch (e) { console.error('[导入] 临时文件清理失败:', e.message); }

      const existing = knowledgeService.getAll();
      const existingQuestions = new Set(existing.map(item => item.question.trim()));

      const preview = [];
      const errors = [];

      rows.forEach((row, idx) => {
        const question = (row['问题'] || row['question'] || '').toString().trim();
        const answer   = (row['答案'] || row['answer']   || '').toString().trim();
        const keywords = (row['关键词'] || row['keywords'] || '').toString().trim()
                         .split(/[,，]/).map(k => k.trim()).filter(Boolean);

        if (!question || !answer) {
          errors.push({ row: idx + 2, reason: '问题或答案为空' });
          return;
        }
        preview.push({
          question,
          answer,
          keywords,
          isDuplicate: existingQuestions.has(question)
        });
      });

      const newCount  = preview.filter(i => !i.isDuplicate).length;
      const dupCount  = preview.filter(i =>  i.isDuplicate).length;

      res.json({
        success: true,
        preview,
        summary: { new: newCount, duplicates: dupCount, errors: errors.length },
        errors
      });
    } catch (error) {
      console.error('导入解析失败:', error);
      res.status(500).json({ success: false, error: '文件解析失败: ' + error.message });
    }
  });
});

// ── 导入：第二步 确认写入 ─────────────────────────────────────────────────
router.post('/import/confirm', (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: '没有可导入的数据' });
    }
    const result = knowledgeService.batchAdd(items);
    res.json({
      success: true,
      imported: result.added,
      skipped: result.skipped,
      message: `成功导入 ${result.added} 条，跳过 ${result.skipped} 条重复`
    });
  } catch (error) {
    console.error('导入确认失败:', error);
    res.status(500).json({ success: false, error: '导入失败: ' + error.message });
  }
});

// 批量导入知识库（支持 xlsx / csv / json 三种格式）
router.post('/batch', (req, res) => {
  // 使用显式调用捕获 multer 错误（文件类型/大小超限）
  upload.single('file')(req, res, async (err) => {
    if (err) {
      // multer 限制错误
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: '文件超过5MB大小限制' });
      }
      return res.status(400).json({ success: false, error: err.message || '文件上传失败' });
    }

  try {
    let items = [];

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();

      if (ext === '.xlsx' || ext === '.xls') {
        // ---- Excel 解析 ----
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        // 字段名兼容：问题/question、答案/answer、关键词/keywords
        for (const row of rows) {
          const question = (row['问题'] || row['question'] || '').toString().trim();
          const answer   = (row['答案'] || row['answer']   || '').toString().trim();
          const keywords = (row['关键词'] || row['keywords'] || '').toString().trim();
          if (question && answer) {
            items.push({ question, answer, keywords });
          }
        }

      } else if (ext === '.csv') {
        // ---- CSV 解析（用 xlsx 库，兼容 UTF-8/GBK） ----
        const workbook = XLSX.readFile(req.file.path, { type: 'file', raw: false });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        for (const row of rows) {
          const question = (row['问题'] || row['question'] || '').toString().trim();
          const answer   = (row['答案'] || row['answer']   || '').toString().trim();
          const keywords = (row['关键词'] || row['keywords'] || '').toString().trim();
          if (question && answer) {
            items.push({ question, answer, keywords });
          }
        }

      } else {
        // ---- JSON 解析（原有逻辑）----
        const content = fs.readFileSync(req.file.path, 'utf-8');
        const parsed = JSON.parse(content);
        items = Array.isArray(parsed) ? parsed : (parsed.knowledge || []);
      }

      // 用完删除临时文件
      try { fs.unlinkSync(req.file.path); } catch (err) { console.error('[知识库] 临时文件清理失败:', err.message); }

    } else if (req.body.items) {
      // 从请求体导入
      if (typeof req.body.items === 'string') {
        items = JSON.parse(req.body.items);
      } else {
        items = req.body.items;
      }
    } else {
      return res.status(400).json({
        success: false,
        error: '请提供文件或items参数'
      });
    }

    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        error: '文件中没有可导入的数据，请检查列名是否为「问题」和「答案」'
      });
    }

    const result = knowledgeService.batchAdd(items);

    res.json({
      success: true,
      message: `成功添加 ${result.added} 条，跳过 ${result.skipped} 条（重复）`,
      data: result
    });
  } catch (error) {
    console.error('批量导入失败:', error);
    res.status(500).json({ success: false, error: '批量导入失败: ' + error.message });
  }
  }); // end multer callback
});

// 导出知识库（支持 JSON / XLSX / CSV）
router.get('/export/:format', (req, res) => {
  try {
    const knowledge = knowledgeService.getAll();
    const { format } = req.params;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=knowledge.json');
      return res.json(knowledge);
    }

    const rows = knowledge.map(item => ({
      '问题': item.question,
      '答案': item.answer,
      '关键词': (item.keywords || []).join(','),
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 40 }, { wch: 80 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '知识库');
    const now = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=knowledge_${now}.xlsx`);
      return res.end(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=knowledge_${now}.csv`);
      return res.send('\uFEFF' + XLSX.utils.sheet_to_csv(ws));
    }

    res.status(400).json({ success: false, error: '不支持的格式，请使用 json / xlsx / csv' });
  } catch (error) {
    console.error('导出失败:', error);
    res.status(500).json({ success: false, error: '导出失败' });
  }
});

// 搜索知识库（混合检索：FTS5 + 语义向量 + RRF 融合）
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
      note: '混合检索（FTS5 + 语义向量 + RRF）'
    });
  } catch (error) {
    console.error('搜索失败:', error);
    res.status(500).json({ success: false, error: '搜索失败' });
  }
});

// 获取单个知识库（通配符路由必须放在所有精确路由之后）
router.get('/:id', (req, res) => {
  try {
    const item = knowledgeService.getById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, error: '知识库条目不存在' });
    }
    res.json({ success: true, data: item });
  } catch (error) {
    console.error('获取知识库失败:', error);
    res.status(500).json({ success: false, error: '获取知识库失败' });
  }
});

// 文件上传目录清理
function cleanupUploads() {
  const uploadDir = path.join(__dirname, '../../uploads');
  if (fs.existsSync(uploadDir)) {
    const files = fs.readdirSync(uploadDir);
    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stat = fs.statSync(filePath);
      // 删除1小时前的文件
      if (Date.now() - stat.mtimeMs > 3600000) {
        fs.unlinkSync(filePath);
      }
    }
  }
}
cleanupUploads();

module.exports = router;
