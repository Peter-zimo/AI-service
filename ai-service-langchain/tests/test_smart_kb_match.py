# -*- coding: utf-8 -*-
"""regression tests for _smart_kb_match LLM-rewrite removal (false-positive fix)

早期 _smart_kb_match 会在 get_best_match 未命中时用 LLM 改写问题再检索，
导致无关查询（如'今天天气怎么样'）被改写成'今天天气如何'后误命中
'客服工作时间'等无关知识。本测试验证：
- 无关查询返回 None，且不再调用 LLM 改写
- 高置信查询仍能命中
"""
import asyncio
import unittest

import knowledge.retriever as kr
from knowledge.retriever import KnowledgeService, KnowledgeItem
from ai.chat import _smart_kb_match


class _FakeEmb:
    LOOKUP = {
        "押金怎么退": [1.0, 0.0, 0.0],
        "押金不退了": [-1.0, 0.0, 0.0],
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
    kb = KnowledgeService.__new__(KnowledgeService)
    kb.items = [
        KnowledgeItem("X", "押金怎么退", "押金答案", ["押金", "退"], list(_FakeEmb()._embed("押金怎么退"))),
        KnowledgeItem("W", "押金不退了", "不退款答案", ["押金"], list(_FakeEmb()._embed("押金不退了"))),
    ]
    kb._embeddings_ready = True
    kb._embeddings = None
    kb._build_bm25()
    return kb


class TestSmartKbMatch(unittest.TestCase):
    def setUp(self):
        self._orig = kr.DeepSeekEmbeddings
        kr.DeepSeekEmbeddings = _FakeEmb
        self.kb = _make_kb()

    def tearDown(self):
        kr.DeepSeekEmbeddings = self._orig

    def test_unrelated_returns_none_without_llm_rewrite(self):
        called = {"n": 0}

        def llm_factory():
            called["n"] += 1
            return object()

        r = asyncio.run(_smart_kb_match(self.kb, "今天天气怎么样", llm_factory))
        self.assertIsNone(r)
        # 修复后不再调用 LLM 改写，杜绝改写导致的误报
        self.assertEqual(called["n"], 0)

    def test_confident_query_still_matches(self):
        r = asyncio.run(_smart_kb_match(self.kb, "押金怎么退", lambda: object()))
        self.assertIsNotNone(r)
        self.assertEqual(r["id"], "X")


if __name__ == "__main__":
    unittest.main()
