"""
混合检索模块 (Hybrid Retrieval) —— 唯一检索权威
- BM25 关键词检索（jieba 分词）
- 向量语义检索（BGE 512 / 智谱 1024）
- RRF 融合排序
- 三级优雅降级

Node 端通过 /api/kb/search 与 /api/kb/best-match 调用本模块；
Node 本地 retrieval.js 仅作 Python 不可达时的降级兜底。
"""

import json
import os
import re
import threading
import time
import requests
from typing import List, Optional, Dict, Any
from pathlib import Path

import jieba
from rank_bm25 import BM25Okapi
from langchain_core.documents import Document

from config import BASE_DIR, load_config, get_provider_config
from knowledge.embedding import DeepSeekEmbeddings, _load_bge


def resolve_node_sqlite_path() -> Optional[Path]:
    configured = os.environ.get("NODE_SQLITE_PATH")
    if configured:
        candidate = Path(configured)
        if candidate.is_file():
            return candidate

    candidate = BASE_DIR.parent / "AI智能客服V3（node.js版）" / "server" / "data" / "service.db"
    return candidate if candidate.is_file() else None


def fetch_node_knowledge() -> List[Dict[str, Any]]:
    token = os.environ.get("AI_SERVICE_TOKEN", "").strip()
    if not token:
        raise RuntimeError("AI_SERVICE_TOKEN is required when DB_TYPE=postgres")
    base_url = os.environ.get("NODE_API_BASE", "http://localhost:3456").rstrip("/")
    response = requests.get(
        f"{base_url}/api/internal/knowledge",
        headers={"X-Internal-Service-Token": token},
        timeout=10,
    )
    response.raise_for_status()
    payload = response.json()
    if not payload.get("success") or not isinstance(payload.get("data"), list):
        raise RuntimeError("Node knowledge authority returned an invalid response")
    return payload["data"]


def load_authoritative_knowledge() -> List["KnowledgeItem"]:
    if os.environ.get("DB_TYPE") == "postgres":
        return [KnowledgeItem(item["id"], item["question"], item["answer"], item.get("keywords") or [])
                for item in fetch_node_knowledge()]

    db_path = resolve_node_sqlite_path()
    if not db_path:
        return []
    import sqlite3
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute("SELECT id, question, answer, keywords, embedding FROM knowledge").fetchall()
    finally:
        conn.close()
    return [KnowledgeItem(row[0], row[1], row[2], json.loads(row[3]) if row[3] else [],
                          json.loads(row[4]) if row[4] else None) for row in rows]

# ============ 数据结构 ============

# ============ 检索用停用词/单字过滤（防止弱重合噪音导致答非所问） ============
_STOPWORDS = {"的", "了", "吗", "呢", "吧", "啊", "哦", "呀", "么", "我", "你", "他", "她", "它",
              "是", "在", "有", "就", "都", "和", "与", "及", "或", "这", "那", "个", "嗯", "哈",
              "怎么", "什么", "怎么办", "为什么", "如何", "怎样", "咋", "咋办", "一个", "一下", "可以"}
# 关键单字白名单（保留，参与匹配）
_KEEP_SINGLE = {"车", "锁", "卡", "点", "账", "金", "钱", "押", "费", "码", "电", "胎", "雨", "帽",
                "区", "箱", "网", "号", "级", "券", "账", "密", "键", "骑"}

# 通用词：作为关键词参与匹配会造成「光合作用」命中「会员卡作用」这类误报
_GENERIC_KEYWORDS = {"作用", "什么", "怎么", "如何", "可以", "一下", "你们", "我们",
                     "为什么", "怎样", "咋办", "一个", "介绍", "解释"}


def _filter_tokens(tokens) -> List[str]:
    """过滤停用词与无意义单字，保留有信息量的 token"""
    out = []
    for t in tokens:
        t = (t or "").strip()
        if not t:
            continue
        if t in _STOPWORDS:
            continue
        if len(t) == 1 and t not in _KEEP_SINGLE:
            continue
        out.append(t)
    return out


