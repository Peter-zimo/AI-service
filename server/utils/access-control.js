function isAdmin(auth) {
  return Boolean(auth && auth.role === 'admin');
}

function canAccessVisitorConversation(conversation, visitorId) {
  return Boolean(conversation && visitorId && conversation.visitor_id === visitorId);
}

function canAccessAgentConversation(auth, conversation) {
  return Boolean(conversation && (
    isAdmin(auth) || (auth && auth.role === 'agent' && auth.agentId === conversation.assigned_agent)
  ));
}

module.exports = { isAdmin, canAccessVisitorConversation, canAccessAgentConversation };
