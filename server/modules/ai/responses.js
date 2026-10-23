/**
 * 兜底话术
 *
 * 知识库未命中、AI 不可用时使用。集中在这里，方便统一措辞与合规要求
 * （例如必须提示可转人工）。
 */

'use strict';

/**
 * @param {string} userMessage
 * @returns {{type:string, answer:string, confidence:number, provider:string}}
 */
function getDefaultResponse(userMessage) {
  const lowerMsg = String(userMessage || '').toLowerCase();

  if (lowerMsg.includes('转人工') || lowerMsg.includes('真人') || lowerMsg.includes('人工客服')) {
    return {
      type: 'transfer',
      answer: '好的，我帮您转接人工客服，请稍候...\n\n当前排队人数：1人\n预计等待时间：2-3分钟',
      confidence: 1,
      provider: 'system',
    };
  }

  if (lowerMsg.includes('你好') || lowerMsg.includes('hi') ||
      lowerMsg.includes('hello') || lowerMsg.includes('在吗')) {
    return {
      type: 'greeting',
      answer: '您好！很高兴为您服务。我是AI智能客服，可以帮您解答常见问题。\n\n您可以咨询产品信息、了解服务内容、查询订单问题~\n\n如果遇到知识库无法解答的问题，可以输入"转人工"联系真人客服~',
      confidence: 1,
      provider: 'system',
    };
  }

  if (lowerMsg.includes('再见') || lowerMsg.includes('拜拜') || lowerMsg.includes('谢谢')) {
    return {
      type: 'farewell',
      answer: '感谢您的咨询！如有其他问题，随时欢迎回来。\n\n祝您生活愉快！',
      confidence: 1,
      provider: 'system',
    };
  }

  return {
    type: 'fallback',
    answer: '抱歉，根据我的知识库，暂时没有找到与您问题相关的信息。\n\n您可以尝试：\n1. 换一种方式描述您的问题\n2. 输入"转人工"联系真人客服获得帮助\n\n感谢您的理解！',
    confidence: 0.3,
    provider: 'system',
  };
}

module.exports = { getDefaultResponse };
