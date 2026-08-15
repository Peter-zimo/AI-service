const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', 'ai-service-langchain', '.env'),
];

function ensureToken(file, token) {
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^AI_SERVICE_TOKEN\s*=\s*.+$/m.test(content)) return false;
  fs.appendFileSync(file, `${content && !content.endsWith('\n') ? '\n' : ''}AI_SERVICE_TOKEN=${token}\n`, 'utf8');
  return true;
}

const token = crypto.randomBytes(32).toString('base64url');
const changed = files.map(file => ensureToken(file, token));
console.log(changed.some(Boolean) ? '已为内部服务写入共享令牌。' : '内部服务令牌已存在，未修改。');
