/**
 * 向量与相似度计算
 *
 * 当前策略：本地零依赖哈希向量（不发起任何网络请求）。
 * 之所以保留这一层独立，是为了后续接真实 embedding 服务时只改本文件，
 * 不牵动检索与 CRUD 逻辑。
 */

'use strict';

const { RETRIEVAL } = require('../../config/constants');

const LOCAL_DIM = RETRIEVAL.LOCAL_EMBEDDING_DIM;
const MAX_TEXT_LEN = 300;
const MAX_EMBED_LEN = 512;

/**
 * 字符串哈希（djb2 变体），保证同输入同输出
 * @param {string} str
 * @returns {number}
 */
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * 本地哈希向量：单字权重 1，相邻双字权重 2
 * @param {string} text
 * @returns {number[]} 长度 128 的向量
 */
function localEmbedding(text) {
  const vec = new Array(LOCAL_DIM).fill(0);
  const chars = String(text || '').replace(/\s+/g, '').slice(0, MAX_TEXT_LEN);

  for (let i = 0; i < chars.length; i++) {
    vec[hashCode(chars[i]) % LOCAL_DIM] += 1;
    if (i + 1 < chars.length) {
      vec[hashCode(chars[i] + chars[i + 1]) % LOCAL_DIM] += 2;
    }
  }
  return vec;
}

/**
 * 余弦相似度
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} 0~1，长度不一致或零向量返回 0
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : dot / norm;
}

/**
 * 计算文本向量（当前走本地实现，零网络依赖）
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function computeEmbedding(text) {
  if (!text || !String(text).trim()) return null;
  return localEmbedding(String(text).trim().slice(0, MAX_EMBED_LEN));
}

module.exports = {
  LOCAL_DIM,
  hashCode,
  localEmbedding,
  cosineSimilarity,
  computeEmbedding,
};
