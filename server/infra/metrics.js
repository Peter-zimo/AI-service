/**
 * Prometheus 指标收集模块
 * 暴露 /api/metrics 端点（内部 token 鉴权），支持 Prometheus/Grafana 对接
 */

'use strict';

// 计数器
const counters = {
  http_requests_total: { labels: ['method', 'route', 'status'], values: new Map() },
  chat_messages_total: { labels: ['source'], values: new Map() },
  ai_requests_total: { labels: [], values: new Map() },
  ai_errors_total: { labels: ['type'], values: new Map() },
  ai_fallback_total: { labels: ['type'], values: new Map() },
};

// 直方图（分桶）
const histograms = {
  http_request_duration_ms: { labels: ['method', 'route'], buckets: [10, 50, 100, 200, 500, 1000, 3000, 10000], values: new Map() },
};

// 仪表值
const gauges = {
  nodejs_heap_used_bytes: () => process.memoryUsage().heapUsed,
  active_conversations: 0,
  ai_queue_pending: 0,
};

const startTime = Date.now();

function _key(...args) { return args.join('|'); }

// 计数器递增
function inc(name, labelValues = []) {
  const key = _key(...labelValues);
  const map = counters[name].values;
  map.set(key, (map.get(key) || 0) + 1);
}

// 记录直方图值
function observe(name, value, labelValues = []) {
  const key = _key(...labelValues);
  const histogram = histograms[name];
  if (!histogram.values.has(key)) {
    histogram.values.set(key, {
      bucketCounts: histogram.buckets.map(() => 0),
      sum: 0,
      count: 0,
    });
  }

  const entry = histogram.values.get(key);
  entry.sum += value;
  entry.count += 1;

  for (let i = 0; i < histogram.buckets.length; i++) {
    if (value <= histogram.buckets[i]) {
      entry.bucketCounts[i]++;
      return;
    }
  }
  // 超过最大桶：只体现在 +Inf / count / sum
}

// 生成 Prometheus 文本格式
function toPrometheusText() {
  const lines = [];

  // 计数器
  for (const [name, { labels, values }] of Object.entries(counters)) {
    lines.push(`# HELP ${name} Auto-generated counter`);
    lines.push(`# TYPE ${name} counter`);
    for (const [key, count] of values.entries()) {
      const parts = key === '' ? [] : key.split('|');
      const labelStr = labels.map((l, i) => `${l}="${parts[i] || ''}"`).join(',');
      lines.push(`${name}{${labelStr}} ${count}`);
    }
  }

  // 直方图
  for (const [name, { labels, buckets, values }] of Object.entries(histograms)) {
    lines.push(`# HELP ${name} Auto-generated histogram`);
    lines.push(`# TYPE ${name} histogram`);
    for (const [key, entry] of values.entries()) {
      const parts = key.split('|');
      const labelStr = labels.map((l, i) => `${l}="${parts[i] || ''}"`).join(',');

      let cumulative = 0;
      for (let i = 0; i < buckets.length; i++) {
        cumulative += entry.bucketCounts[i];
        lines.push(`${name}_bucket{${labelStr},le="${buckets[i]}"} ${cumulative}`);
      }
      lines.push(`${name}_bucket{${labelStr},le="+Inf"} ${entry.count}`);
      lines.push(`${name}_sum{${labelStr}} ${entry.sum}`);
      lines.push(`${name}_count{${labelStr}} ${entry.count}`);
    }
  }

  // 仪表
  lines.push('# HELP nodejs_heap_used_bytes V8 heap usage');
  lines.push('# TYPE nodejs_heap_used_bytes gauge');
  lines.push(`nodejs_heap_used_bytes ${gauges.nodejs_heap_used_bytes()}`);

  lines.push('# HELP nodejs_uptime_seconds Process uptime');
  lines.push('# TYPE nodejs_uptime_seconds gauge');
  lines.push(`nodejs_uptime_seconds ${((Date.now() - startTime) / 1000).toFixed(1)}`);

  lines.push('# HELP active_conversations Active conversations');
  lines.push('# TYPE active_conversations gauge');
  lines.push(`active_conversations ${gauges.active_conversations}`);

  // 队列积压：抓取时实时读取（waitingCount 不含正在执行的任务）
  try {
    const state = require('./state');
    const queues = state.queues;
    gauges.ai_queue_pending = typeof queues.waitingCount === 'function'
      ? queues.waitingCount()
      : queues.pendingCount();
  } catch (_) {
    /* 状态层不可用时保持 0 */
  }
  lines.push('# HELP ai_queue_pending Waiting AI tasks (excluding running)');
  lines.push('# TYPE ai_queue_pending gauge');
  lines.push(`ai_queue_pending ${gauges.ai_queue_pending}`);

  return lines.join('\n') + '\n';
}

/** 手动设置仪表值（供业务侧上报，如活跃会话数） */
function setGauge(name, value) {
  gauges[name] = value;
}

module.exports = { inc, observe, setGauge, toPrometheusText, gauges, startTime };
