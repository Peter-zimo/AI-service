const test = require('node:test');
const assert = require('node:assert/strict');
const cases = require('../quality/eval-cases-v1.json');

test('quality gate has exactly 30 well-formed local retrieval cases', () => {
  assert.equal(cases.length, 30);
  for (const item of cases) {
    assert.match(item.id, /^qv1-\d{2}$/);
    assert.ok(item.query.trim());
    assert.ok(['knowledge', 'reject'].includes(item.expectedKind));
    assert.ok(Array.isArray(item.tags) && item.tags.length > 0);
    assert.equal(Boolean(item.expectedQuestion), item.expectedKind === 'knowledge');
  }
  assert.ok(cases.some(item => item.expectedKind === 'reject'));
});
