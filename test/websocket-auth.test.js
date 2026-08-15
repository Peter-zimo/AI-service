const test = require('node:test');
const assert = require('node:assert/strict');
const { sign, verifyWebSocketAgentToken, canManageAgent, isTokenPayloadCurrent } = require('../server/middleware/auth');

test('agent WebSocket token must match the requested agent id', () => {
  const token = sign({ sub: 'agent:agent_001', role: 'agent', agentId: 'agent_001' }, 'test-secret');
  assert.equal(verifyWebSocketAgentToken(token, 'agent_001', 'test-secret').agentId, 'agent_001');
  assert.equal(verifyWebSocketAgentToken(token, 'agent_002', 'test-secret'), null);
  assert.equal(verifyWebSocketAgentToken('', 'agent_001', 'test-secret'), null);
});

test('admin WebSocket token can connect to an existing agent channel', () => {
  const token = sign({ sub: 'admin', role: 'admin' }, 'test-secret');
  assert.equal(verifyWebSocketAgentToken(token, 'agent_001', 'test-secret').role, 'admin');
});

test('agent credentials are bound to one agent, while admins can manage any agent', () => {
  assert.equal(canManageAgent({ role: 'agent', agentId: 'agent_001' }, 'agent_001'), true);
  assert.equal(canManageAgent({ role: 'agent', agentId: 'agent_001' }, 'agent_002'), false);
  assert.equal(canManageAgent({ role: 'admin' }, 'agent_002'), true);
});

test('a token becomes invalid when the account token version changes', () => {
  assert.equal(isTokenPayloadCurrent({ sub: 'admin', tokenVersion: 1 }, [{ username: 'admin', tokenVersion: 1 }]), true);
  assert.equal(isTokenPayloadCurrent({ sub: 'admin', tokenVersion: 1 }, [{ username: 'admin', tokenVersion: 2 }]), false);
});
