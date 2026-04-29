// pages/customerService/index.js
const api = require('../../utils/customerServiceApi');

Page({
  data: {
    messages: [],         // 消息列表
    inputText: '',        // 输入框内容
    isTyping: false,      // 打字动画
    isConnected: false,   // 服务是否连通
    conversationId: null, // 当前对话ID
    visitorId: null,      // 访客ID
    userAvatar: '/images/user-default.png',
    scrollToId: 'msg-bottom',
    hotQuestions: [],     // 常见问题
    showRating: false,    // 显示评价
    ratingScore: 0,       // 评价分数
    msgCounter: 0,        // 消息计数（用于生成唯一ID）
  },

  onLoad() {
    this._initVisitor();
    this._checkConnection();
    this._loadHotQuestions();
  },

  // ===== 初始化访客身份 =====
  _initVisitor() {
    let visitorId = wx.getStorageSync('cs_visitor_id');
    if (!visitorId) {
      visitorId = 'visitor_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      wx.setStorageSync('cs_visitor_id', visitorId);
    }
    this.setData({ visitorId });

    // 尝试获取用户头像（如果有登录态）
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo && userInfo.avatarUrl) {
      this.setData({ userAvatar: userInfo.avatarUrl });
    }
  },

  // ===== 健康检查 =====
  async _checkConnection() {
    try {
      await api.healthCheck();
      this.setData({ isConnected: true });
    } catch (e) {
      this.setData({ isConnected: false });
      wx.showToast({
        title: '客服服务暂时不可用',
        icon: 'none',
        duration: 2000
      });
    }
  },

  // ===== 加载常见问题 =====
  async _loadHotQuestions() {
    try {
      const res = await api.getHotQuestions();
      if (res.success && res.items) {
        // 取前5条作为快捷提问
        this.setData({ hotQuestions: res.items.slice(0, 5) });
      }
    } catch (e) {
      console.warn('加载常见问题失败', e);
    }
  },

  // ===== 确保有对话ID =====
  async _ensureConversation() {
    if (this.data.conversationId) return this.data.conversationId;

    const { visitorId } = this.data;
    const userInfo = wx.getStorageSync('userInfo');
    const visitorName = userInfo ? (userInfo.nickName || '访客') : '访客';

    try {
      const res = await api.createConversation(visitorId, visitorName);
      if (res.success) {
        this.setData({ conversationId: res.conversationId });
        return res.conversationId;
      }
    } catch (e) {
      wx.showToast({ title: '连接失败，请稍后重试', icon: 'none' });
      throw e;
    }
  },

  // ===== 添加消息到列表 =====
  _addMessage(role, content, extra = {}) {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
    const counter = this.data.msgCounter + 1;
    const msg = {
      id: `${role}_${counter}`,
      role,
      content,
      timeStr,
      ...extra
    };
    this.setData({
      messages: [...this.data.messages, msg],
      msgCounter: counter,
      scrollToId: 'msg-bottom'
    });
    return msg;
  },

  // ===== 输入框变化 =====
  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  // ===== 发送消息 =====
  async onSend() {
    const text = this.data.inputText.trim();
    if (!text) return;
    if (!this.data.isConnected) {
      wx.showToast({ title: '服务连接中，请稍后', icon: 'none' });
      return;
    }

    // 清空输入框，显示用户消息
    this.setData({ inputText: '' });
    this._addMessage('user', text);

    // 显示打字动画
    this.setData({ isTyping: true, scrollToId: 'msg-bottom' });

    try {
      const conversationId = await this._ensureConversation();
      const res = await api.sendMessage(conversationId, text, this.data.visitorId);

      this.setData({ isTyping: false });

      if (res.success) {
        const { message, type, matchQuestion } = res.response;
        const showHumanBtn = message.includes('人工') || message.includes('转接');

        this._addMessage('assistant', message, {
          type,
          matchQuestion,
          showHumanBtn
        });
      } else {
        this._addMessage('assistant', '抱歉，我暂时无法回答，请稍后再试或联系人工客服。', { type: 'error' });
      }
    } catch (e) {
      this.setData({ isTyping: false });
      this._addMessage('assistant', '网络异常，请检查网络后重试。', { type: 'error' });
    }
  },

  // ===== 快捷提问 =====
  onQuickAsk(e) {
    const question = e.currentTarget.dataset.question;
    this.setData({ inputText: question });
    this.onSend();
  },

  // ===== 转人工 =====
  onTransferHuman() {
    wx.showModal({
      title: '转接人工客服',
      content: '即将为您转接人工客服，工作时间：周一至周六 9:00-18:00',
      confirmText: '确认转接',
      cancelText: '继续AI服务',
      success: (res) => {
        if (res.confirm) {
          // 可接入企业微信客服 / 电话
          wx.makePhoneCall({
            phoneNumber: '400-000-0000', // 替换为你的客服电话
            fail: () => {
              wx.showToast({ title: '拨号失败', icon: 'none' });
            }
          });
        }
      }
    });
  },

  // ===== 结束对话 =====
  onEndConversation() {
    this.setData({ showRating: true });
  },

  // ===== 星级评价 =====
  onStarTap(e) {
    this.setData({ ratingScore: e.currentTarget.dataset.score });
  },

  // ===== 跳过评价 =====
  onSkipRating() {
    this._resetConversation();
  },

  // ===== 提交评价 =====
  async onSubmitRating() {
    const { ratingScore, conversationId } = this.data;
    if (ratingScore === 0) {
      wx.showToast({ title: '请选择评分', icon: 'none' });
      return;
    }

    try {
      if (conversationId) {
        await api.rateConversation(conversationId, ratingScore, '');
      }
      wx.showToast({ title: '感谢您的反馈！', icon: 'success' });
    } catch (e) {
      console.warn('提交评价失败', e);
    }

    setTimeout(() => this._resetConversation(), 1500);
  },

  // ===== 重置对话 =====
  _resetConversation() {
    this.setData({
      messages: [],
      conversationId: null,
      showRating: false,
      ratingScore: 0,
      inputText: '',
      msgCounter: 0
    });
    this._loadHotQuestions();
    wx.showToast({ title: '对话已结束', icon: 'none' });
  },

  // ===== 刷新 =====
  onRefresh() {
    this._checkConnection();
    if (this.data.messages.length === 0) {
      this._loadHotQuestions();
    }
  },

  onShareAppMessage() {
    return {
      title: 'AI智能客服',
      path: '/pages/customerService/index'
    };
  }
});
