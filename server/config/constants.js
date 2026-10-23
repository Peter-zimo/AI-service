/**
 * 领域常量（Domain Constants）
 *
 * 把散落在各处的魔法字符串与魔法数字收口到一处。
 * 改状态值、调超时，只改这个文件，不用全仓库搜索。
 */

'use strict';

/** 会话状态 */
const CONVERSATION_STATUS = {
  ACTIVE: 'active',
  IDLE: 'idle',
  CLOSED: 'closed',
};

/** 会话模式：AI 自动 / 排队等人工 / 人工接管 */
const CONVERSATION_MODE = {
  AI: 'ai',
  QUEUE: 'queue',
  HUMAN: 'human',
};

/** 会话超时策略（毫秒） */
const TIMEOUT_CONFIG = {
  IDLE_TIMEOUT: 5 * 60 * 1000,
  CLOSE_TIMEOUT: 10 * 60 * 1000,
  CHECK_INTERVAL: 30 * 1000,
};

/** AI 服务超时与熔断 */
const AI_TIMEOUT = {
  FIRST_BYTE_MS: 30 * 1000,      // 首字节超时
  STREAM_IDLE_MS: 15 * 1000,     // 流空闲超时
  HEALTH_MS: 3 * 1000,           // 健康检查超时
  BREAKER_THRESHOLD: 3,          // 连续失败次数触发熔断
  BREAKER_COOLDOWN_MS: 60 * 1000,
};

/** 知识库检索参数 */
const RETRIEVAL = {
  FTS_LIMIT: 10,
  SEMANTIC_LIMIT: 5,
  HYBRID_LIMIT: 3,
  RRF_K: 60,
  LOCAL_EMBEDDING_DIM: 128,
  LOCAL_SEMANTIC_THRESHOLD: 0.5,   // 本地哈希向量阈值
  REMOTE_SEMANTIC_THRESHOLD: 0.55, // 远程 embedding 阈值
  LEGACY_STRONG_SCORE: 20,         // 传统检索强命中阈值
  ORIGINAL_SCORE_THRESHOLD: 0.04,  // FTS/混合检索原始分阈值
  EMBEDDING_BATCH_DELAY_MS: 200,
};

/** 消息与输入限制 */
const MESSAGE = {
  MAX_LENGTH: 2000,
  MAX_BATCH_IMPORT: 1000,
};

/** 角色 */
const ROLE = {
  ADMIN: 'admin',
  AGENT: 'agent',
  READONLY: 'readonly',
};

module.exports = {
  CONVERSATION_STATUS,
  CONVERSATION_MODE,
  TIMEOUT_CONFIG,
  AI_TIMEOUT,
  RETRIEVAL,
  MESSAGE,
  ROLE,
};
