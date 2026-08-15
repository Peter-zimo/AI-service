/**
 * AI 服务（LangChain localhost:8000）流式客户端
 *
 * - 双段超时：首字节超时（headersTimeoutMs，响应头未到即 abort）
 *    + 流空闲超时（idleTimeoutMs，每次 reader.read() 前重置，流停滞即 abort）
 * - 可注入 fetchImpl 便于单测（不依赖真实 AI 服务）
 */

const { AiTimeoutError, withTimeout, CircuitBreaker } = require('../utils/withTimeout');

class AiStreamClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl='http://localhost:8000']
   * @param {number} [opts.headersTimeoutMs=30000] 首字节超时
   * @param {number} [opts.idleTimeoutMs=15000] 流空闲超时
   * @param {number} [opts.sensitiveTimeoutMs=10000] 敏感检测超时
   * @param {Function} [opts.fetchImpl] 注入假 fetch（测试用）
   */
  constructor({
    baseUrl = 'http://localhost:8000',
    headersTimeoutMs = 30000,
    idleTimeoutMs = 15000,
    sensitiveTimeoutMs = 10000,
    failures = 5,
    windowMs = 30000,
    fetchImpl = null,
    serviceToken = process.env.AI_SERVICE_TOKEN || '',
  } = {}) {
    this.baseUrl = baseUrl;
    this.headersTimeoutMs = headersTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sensitiveTimeoutMs = sensitiveTimeoutMs;
    this._fetch = fetchImpl || ((url, opts) => fetch(url, opts));
    this.serviceToken = serviceToken;
    this.breaker = new CircuitBreaker({ failures, windowMs });
  }

  /** 熔断是否开启（开 → 调用方应直接走降级） */
  get isBreakerOpen() {
    return this.breaker.isOpen;
  }

  /**
   * 流式读取一步：包装 reader.read()，空闲超时(abort) 的 AbortError → AiTimeoutError('idle')
   * 调用方每读完一块后应调用 resetIdle() 重置空闲计时
   */
  async readChunk(reader) {
    try {
      return await reader.read();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new AiTimeoutError('AI 流空闲超时', 'idle');
      }
      throw e;
    }
  }

  /**
   * 打开流式对话（POST /api/chat/stream）
   * @returns {Promise<{reader: ReadableStreamDefaultReader, resetIdle: Function, clearIdle: Function, close: Function}>}
   * @throws {AiTimeoutError} 首字节超时 / 流空闲超时（phase 区分）
   */
  async openChatStream({ conversationId, message, useAgent = true }) {
    const url = `${this.baseUrl}/api/chat/stream`;
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), this.headersTimeoutMs);

    let response;
    try {
      response = await this._fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.serviceToken ? { 'X-Internal-Service-Token': this.serviceToken } : {}) },
        body: JSON.stringify({ conversation_id: conversationId, message, use_agent: useAgent }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        throw new AiTimeoutError(`AI 首字节超时(${this.headersTimeoutMs}ms)`, 'headers');
      }
      throw e;
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`LangChain 返回 ${response.status}`);
    }

    const reader = response.body.getReader();
    let idleTimer = null;
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
    const resetIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => controller.abort(), this.idleTimeoutMs);
    };
    const close = () => { clearTimeout(timer); clearIdle(); controller.abort(); };

    return { reader, resetIdle, clearIdle, close };
  }

  /**
   * 敏感检测（POST /api/sensitive/check，带超时）
   * @returns {Promise<object>} 原始 JSON（调用方自行判断）
   */
  async checkSensitive(text) {
    const url = `${this.baseUrl}/api/sensitive/check`;
    const res = await withTimeout(
      this._fetch,
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.serviceToken ? { 'X-Internal-Service-Token': this.serviceToken } : {}) },
        body: JSON.stringify({ text }),
      },
      this.sensitiveTimeoutMs
    );
    if (!res.ok) throw new Error(`敏感检测返回 ${res.status}`);
    return res.json();
  }
}

module.exports = { AiStreamClient, AiTimeoutError };
