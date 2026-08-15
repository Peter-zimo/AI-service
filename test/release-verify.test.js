/**
 * 发布前验证脚本测试
 * 核心契约：Python /api/health 必须暴露 embedding 字段。
 */
const test = require('node:test');
const assert = require('node:assert');

const { runVerifyRelease } = require('../scripts/verify-release');

test('release verification fails when Python health contract is absent', () => {
  const result = runVerifyRelease({ pythonHealth: { status: 'ok' } });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /embedding/);
});

test('release verification passes when Python health exposes embedding', () => {
  // 注入假 spawn，避免在测试中真实执行 npm test / pytest / docker
  const fakeSpawn = () => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });
  const result = runVerifyRelease({
    pythonHealth: { status: 'ok', embedding: { ready: true, dimension: 512 } },
    spawn: fakeSpawn,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
});
