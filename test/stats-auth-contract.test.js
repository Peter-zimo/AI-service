const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('statistics page uses the JWT login endpoint instead of Basic Auth', () => {
  const page = fs.readFileSync(path.join(__dirname, '../public/stats.html'), 'utf8');

  assert.match(page, /fetch\('\/api\/auth\/login'/);
  assert.doesNotMatch(page, /Authorization': 'Basic/);
});
