const test = require('node:test');
const assert = require('node:assert/strict');

const { canAccessVisitorConversation, canAccessAgentConversation, isAdmin } = require('../server/utils/access-control');

test('visitor access is limited to the owning conversation', () => {
  const conversation = { visitor_id: 'v_1234567890_abcd' };
  assert.equal(canAccessVisitorConversation(conversation, 'v_1234567890_abcd'), true);
  assert.equal(canAccessVisitorConversation(conversation, 'v_1234567890_other'), false);
});

test('agents can only read their assigned conversation while admins can read it', () => {
  const conversation = { assigned_agent: 'agent_001' };
  assert.equal(canAccessAgentConversation({ role: 'agent', agentId: 'agent_001' }, conversation), true);
  assert.equal(canAccessAgentConversation({ role: 'agent', agentId: 'agent_002' }, conversation), false);
  assert.equal(canAccessAgentConversation({ role: 'admin' }, conversation), true);
  assert.equal(isAdmin({ role: 'admin' }), true);
  assert.equal(isAdmin({ role: 'agent' }), false);
});
