/**
 * Basic Auth 中间件
 * 支持 HTTP Basic Authentication + bcrypt 密码哈希
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const AUTH_FILE = path.join(__dirname, '../config/auth.json');

/**
 * 读取 auth.json
 */
function loadAuthConfig() {
  return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
}

/**
 * 保存 auth.json
 */
function saveAuthConfig(config) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Base64 解码
 */
function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Basic Auth 中间件（异步版，支持 bcrypt）
 */
async function basicAuth(req, res, next) {
  // 跳过健康检查
  if (req.path === '/health') {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="AI Service"');
    return res.status(401).json({
      success: false,
      message: '需要登录认证'
    });
  }

  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = decodeBase64(base64Credentials);
    const colonIndex = credentials.indexOf(':');
    const username = credentials.substring(0, colonIndex);
    const password = credentials.substring(colonIndex + 1);

    const authConfig = loadAuthConfig();
    const user = authConfig.users.find(u => u.username === username);

    if (!user) {
      res.setHeader('WWW-Authenticate', 'Basic realm="AI Service"');
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }

    // 兼容：如果密码不是哈希（旧数据迁移），直接比对并自动升级
    let passwordMatch = false;
    if (user.password.startsWith('$2b$') || user.password.startsWith('$2a$')) {
      passwordMatch = await bcrypt.compare(password, user.password);
    } else {
      passwordMatch = (user.password === password);
      // 验证通过后自动升级为 bcrypt 哈希
      if (passwordMatch) {
        user.password = await bcrypt.hash(password, 10);
        saveAuthConfig(authConfig);
        console.log(`[Auth] 用户 ${username} 密码已自动升级为哈希存储`);
      }
    }

    if (!passwordMatch) {
      res.setHeader('WWW-Authenticate', 'Basic realm="AI Service"');
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }

    req.auth = { username: user.username, role: user.role };
    next();
  } catch (e) {
    console.error('[Auth] 认证处理错误:', e);
    res.status(401).json({ success: false, message: '认证失败' });
  }
}

/**
 * 生成 Basic Auth Header（仅内部使用）
 */
function generateAuthHeader(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

/**
 * 修改管理后台密码（需要旧密码验证）
 * POST /api/auth/change-password
 * Body: { username, oldPassword, newPassword }
 */
async function changePassword(req, res) {
  const { username, oldPassword, newPassword } = req.body;

  if (!username || !oldPassword || !newPassword) {
    return res.status(400).json({ success: false, message: '参数不完整' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, message: '新密码至少6位' });
  }

  try {
    const authConfig = loadAuthConfig();
    const user = authConfig.users.find(u => u.username === username);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }

    // 验证旧密码
    let oldMatch = false;
    if (user.password.startsWith('$2b$') || user.password.startsWith('$2a$')) {
      oldMatch = await bcrypt.compare(oldPassword, user.password);
    } else {
      oldMatch = (user.password === oldPassword);
    }
    if (!oldMatch) {
      return res.status(401).json({ success: false, message: '旧密码错误' });
    }

    // 哈希新密码并保存
    user.password = await bcrypt.hash(newPassword, 10);
    saveAuthConfig(authConfig);

    console.log(`[Auth] 用户 ${username} 修改了密码`);
    return res.json({ success: true, message: '密码修改成功' });
  } catch (e) {
    console.error('[Auth] 修改密码失败:', e);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
}

module.exports = {
  basicAuth,
  generateAuthHeader,
  changePassword
};
