/**
 * JWT 认证中间件（企业级）
 *
 * 认证方式：Bearer Token（JWT）
 * 角色分权：admin / agent / readonly
 * 无额外依赖——纯 crypto 实现
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const AUTH_FILE = path.join(__dirname, '../config/auth.json');

// JWT 密钥（首次启动自动生成，持久化到 auth.json）
function getJwtSecret() {
  const config = loadAuthConfig();
  if (!config.jwtSecret) {
    config.jwtSecret = crypto.randomBytes(32).toString('hex');
    saveAuthConfig(config);
    console.log('[Auth] 已生成 JWT 密钥');
  }
  return config.jwtSecret;
}

function loadAuthConfig() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); }
  catch (_) { return { users: [], jwtSecret: '' }; }
}

function saveAuthConfig(config) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// ============ JWT 编解码（纯 crypto，零依赖）============

function base64url(str) {
  return Buffer.from(str).toString('base64url');
}

function base64urlDecode(str) {
  return Buffer.from(str, 'base64').toString('utf-8');
}

function sign(payload, secret, expiresInSec = 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };

  const encoded = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return encoded + '.' + signature;
}

function verify(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const encoded = parts[0] + '.' + parts[1];
    const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expectedSig))) {
      return null;
    }

    const payload = JSON.parse(base64urlDecode(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // 过期
    }
    return payload;
  } catch (_) {
    return null;
  }
}

// ============ JWT 中间件 ============

function jwtAuth(requiredRoles = []) {
  return async (req, res, next) => {
    if (req.path === '/health' || req.path === '/metrics') return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: '缺少认证令牌' });
    }

    const token = authHeader.split(' ')[1];
    const secret = getJwtSecret();
    const payload = verify(token, secret);

    if (!payload) {
      return res.status(401).json({ success: false, message: '令牌无效或已过期' });
    }

    // 角色校验
    if (requiredRoles.length > 0 && !requiredRoles.includes(payload.role)) {
      return res.status(403).json({ success: false, message: '权限不足' });
    }

    req.auth = { username: payload.sub, role: payload.role };
    next();
  };
}

// 别名：兼容旧代码中的 basicAuth 引用（admin 路由）
function basicAuth(req, res, next) {
  return jwtAuth(['admin', 'agent'])(req, res, next);
}

// ============ 登录接口 ============

async function login(req, res) {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }

  try {
    const config = loadAuthConfig();
    const user = config.users.find(u => u.username === username);

    if (!user) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }

    let match = false;
    if (user.password.startsWith('$2b$') || user.password.startsWith('$2a$')) {
      match = await bcrypt.compare(password, user.password);
    } else {
      match = (user.password === password);
      if (match) {
        user.password = await bcrypt.hash(password, 10);
        saveAuthConfig(config);
      }
    }

    if (!match) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }

    const secret = getJwtSecret();
    const accessToken = sign({ sub: username, role: user.role || 'agent' }, secret, 3600);
    const refreshToken = sign({ sub: username, type: 'refresh' }, secret, 86400 * 7);

    console.log(`[Auth] 用户 ${username} 登录成功, role: ${user.role || 'agent'}`);
    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        expiresIn: 3600,
        user: { username, role: user.role || 'agent' },
      }
    });
  } catch (e) {
    console.error('[Auth] 登录失败:', e);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
}

// ============ Token 刷新 ============

function refreshToken(req, res) {
  const { refreshToken: rt } = req.body || {};
  if (!rt) return res.status(400).json({ success: false, message: '缺少 refreshToken' });

  const secret = getJwtSecret();
  const payload = verify(rt, secret);

  if (!payload || payload.type !== 'refresh') {
    return res.status(401).json({ success: false, message: 'refreshToken 无效' });
  }

  const accessToken = sign({ sub: payload.sub, role: payload.role || 'agent' }, secret, 3600);
  res.json({ success: true, data: { accessToken, expiresIn: 3600 } });
}

// ============ 修改密码（保留）============

async function changePassword(req, res) {
  const { username, oldPassword, newPassword } = req.body || {};

  if (!username || !oldPassword || !newPassword) {
    return res.status(400).json({ success: false, message: '参数不完整' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, message: '新密码至少6位' });
  }

  try {
    const config = loadAuthConfig();
    const user = config.users.find(u => u.username === username);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    let oldMatch = false;
    if (user.password.startsWith('$2b$') || user.password.startsWith('$2a$')) {
      oldMatch = await bcrypt.compare(oldPassword, user.password);
    } else {
      oldMatch = (user.password === oldPassword);
    }
    if (!oldMatch) return res.status(401).json({ success: false, message: '旧密码错误' });

    user.password = await bcrypt.hash(newPassword, 10);
    saveAuthConfig(config);

    res.json({ success: true, message: '密码修改成功' });
  } catch (e) {
    console.error('[Auth] 修改密码失败:', e);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
}

module.exports = { jwtAuth, basicAuth, login, refreshToken, changePassword, getJwtSecret, sign, verify };
