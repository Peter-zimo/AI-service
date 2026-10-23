/**
 * 品牌配置路由（公开）
 *
 * 访客端加载品牌皮肤用，不含敏感信息。
 * 管理端的写入接口在 routes/config.js（需 admin）。
 */

'use strict';

const express = require('express');
const { readBrandConfig } = require('../utils/config');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const config = await readBrandConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, message: '获取品牌配置失败' });
  }
});

module.exports = router;
