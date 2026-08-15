const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('admin quality page uses review APIs and has no browser evaluation trigger', () => {
  const page = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
  assert.match(page, /id="nav-quality"/);
  assert.match(page, /const QUALITY_API = '\/api\/quality'/);
  assert.match(page, /QUALITY_API \+ '\/runs'/);
  assert.match(page, /QUALITY_API \+ '\/candidates'/);
  assert.doesNotMatch(page, /eval:quality|run-quality-eval/);
});