class KnowledgeItem:
    """知识库条目"""
    def __init__(self, id: str, question: str, answer: str, keywords: List[str], embedding: Optional[List[float]] = None):
        self.id = id
        self.question = question
        self.answer = answer
        self.keywords = keywords
        self.embedding = embedding

# ============ 默认知识库 ============

DEFAULT_KNOWLEDGE = [
    KnowledgeItem("k1", "营业时间", "我们的营业时间是每天 9:00-22:00，欢迎光临！",
                  ["营业时间", "几点开门", "几点关门", "开门时间", "关门时间"]),
    KnowledgeItem("k2", "如何联系客服", "您可以通过以下方式联系我们：电话 400-123-4567，微信客服 abc123456",
                  ["联系", "客服", "电话", "微信", "邮箱", "怎么联系"]),
    KnowledgeItem("k3", "退款政策", "我们支持7天内无理由退款，15天内质量问题可换货。退款将在1-3个工作日内原路返回。",
                  ["退款", "退钱", "退货", "换货", "售后", "取消订单"]),
    KnowledgeItem("k4", "会员积分", "每消费1元积1分，100积分可抵扣1元。会员生日当月消费双倍积分。",
                  ["积分", "会员", "兑换", "抵扣", "怎么用积分"]),
    KnowledgeItem("k5", "优惠活动", "当前活动：新用户首单立减10元，满99元包邮，每周三会员日8折优惠。",
                  ["优惠", "折扣", "活动", "促销", "满减", "打折"]),
    KnowledgeItem("k6", "单车坏了怎么办", "如果单车出现故障，请拍摄故障照片并通过App报障，系统会立即冻结该车并安排维修团队处理。",
                  ["单车", "故障", "坏了", "报障", "维修", "车坏了"]),
]

# ============ 知识库服务 ============

