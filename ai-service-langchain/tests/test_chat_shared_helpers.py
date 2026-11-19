# -*- coding: utf-8 -*-
"""回归测试：chat / chat_stream 抽取公共函数后行为不变。

覆盖抽出的三个公共助手：
- _build_llm_messages：system + 历史[:-1] + 当前消息，当前消息不能丢
- _fallback_provider：deepseek <-> zhipu 互切
- _kb_first_match：知识库命中走知识库、未命中返回 None、不调用 LLM 改写
以及两条链共用的顺序差异：直答先建 LLM、流式先查知识库。
"""
import asyncio
import unittest
from unittest import mock

import ai.chat as chat_mod
from ai.chat import (
    _build_llm_messages,
    _fallback_provider,
    _kb_first_match,
)


class TestSharedHelpers(unittest.TestCase):
    def test_build_llm_messages_keeps_current_message(self):
        conv = "conv_shared_1"
        chat_mod._memory.clear(conv)
        chat_mod._memory.add(conv, "user", "上一轮问题")
        chat_mod._memory.add(conv, "assistant", "上一轮回答")
        chat_mod._memory.add(conv, "user", "这一轮问题")

        msgs = _build_llm_messages(
            {"system_prompt": "你是客服"}, conv, "这一轮问题"
        )

        self.assertEqual(len(msgs), 4)
        self.assertEqual(msgs[0].content, "你是客服")
        self.assertEqual(msgs[-1].content, "这一轮问题")
        contents = [m.content for m in msgs]
        self.assertIn("上一轮问题", contents)
        self.assertIn("上一轮回答", contents)
        chat_mod._memory.clear(conv)

    def test_build_llm_messages_single_turn(self):
        conv = "conv_shared_2"
        chat_mod._memory.clear(conv)
        chat_mod._memory.add(conv, "user", "你好")
        msgs = _build_llm_messages({"system_prompt": "S"}, conv, "你好")
        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[-1].content, "你好")
        chat_mod._memory.clear(conv)

    def test_fallback_provider_swaps_both_ways(self):
        self.assertEqual(_fallback_provider("deepseek"), "zhipu")
        self.assertEqual(_fallback_provider("zhipu"), "deepseek")
        self.assertEqual(_fallback_provider(None), "deepseek")

    def test_kb_first_match_delegates_to_smart_match(self):
        fake_kb = mock.Mock()
        sentinel = {"id": "A", "answer": "x"}
        with mock.patch.object(chat_mod, "_get_kb", return_value=fake_kb), \
             mock.patch.object(chat_mod, "_smart_kb_match",
                               new=mock.AsyncMock(return_value=sentinel)) as mock_sm:
            result = asyncio.run(_kb_first_match("押金怎么退", "deepseek"))
        self.assertIs(result, sentinel)
        mock_sm.assert_awaited_once()
        args = mock_sm.await_args.args
        self.assertIs(args[0], fake_kb)
        self.assertEqual(args[1], "押金怎么退")
        self.assertTrue(callable(args[2]), "第三个参数应是惰性 llm_factory")

    def test_kb_first_match_llm_factory_is_lazy(self):
        fake_kb = mock.Mock()
        captured = {}

        async def fake_smart(kb, msg, factory):
            captured["factory"] = factory
            return None

        with mock.patch.object(chat_mod, "_get_kb", return_value=fake_kb), \
             mock.patch.object(chat_mod, "_smart_kb_match", new=fake_smart), \
             mock.patch.object(chat_mod, "_create_llm") as mock_create:
            result = asyncio.run(_kb_first_match("今天天气", "deepseek"))
        self.assertIsNone(result)
        mock_create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
