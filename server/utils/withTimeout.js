/**
 * 超时与熔断工具
 *
 * - AiTimeoutError：AI 调用超时异常（带 phase 标识：headers=首字节 / idle=流空闲）
 * - withTimeout：给任意 fetch 调用加"首字节超时"（响应头到达即清理定时器）
 * - CircuitBreaker：简单熔断器（连续失败 N 次 → 熔断窗口内直接拒绝）
 */

class AiTimeoutError extends Error {
  constructor(message, phase = 'headers') {
    super(message);
    this.name = 'AiTimeoutError';
    this.phase = phase; // 'headers' | 'idle'
  }
}

/**
 * 首字节超时包装：timeoutMs 内 fetch 未返回（响应头未到）→ abort 并抛 AiTimeoutError
 * @param {Function} fetchImpl fetch 实现（可注入假实现测试）
 * @param {string} url
 * @param {object} [options] fetch options（可含 body/headers/method）
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<Response>}
 */
async function withTimeout(fetchImpl, url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
    return res;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new AiTimeoutError(`请求超时(${timeoutMs}ms): ${url}`, 'headers');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 简单熔断器：连续失败 >= failures 次 → 熔断 windowMs；熔断期内 isOpen()=true
 */
class CircuitBreaker {
  constructor({ failures = 5, windowMs = 30000 } = {}) {
    this.failures = failures;
    this.windowMs = windowMs;
    this._failCount = 0;
    this._openUntil = 0;
  }

  get isOpen() {
    return Date.now() < this._openUntil;
  }

  recordSuccess() {
    this._failCount = 0;
  }

  recordFailure() {
    this._failCount += 1;
    if (this._failCount >= this.failures) {
      this._openUntil = Date.now() + this.windowMs;
      this._failCount = 0;
    }
  }

  /** 测试用：重置状态 */
  reset() {
    this._failCount = 0;
    this._openUntil = 0;
  }
}

module.exports = { AiTimeoutError, withTimeout, CircuitBreaker };
