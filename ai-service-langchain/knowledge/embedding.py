"""
DeepSeek Embedding API 封装
- 继承 LangChain Embeddings 基类
- 支持降级到智谱 Embedding
- 最终兜底：本地 char-bigram 哈希向量（零依赖，与 Node 端算法一致）
"""

import importlib.util
import json
import os
import re
import threading
import time
from typing import List

import requests
from langchain_core.embeddings import Embeddings

from config import get_provider_config


# ============ 本地 Embedding（零依赖 fallback）============
# 与 Node 端 knowledge.js 的 localEmbedding 完全一致的算法
_LOCAL_DIM = 128


def _hash_code(s: str) -> int:
    h = 0
    for ch in s:
        h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
    if h >= 0x80000000:
        h -= 0x100000000
    return abs(h)


def local_embedding(text: str) -> List[float]:
    """char unigram+bigram 哈希到 128 维向量"""
    vec = [0.0] * _LOCAL_DIM
    chars = re.sub(r"\s+", "", str(text or ""))[:300]
    for i, ch in enumerate(chars):
        vec[_hash_code(ch) % _LOCAL_DIM] += 1.0
        if i + 1 < len(chars):
            vec[_hash_code(ch + chars[i + 1]) % _LOCAL_DIM] += 2.0
    return vec


# ============ 本地 BGE 模型（sentence-transformers，离线可用）============
# BAAI/bge-small-zh-v1.5：512 维中文检索模型（hidden_size=512），质量远优于 bigram 哈希
# 本地路径优先（BGE_MODEL_PATH 环境变量或 models/ 目录），离线加载，不依赖网络
_BGE_DIM = 512
_BGE_MODEL_NAME = os.environ.get(
    "BGE_MODEL_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "bge-small-zh-v1.5"),
) if os.path.isdir(
    os.environ.get("BGE_MODEL_PATH", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "bge-small-zh-v1.5"))
) else "BAAI/bge-small-zh-v1.5"
_bge_model = None
_bge_lock = threading.Lock()


def _bge_available() -> bool:
    """只检查「模型目录 + 包」是否存在，不触发 transformers/torch 导入"""
    if not os.path.isdir(_BGE_MODEL_NAME):
        return False
    try:
        return importlib.util.find_spec("sentence_transformers") is not None
    except Exception:
        return False


def _load_bge(non_blocking: bool = False):
    """惰性加载 BGE 模型

    non_blocking=True 时，若另一个线程正在加载则立即返回 False，
    调用方降级 bigram，避免请求被 30~40s 的 transformers 导入阻塞。
    """
    global _bge_model
    if _bge_model is not None:
        return _bge_model
    if non_blocking and _bge_lock.locked():
        return False
    with _bge_lock:
        if _bge_model is not None:
            return _bge_model
        if not _bge_available():
            _bge_model = False
            return _bge_model
        try:
            from sentence_transformers import SentenceTransformer
            _bge_model = SentenceTransformer(_BGE_MODEL_NAME, local_files_only=True)
            print(f"[Embedding] BGE 模型本地加载完成: {_BGE_MODEL_NAME}")
        except Exception as e:
            print(f"[Embedding] BGE 模型加载失败(降级 bigram): {e}")
            _bge_model = False  # 标记失败，不再重试
    return _bge_model


def preload_bge() -> None:
    """后台预热 BGE，避免首个请求承担 torch/transformers 的导入成本"""
    if _bge_model is not None or not _bge_available():
        return
    threading.Thread(target=_load_bge, daemon=True).start()


def bge_embedding(text: str, blocking: bool = False) -> List[float]:
    """BGE 本地模型嵌入（失败/加载中返回空列表 → 调用方降级 bigram）"""
    model = _load_bge(non_blocking=not blocking)
    if not model:
        return []
    try:
        vec = model.encode(str(text or "")[:512]).tolist()
        return vec
    except Exception as e:
        print(f"[Embedding] BGE encode 失败: {e}")
        return []


def embedding_provider_dim() -> int:
    """当前激活 embedding 源的向量维度（智谱 1024 → BGE 512 → 本地 128）

    不在这里触发模型加载：只检查包与模型目录是否存在。
    """
    cfg = get_provider_config("zhipu")
    if cfg.get("api_key"):
        return 1024
    if _bge_model is not False and _bge_available():
        return _BGE_DIM
    return _LOCAL_DIM


def embedding_health() -> dict:
    """健康检查用的 embedding 状态快照（不触发模型加载，保证 health 快速返回）"""
    cfg = get_provider_config("zhipu")
    if cfg.get("api_key"):
        return {"ready": True, "dimension": 1024, "provider": "zhipu", "loaded": True, "degraded": False}
    if _bge_model is not False and _bge_available():
        return {
            "ready": True,
            "dimension": _BGE_DIM,
            "provider": "bge",
            "loaded": _bge_model is not None,
            "degraded": False,
        }
    return {"ready": False, "dimension": _LOCAL_DIM, "provider": "bigram", "loaded": False, "degraded": True}


class DeepSeekEmbeddings(Embeddings):
    """DeepSeek / 智谱 Embedding 封装"""

    def __init__(self, provider: str = "deepseek"):
        self.provider = provider

    def _embed(self, text: str) -> List[float]:
        """单条文本嵌入（智谱 embedding-2 → 本地 BGE → bigram 兜底）

        注：DeepSeek 官方没有 /embeddings 端点（text-embedding-v2 是智谱模型名），
        不再尝试 DeepSeek，避免每次白等超时。
        """
        if not text or not text.strip():
            return []
        input_text = text.strip()[:512]  # 截断

        # 1. 智谱 embedding-2（1024 维，API 首选）
        cfg = get_provider_config("zhipu")
        if cfg.get("api_key"):
            try:
                resp = requests.post(
                    f"{cfg['base_url']}/embeddings",
                    json={"input": input_text, "model": "embedding-2"},
                    headers={"Authorization": f"Bearer {cfg['api_key']}"},
                    timeout=10,
                )
                if resp.ok:
                    data = resp.json()
                    if data.get("data") and data["data"][0].get("embedding"):
                        return data["data"][0]["embedding"]
                else:
                    print(f"[Embedding] 智谱返回 {resp.status_code}: {resp.text[:100]}")
            except Exception as e:
                print(f"[Embedding] 智谱 失败: {e}")

        # 2. 本地 BGE 模型（sentence-transformers，512 维，离线可用）
        vec = bge_embedding(input_text)
        if vec:
            return vec

        # 3. 本地 bigram 哈希 128 维（最终兜底，零依赖）
        return local_embedding(input_text)

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """批量嵌入文档"""
        results = []
        for i, text in enumerate(texts):
            vec = self._embed(text)
            results.append(vec)
            if i < len(texts) - 1:
                time.sleep(0.2)  # 限速
        return results

    def embed_query(self, text: str) -> List[float]:
        """嵌入查询"""
        return self._embed(text)

    @staticmethod
    def cosine_similarity(a: List[float], b: List[float]) -> float:
        """余弦相似度"""
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        na = sum(x * x for x in a) ** 0.5
        nb = sum(y * y for y in b) ** 0.5
        return dot / (na * nb) if na * nb > 0 else 0.0
