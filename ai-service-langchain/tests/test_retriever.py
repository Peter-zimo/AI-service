# -*- coding: utf-8 -*-
"""regression tests for knowledge retrieval false-positive fix (Task 1)

使用受控的内存知识库 + 注入的确定性 embedding，验证 get_best_match 的置信门控：
- 无关/低置信查询（语义相似度 0.3~0.45 区间）必须返回 None（不再误放行）
- 高置信合法查询必须返回对应条目
"""
import unittest

import knowledge.retriever as kr
from knowledge.retriever import KnowledgeService, KnowledgeItem


class _FakeEmb:
    """确定性 embedding：根据文本返回固定向量，便于精确控制余弦相似度"""
    LOOKUP = {
        "押金怎么退": [1.0, 0.0, 0.0],
        "押金不退了": [-1.0, 0.0, 0.0],
        # 与 X(押金怎么退) 相似度 = 0.4（落在 0.35~0.45 误报区间）
        "今天天气怎么样": [0.4, 0.916515138991168, 0.0],
    }

    def __init__(self, provider="deepseek"):
        self.provider = provider

    @staticmethod
    def cosine_similarity(a, b):
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        na = sum(x * x for x in a) ** 0.5
        nb = sum(y * y for y in b) ** 0.5
        return dot / (na * nb) if na * nb > 0 else 0.0

    def _embed(self, text):
        return list(self.LOOKUP.get(str(text).strip()[:512], [0.0, 0.0, 0.0]))


def _make_kb():
    """构造受控知识库（跳过 __init__ 的 DB 加载）"""
    kb = KnowledgeService.__new__(KnowledgeService)
    kb.items = [
        KnowledgeItem("X", "押金怎么退", "押金答案", ["押金", "退"], list(_FakeEmb()._embed("押金怎么退"))),
        KnowledgeItem("W", "押金不退了", "不退款答案", ["押金"], list(_FakeEmb()._embed("押金不退了"))),
    ]
    kb._embeddings_ready = True
    kb._embeddings = None
    kb._build_bm25()
    return kb


class TestGetBestMatch(unittest.TestCase):
    def setUp(self):
        self._orig = kr.DeepSeekEmbeddings
        kr.DeepSeekEmbeddings = _FakeEmb
        self.kb = _make_kb()

    def tearDown(self):
        kr.DeepSeekEmbeddings = self._orig

    def test_confident_match_returned(self):
        # 语义相似度 1.0 → 高置信，应返回条目 X
        r = self.kb.get_best_match("押金怎么退")
        self.assertIsNotNone(r)
        self.assertEqual(r["id"], "X")

    def test_low_confidence_false_positive_rejected(self):
        # 语义相似度 0.4（旧阈值 0.35 会误放行）→ 新阈值 0.45 必须拒绝，返回 None
        # 该查询与 X 相似度 0.4、与 W 相似度 -0.4，均低于 0.45
        self.assertIsNone(self.kb.get_best_match("今天天气怎么样"))

    def test_no_semantic_when_not_ready(self):
        self.kb._embeddings_ready = False
        self.assertIsNone(self.kb.get_best_match("今天天气怎么样"))


if __name__ == "__main__":
    unittest.main()
