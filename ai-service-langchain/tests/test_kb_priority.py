# -*- coding: utf-8 -*-
"""regression: 知识库答非所问修复（词面优先 + 口语关键词）

修复前："车坏了" 被 BGE 语义误配到"车上东西忘拿了"（0.59 vs 故障 0.58）。
修复后：故障条目含口语关键词"车坏"，BM25 强命中优先，返回正确故障条目。
"""
import unittest
from unittest import mock

import knowledge.retriever as kr
from knowledge.retriever import KnowledgeService, KnowledgeItem


class _FakeEmb:
    """语义上故意让 '车坏了' 更接近"忘拿"（模拟真实 BGE 误配），验证词面优先仍能纠正"""
    LOOKUP = {
        "车坏了怎么办": [1.0, 0.0, 0.0],
        "车上东西忘拿了怎么办": [0.0, 1.0, 0.0],
        "车坏了": [0.1, 0.9, 0.0],   # 余弦：忘拿=0.9 > 故障=0.1
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
    kb = KnowledgeService.__new__(KnowledgeService)
    kb.items = [
        KnowledgeItem("A", "车坏了怎么办", "故障上报答案", ["车坏", "坏了", "故障", "报修"],
                      list(_FakeEmb()._embed("车坏了怎么办"))),
        KnowledgeItem("B", "车上东西忘拿了怎么办", "遗忘答案", ["遗忘", "东西", "物品"],
                      list(_FakeEmb()._embed("车上东西忘拿了怎么办"))),
    ]
    kb._embeddings_ready = True
    kb._embeddings = None
    kb._build_bm25()
    return kb


class TestKbMismatch(unittest.TestCase):
    def setUp(self):
        self._orig = kr.DeepSeekEmbeddings
        kr.DeepSeekEmbeddings = _FakeEmb
        self.kb = _make_kb()

    def tearDown(self):
        kr.DeepSeekEmbeddings = self._orig

    def test_car_broken_prefers_lexical_fault(self):
        # 即使语义上"忘拿"更接近，词面强命中（"车坏"关键词）也应返回故障条目 A
        r = self.kb.get_best_match("车坏了")
        self.assertIsNotNone(r)
        self.assertEqual(r["id"], "A")

    def test_weak_token_does_not_trigger_match(self):
        # 无关查询（仅停用词/弱重合）→ 返回 None（走 LLM）
        r = self.kb.get_best_match("今天天气怎么样")
        self.assertIsNone(r)


if __name__ == "__main__":
    unittest.main()
