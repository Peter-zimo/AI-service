/**
 * AI智能客服 — Chat Widget 启动器
 * 业务网站一行接入：<script src="/widget/widget.js" data-api="https://你的域名"></script>
 *
 * 生成：右下角气泡按钮 + iframe 聊天窗 + postMessage 双向通信
 * 全局 API：CSWidget.open() / close() / send(msg) / setUser(user)
 */
(function () {
  'use strict';

  // ===== 配置 =====
  var script = document.currentScript || (function () {
    var s = document.querySelectorAll('script[src*="widget.js"]');
    return s[s.length - 1];
  })();

  var cfg = {
    apiUrl: script.getAttribute('data-api') || '',
    title: script.getAttribute('data-title') || '在线客服',
    logo: script.getAttribute('data-logo') || '🤖',
    color: script.getAttribute('data-color') || '#2563eb',
    position: script.getAttribute('data-position') || 'right', // right | left
    widgetSrc: script.getAttribute('data-widget') || (script.src ? script.src.replace('widget.js', 'chat.html') : '/widget/chat.html'),
  };

  // window.CSWidget 配置对象可覆盖
  if (window.CSWidgetConfig) {
    for (var k in window.CSWidgetConfig) {
      if (window.CSWidgetConfig[k] !== undefined) cfg[k] = window.CSWidgetConfig[k];
    }
  }

  var state = {
    open: false,
    unread: 0,
    iframeReady: false,
  };

  // ===== 注入样式 =====
  var style = document.createElement('style');
  style.textContent = [
    '.csw-bubble{position:fixed;z-index:2147483000;width:56px;height:56px;border-radius:50%;',
    'background:' + cfg.color + ';color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;',
    'box-shadow:0 4px 16px rgba(16,24,40,0.25);transition:transform .2s cubic-bezier(.4,0,.2,1),box-shadow .2s;',
    'font-size:24px;line-height:1;bottom:20px;' + cfg.position + ':20px;padding:0;}',
    '.csw-bubble:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(16,24,40,0.3);}',
    '.csw-bubble.csw-open{transform:scale(0);opacity:0;pointer-events:none;}',
    '.csw-badge{position:fixed;z-index:2147483001;min-width:18px;height:18px;border-radius:9px;',
    'background:#ef4444;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;',
    'padding:0 4px;bottom:66px;' + cfg.position + ':22px;pointer-events:none;box-shadow:0 2px 6px rgba(239,68,68,0.4);}',
    '.csw-frame{position:fixed;z-index:2147483002;width:380px;height:560px;max-width:calc(100vw - 24px);',
    'max-height:calc(100vh - 24px);border:none;border-radius:16px;bottom:24px;' + cfg.position + ':24px;',
    'box-shadow:0 20px 60px rgba(16,24,40,0.28);transform:translateY(16px) scale(0.96);opacity:0;',
    'pointer-events:none;transition:transform .22s cubic-bezier(.4,0,.2,1),opacity .22s;background:#fff;}',
    '.csw-frame.csw-show{transform:translateY(0) scale(1);opacity:1;pointer-events:auto;}',
    '@media (max-width:480px){.csw-frame{width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;',
    'bottom:0;' + cfg.position + ':0;border-radius:0;border:none;}.csw-bubble{bottom:16px;' + cfg.position + ':16px;}}',
  ].join('\n');
  document.head.appendChild(style);

  // ===== DOM 创建 =====
  var bubble = document.createElement('button');
  bubble.className = 'csw-bubble';
  bubble.setAttribute('aria-label', cfg.title);
  bubble.innerHTML = cfg.logo;
  bubble.addEventListener('click', function () {
    state.open ? close() : open();
  });
  document.body.appendChild(bubble);

  var badge = document.createElement('div');
  badge.className = 'csw-badge';
  badge.style.display = 'none';
  badge.textContent = '0';
  document.body.appendChild(badge);

  var frame = document.createElement('iframe');
  frame.className = 'csw-frame';
  frame.src = cfg.widgetSrc;
  frame.setAttribute('title', cfg.title);
  frame.setAttribute('allow', 'clipboard-write');
  document.body.appendChild(frame);

  // ===== 通信 =====
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'csw-minimize') { close(); }
    else if (msg.type === 'csw-badge') {
      state.unread = msg.count || 1;
      updateBadge();
    }
  });

  function updateBadge() {
    if (state.open) { badge.style.display = 'none'; return; }
    if (state.unread > 0) {
      badge.style.display = 'flex';
      badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
    } else {
      badge.style.display = 'none';
    }
  }

  function postToFrame(obj) {
    if (frame.contentWindow) {
      try { frame.contentWindow.postMessage(obj, '*'); } catch (e) {}
    }
  }

  // ===== 全局 API =====
  function open() {
    state.open = true;
    bubble.classList.add('csw-open');
    frame.classList.add('csw-show');
    state.unread = 0;
    updateBadge();
    // 注入 API 地址（跨域部署）
    if (cfg.apiUrl) postToFrame({ type: 'csw-api', apiUrl: cfg.apiUrl + '/api' });
  }

  function close() {
    state.open = false;
    bubble.classList.remove('csw-open');
    frame.classList.remove('csw-show');
  }

  function send(text) {
    postToFrame({ type: 'csw-send', text: String(text || '') });
    if (!state.open) open();
  }

  function setUser(user) {
    postToFrame({ type: 'csw-set-user', user: user || {} });
  }

  window.CSWidget = {
    open: open,
    close: close,
    send: send,
    setUser: setUser,
    isOpen: function () { return state.open; },
  };

  // ===== 自动展开（配置 autoOpen） =====
  if (cfg.autoOpen) {
    setTimeout(open, cfg.autoOpenDelay || 1500);
  }

  // ===== 未读清零：打开后重置 =====
  frame.addEventListener('load', function () { state.iframeReady = true; });
})();
