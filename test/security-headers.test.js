const test = require('node:test');
const assert = require('node:assert/strict');
const { helmetOptions } = require('../server/utils/security-headers');

test('security headers restrict framing and third-party script sources', () => {
  assert.deepEqual(helmetOptions.frameguard, { action: 'sameorigin' });
  assert.equal(helmetOptions.contentSecurityPolicy.directives.objectSrc[0], "'none'");
  assert.deepEqual(helmetOptions.contentSecurityPolicy.directives.scriptSrc, [
    "'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'
  ]);
  assert.deepEqual(helmetOptions.contentSecurityPolicy.directives.scriptSrcAttr, ["'unsafe-inline'"]);
});
