const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const AUTH_FILE = path.join(__dirname, '..', 'server', 'config', 'auth.json');
const cfg = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));

async function main() {
  // 轮换 JWT 密钥
  cfg.jwtSecret = crypto.randomBytes(32).toString('hex');
  // 哈希所有明文密码（保留已知密码不变，仅存储形式改为 bcrypt）
  for (const u of cfg.users) {
    const pwd = u.password;
    if (!(pwd.startsWith('$2b$') || pwd.startsWith('$2a$'))) {
      u.password = await bcrypt.hash(pwd, 10);
      console.log(`[Auth] ${u.username}: 明文 -> bcrypt 哈希`);
    } else {
      console.log(`[Auth] ${u.username}: 已是哈希，保留`);
    }
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  console.log('[Auth] auth.json 已安全加固');
  console.log('NEW_JWT_SECRET=' + cfg.jwtSecret);
  console.log('NEW_SENSITIVE_LOG_KEY=' + crypto.randomBytes(32).toString('hex'));
}

main().catch(e => { console.error(e); process.exit(1); });
