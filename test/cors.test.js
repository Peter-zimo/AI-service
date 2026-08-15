const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedOrigin } = require('../server/utils/cors');

test('production accepts the explicitly configured localhost origin', () => {
  assert.equal(
    isAllowedOrigin('http://localhost:3456', 'production', 'http://localhost:3456'),
    true
  );
  assert.equal(
    isAllowedOrigin('http://evil.example', 'production', 'http://localhost:3456'),
    false
  );
});