class KnowledgeService:
    def __init__(self):
        self.items: List[KnowledgeItem] = []
        self.bm25: Optional[BM25Okapi] = None
        self._corpus: List[List[str]] = []
        self._embeddings: Optional[DeepSeekEmbeddings] = None
        self._embeddings_ready = False
        self._embed_lock = threading.Lock()  # 串行化 embedding 计算/重算
        self._recomputing = False            # 是否正在后台重算
        self._load_knowledge()
        # 加载后检查 embedding 维度一致性，不一致则后台重算（智谱 1024 / 本地 128）
        self._ensure_embedding_dim()

    def _ensure_embedding_dim(self) -> None:
        """检测知识库 embedding 维度与当前激活源是否一致，不一致则异步重算（串行化，防并发）"""
        from knowledge.embedding import embedding_provider_dim
        target = embedding_provider_dim()
        sample = next((i.embedding for i in self.items if i.embedding), None)
        current = len(sample) if sample else 0
        if current == target and current > 0:
            print(f"[知识库] embedding 维度一致 ({target})")
            self._embeddings_ready = True
            return
        print(f"[知识库] embedding 维度 {current} != 目标 {target}，后台重算 {len(self.items)} 条...")
        with self._embed_lock:
            if self._recomputing:
                return
            self._recomputing = True
        threading.Thread(target=self._recompute_embeddings, daemon=True).start()

    def _recompute_embeddings(self) -> None:
        """用当前激活 embedding 源重算全部条目（仅内存，不回写 SQLite）

        在锁保护下执行，避免多个线程并发改写 items 导致检索结果不确定。
        """
        try:
            # 后台线程里阻塞等待 BGE 加载完成，保证重算出的向量与查询向量同维度
            _load_bge()
            emb = DeepSeekEmbeddings()
            done = 0
            for item in self.items:
                vec = emb._embed(item.question)
                if vec:
                    item.embedding = vec
                    done += 1
                time.sleep(0.15)  # 限速
            print(f"[知识库] embedding 重算完成 {done}/{len(self.items)} 条")
        except Exception as e:
            print(f"[知识库] embedding 重算失败: {e}")
        finally:
            with self._embed_lock:
                self._recomputing = False
            self._embeddings_ready = True

    def _load_knowledge(self) -> None:
        """加载知识库"""
        try:
            self.items = load_authoritative_knowledge()
            if self.items:
                print(f"[知识库] 加载权威知识库 {len(self.items)} 条")
        except Exception as e:
            if os.environ.get("DB_TYPE") == "postgres":
                raise RuntimeError(f"权威 Node 知识库不可用: {e}") from e
            print(f"[知识库] SQLite 加载失败: {e}")
        # 兜底: 使用默认数据
        if not self.items:
            self.items = DEFAULT_KNOWLEDGE
            print(f"[知识库] 使用默认数据 {len(self.items)} 条")

        # 构建 BM25 索引
        self._build_bm25()

        # 启动时加载 Embedding
        self._ensure_embeddings()

    def _build_bm25(self) -> None:
        """构建 BM25 索引"""
        self._corpus = []
        for item in self.items:
            # jieba 分词
            tokens = list(jieba.cut(f"{item.question} {' '.join(item.keywords)}"))
            tokens = [t.strip() for t in tokens if t.strip()]
            self._corpus.append(tokens)
        self.bm25 = BM25Okapi(self._corpus)

    def _ensure_embeddings(self) -> None:
        """异步计算缺失的 embedding"""
        missing = [item for item in self.items if not item.embedding]
        if not missing:
            self._embeddings_ready = True
            return
        print(f"[知识库] 异步计算 {len(missing)} 条 embedding...")
        emb = DeepSeekEmbeddings()
        for item in missing:
            vec = emb._embed(item.question)
            if vec:
                item.embedding = vec
        self._embeddings_ready = True
        print("[知识库] Embedding 计算完成")

    # ============ 检索方法 ============

    def search_bm25(self, query: str, top_k: int = 10) -> List[Dict[str, Any]]:
        """BM25 关键词检索（带 jieba 中文分词 + 停用词/单字过滤）"""
        if not self.bm25 or not query.strip():
            return []
        tokens = _filter_tokens(jieba.cut(query))
        if not tokens:
            return []
        scores = self.bm25.get_scores(tokens)
        results = []
        for idx, score in enumerate(scores):
            if score > 0:
                results.append({
                    "id": self.items[idx].id,
                    "question": self.items[idx].question,
                    "answer": self.items[idx].answer,
                    "keywords": self.items[idx].keywords,
                    "score": round(float(score), 4),
                    "source": "bm25",
                })
        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:top_k]

    def search_semantic(self, query: str, top_k: int = 5, threshold: float = 0.45) -> List[Dict[str, Any]]:
        """向量语义检索（阈值 0.45：过滤 0.3~0.4 的无关误命中，与 Node 端对齐）"""
        items_with_emb = [item for item in self.items if item.embedding]
        if not items_with_emb:
            return []
        if not self._embeddings_ready:
            # 维度重算中，暂时跳过语义（降级到 BM25）
            return []

        emb = DeepSeekEmbeddings()
        query_vec = emb._embed(query)
        if not query_vec:
            return []

        scored = []
        for item in items_with_emb:
            sim = DeepSeekEmbeddings.cosine_similarity(query_vec, item.embedding)
            if sim > threshold:
                scored.append({
                    "id": item.id,
                    "question": item.question,
                    "answer": item.answer,
                    "keywords": item.keywords,
                    "score": round(sim, 4),
                    "source": "semantic",
                })
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:top_k]

    def search_hybrid(self, query: str, top_k: int = 3) -> List[Dict[str, Any]]:
        """混合检索: BM25 + 语义 + RRF 融合"""
        # 1. BM25
        bm25_results = self.search_bm25(query)
        # 2. 语义
        semantic_results = self.search_semantic(query)
        # 3. RRF 融合
        fused = self._rrf_fusion(bm25_results, semantic_results, k=60)
        # 4. 降级: 融合无结果则用 BM25
        if not fused and bm25_results:
            return bm25_results[:top_k]
        return fused[:top_k]

    def _rrf_fusion(self, list_a: List[Dict], list_b: List[Dict], k: int = 60) -> List[Dict]:
        """RRF 融合排序"""
        score_map: Dict[str, Dict] = {}
        for idx, item in enumerate(list_a):
            score_map[item["id"]] = {
                "id": item["id"],
                "question": item["question"],
                "answer": item["answer"],
                "keywords": item["keywords"],
                "score": 1.0 / (k + idx + 1),
                "source": item.get("source", "bm25"),
            }
        for idx, item in enumerate(list_b):
            if item["id"] in score_map:
                score_map[item["id"]]["score"] += 1.0 / (k + idx + 1)
                score_map[item["id"]]["source"] = "hybrid"
            else:
                score_map[item["id"]] = {
                    "id": item["id"],
                    "question": item["question"],
                    "answer": item["answer"],
                    "keywords": item["keywords"],
                    "score": 1.0 / (k + idx + 1),
                    "source": item.get("source", "semantic"),
                }
        return sorted(score_map.values(), key=lambda x: x["score"], reverse=True)

    def search_legacy(self, query: str) -> List[Dict[str, Any]]:
        """传统关键词匹配（词面/关键词重合——最可靠的强信号）"""
        clean_query = re.sub(r"[？?，。！!.,]", "", query).strip()
        results = []
        for item in self.items:
            score = 0
            clean_q = re.sub(r"[？?，。！!.,]", "", item.question).strip()
            if clean_q in clean_query or clean_query in clean_q:
                score += 30
            for kw in item.keywords:
                if not kw or len(kw) < 2:
                    continue  # 忽略单字/空关键词，避免弱重合误命中
                if kw in _GENERIC_KEYWORDS:
                    continue  # 忽略通用词，避免「光合作用」命中「作用」这类误报
                if kw in clean_query or clean_query in kw:
                    score += 12
            if score > 0:
                results.append({
                    "id": item.id,
                    "question": item.question,
                    "answer": item.answer,
                    "keywords": item.keywords,
                    "score": score,
                    "source": "legacy",
                })
        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:3]

    # ============ 对外接口 ============

    def search(self, query: str) -> List[Dict[str, Any]]:
        """主搜索接口（自动三级降级）"""
        try:
            hybrid = self.search_hybrid(query)
            if hybrid:
                return hybrid
        except Exception as e:
            print(f"[知识库] 混合检索失败: {e}")

        try:
            bm25 = self.search_bm25(query)
            if bm25:
                return bm25
        except Exception as e:
            print(f"[知识库] BM25 失败: {e}")

        return self.search_legacy(query)

    def get_best_match(self, query: str) -> Optional[Dict[str, Any]]:
        """获取最佳匹配（用于 AI 是否走知识库的决策）

        策略：词面优先 + 语义兜底（避免"车坏了"被语义误配到"车上东西忘拿了"）
        1. 关键词/子串强命中（legacy ≥12）→ 最可靠的词面证据，直接采纳。
        2. BM25 强命中（≥3.5）→ 词面证据，其次采纳。
        3. 语义兜底（需较高置信 ≥0.5）。
        """
        # 1) 关键词/子串强命中优先（最可靠信号，短查询也能精确命中）
        legacy = self.search_legacy(query)
        if legacy and legacy[0]["score"] >= 12:
            return legacy[0]

        # 2) BM25 强命中
        bm = self.search_bm25(query)
        if bm and bm[0]["score"] >= 3.5:
            return bm[0]

        # 3) 语义兜底（无强词面命中时，需较高置信）
        results = self.search(query)
        if not results:
            return None
        best = results[0]
        sem = self.search_semantic(query)
        raw = next((r for r in sem if r["id"] == best["id"]), None)
        if raw and raw["score"] >= 0.5:
            return best
        return None

    # ============ 批量 Embedding 更新 ============

    def compute_embeddings_for(self, item_ids: List[str]) -> None:
        """为指定条目计算 Embedding"""
        emb = DeepSeekEmbeddings()
        for item in self.items:
            if item.id in item_ids and not item.embedding:
                vec = emb._embed(item.question)
                if vec:
                    item.embedding = vec

    def reload(self) -> None:
        """重新加载知识库（配置变化时调用）"""
        self._load_knowledge()


# 全局单例
_knowledge_service: Optional[KnowledgeService] = None


def _get_kb() -> KnowledgeService:
    global _knowledge_service
    if _knowledge_service is None:
        _knowledge_service = KnowledgeService()
    return _knowledge_service
