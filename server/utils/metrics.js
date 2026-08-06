/**
 * Prometheus 指标收集模块
 * 暴露 /metrics 端点，支持 Grafana 对接
 */

const os = require('os');

// 计数器
const counters = {
  http_requests_total: { labels: ['method', 'route', 'status'], values: new Map() },
  chat_messages_total: { labels: ['source'], values: new Map() },
  ai_errors_total: { labels: ['type'], values: new Map() },
};

// 直方图（分桶）
const histograms = {
  http_request_duration_ms: { labels: ['method', 'route'], buckets: [10, 50, 100, 200, 500, 1000, 3000, 10000], values: new Map() },
};

// 仪表值
const gauges = {
  nodejs_heap_used_bytes: () => process.memoryUsage().heapUsed,
  nodejs_eventloop_lag_ms: 0,
  active_conversations: 0,
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
  const map = histograms[name].values;
  if (!map.has(key)) {
    map.set(key, histograms[name].buckets.map(() => 0));
  }
  const bucketCounts = map.get(key);
  const buckets = histograms[name].buckets;
  for (let i = 0; i < buckets.length; i++) {
    if (value <= buckets[i]) { bucketCounts[i]++; break; }
    if (i === buckets.length - 1) bucketCounts[i]++; // +Inf
  }
}

// 生成 Prometheus 文本格式
function toPrometheusText() {
  const lines = [];

  // 计数器
  for (const [name, { labels, values }] of Object.entries(counters)) {
    lines.push(`# HELP ${name} Auto-generated counter`);
    lines.push(`# TYPE ${name} counter`);
    for (const [key, count] of values.entries()) {
      const parts = key.split('|');
      const labelStr = labels.map((l, i) => `${l}="${parts[i] || ''}"`).join(',');
      lines.push(`${name}{${labelStr}} ${count}`);
    }
  }

  // 直方图
  for (const [name, { labels, buckets, values }] of Object.entries(histograms)) {
    lines.push(`# HELP ${name} Auto-generated histogram`);
    lines.push(`# TYPE ${name} histogram`);
    for (const [key, bucketCounts] of values.entries()) {
      const parts = key.split('|');
      const labelStr = labels.map((l, i) => `${l}="${parts[i] || ''}"`).join(',');
      let cumulative = 0;
      for (let i = 0; i < buckets.length; i++) {
        cumulative += bucketCounts[i];
        lines.push(`${name}_bucket{${labelStr},le="${buckets[i]}"} ${cumulative}`);
      }
      lines.push(`${name}_bucket{${labelStr},le="+Inf"} ${cumulative}`);
      lines.push(`${name}_count{${labelStr}} ${cumulative}`);
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

  return lines.join('\n') + '\n';
}

module.exports = { inc, observe, toPrometheusText, gauges, startTime };
