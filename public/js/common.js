/**
 * 公共前端工具库 — window.App 命名空间
 * 提供：token 管理 / apiFetch / toast / modal / esc / 时间格式化
 */
(function () {
  'use strict';

  const App = {};

  /* ===== Token 管理 ===== */
  App.getToken = function () {
    const auth = localStorage.getItem('authHeader') || '';
    return auth.startsWith('Bearer ') ? auth : '';
  };
  App.setToken = function (token) {
    localStorage.setItem('authHeader', token ? 'Bearer ' + token : '');
  };
  App.clearToken = function () {
    localStorage.removeItem('authHeader');
    localStorage.removeItem('currentUser');
  };
  App.isLoggedIn = function () {
    return !!App.getToken();
  };

  /* ===== HTML 转义 ===== */
  App.esc = function (str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  App.escAttr = App.esc;

  /* ===== 时间格式化 ===== */
  App.fmtTime = function (t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d)) return String(t);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };
  App.fmtDateTime = function (t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d)) return String(t);
    const date = d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return date + ' ' + time;
  };
  App.timeAgo = function (t) {
    if (!t) return '';
    const diff = Date.now() - new Date(t).getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    return Math.floor(diff / 86400000) + '天前';
  };

  /* ===== Toast 通知 ===== */
  App.toast = function (message, type) {
    type = type || 'info';
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    const icons = {
      success: '✓',
      error: '✕',
      warning: '!',
      info: 'ℹ',
    };
    el.innerHTML = '<span>' + (icons[type] || 'ℹ') + '</span><span>' + App.esc(message) + '</span>';
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 350);
    }, 3200);
  };

  /* ===== Modal 弹窗 ===== */
  App.modal = {
    open(el) {
      el.classList.add('show');
      el.style.display = 'flex';
    },
    close(el) {
      el.classList.remove('show');
      setTimeout(() => { el.style.display = 'none'; }, 180);
    },
    init() {
      // 点击遮罩关闭
      document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) App.modal.close(overlay);
        });
      });
      // 关闭按钮
      document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
          const overlay = btn.closest('.modal-overlay');
          if (overlay) App.modal.close(overlay);
        });
      });
      // ESC 关闭
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          document.querySelectorAll('.modal-overlay.show').forEach(overlay => {
            App.modal.close(overlay);
          });
        }
      });
    },
  };

  /* ===== 带认证的 fetch ===== */
  App.apiFetch = async function (url, options = {}, timeout) {
    const headers = { ...(options.headers || {}) };
    const token = App.getToken();
    if (token) headers['Authorization'] = token;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 8000);

    let res;
    try {
      res = await fetch(url, { ...options, headers, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new Error('网络错误或请求超时');
    }
    clearTimeout(timer);

    if (res.status === 401) {
      App.clearToken();
      throw new Error('登录已过期，请重新登录');
    }
    return res;
  };

  /* ===== 序列化 FormData ===== */
  App.formToJson = function (formEl) {
    const data = {};
    new FormData(formEl).forEach((v, k) => { data[k] = v; });
    return data;
  };

  /* ===== 防抖 ===== */
  App.debounce = function (fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay || 300);
    };
  };

  /* ===== 图标（SVG sprite 引用）===== */
  App.icon = function (name, size) {
    const cls = size === 'lg' ? 'icon icon-lg' : 'icon';
    return `<svg class="${cls}" aria-hidden="true"><use href="/vendor/icons.svg#${name}"/></svg>`;
  };

  // 暴露到全局
  window.App = App;

  // DOM 就绪后初始化 modal
  document.addEventListener('DOMContentLoaded', () => App.modal.init());
})();
