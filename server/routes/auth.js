/**
 * 认证路由：登录 / 刷新 / 修改密码
 */

const express = require('express');
const router = express.Router();
const { login, refreshToken, changePassword, jwtAuth } = require('../middleware/auth');

// 登录（无需认证）
router.post('/login', login);

// 刷新令牌（无需认证，用 refreshToken 本身鉴权）
router.post('/refresh', refreshToken);

// 修改密码（需要认证）
router.post('/change-password', jwtAuth(), changePassword);

// 获取当前用户信息
router.get('/me', jwtAuth(), (req, res) => {
  res.json({ success: true, data: { username: req.auth.username, role: req.auth.role } });
});

module.exports = router;
