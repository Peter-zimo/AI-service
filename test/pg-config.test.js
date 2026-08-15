const test = require('node:test');
const assert = require('node:assert/strict');
const { getDatabasePassword } = require('../server/services/pg');

test('PostgreSQL requires an explicit password in production', () => {
  assert.throws(
    () => getDatabasePassword({ NODE_ENV: 'production' }),
    /DB_PASSWORD must be set/
  );
  assert.equal(getDatabasePassword({ NODE_ENV: 'production', DB_PASSWORD: 'secret' }), 'secret');
});
