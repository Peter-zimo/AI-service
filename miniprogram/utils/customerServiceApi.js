/**
 * AI客服系统 API 封装
 * 使用方式：将 BASE_URL 替换为你的内网穿透/服务器地址
 */

// ⚠️ 替换为你的实际地址（内网穿透 or 云服务器）
const BASE_URL = 'https://solely-saturn-true-qualified.trycloudflare.com';

/**
 * 统一请求封装
 */
function request(path, method = 'GET', data = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}/api${path}`,
      method,
      data,
      header: {
        'Content-Type': 'application/json'
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      },
      fail(err) {
        reject(new Error(err.errMsg || '网络请求失败'));
      }
    });
  });
}

/**
 * 创建新对话
 * @param {string} visitorId - 用户唯一ID（可用 openid 或 wx.getStorageSync('uid')）
 * @param {string} visitorName - 用户昵称
 */
function createConversation(visitorId, visitorName = '访客') {
  return request('/chat/create', 'POST', { visitorId, visitorName });
}

/**
 * 发送消息
 * @param {string} conversationId - 对话ID
 * @param {string} message - 用户消息
 * @param {string} visitorId - 用户ID
 */
function sendMessage(conversationId, message, visitorId) {
  return request('/chat/message', 'POST', { conversationId, message, visitorId });
}

/**
 * 获取对话历史
 * @param {string} conversationId - 对话ID
 */
function getHistory(conversationId) {
  return request(`/chat/history/${conversationId}`, 'GET');
}

/**
 * 提交满意度评价
 * @param {string} conversationId - 对话ID
 * @param {number} score - 1-5分
 * @param {string} comment - 评价内容
 */
function rateConversation(conversationId, score, comment = '') {
  return request('/chat/rate', 'POST', { conversationId, score, comment });
}

/**
 * 获取知识库常见问题（用于快捷提问）
 */
function getHotQuestions() {
  return request('/knowledge/list', 'GET');
}

/**
 * 健康检查
 */
function healthCheck() {
  return request('/health', 'GET');
}

module.exports = {
  BASE_URL,
  createConversation,
  sendMessage,
  getHistory,
  rateConversation,
  getHotQuestions,
  healthCheck
};
