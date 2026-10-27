# -*- coding: utf-8 -*-
"""regression tests for H1: async tool must be awaited in Agent loop (not sync .invoke)

旧代码 `tool_fn.invoke(tool_args)` 对 async 工具（detect_user_emotion）抛
NotImplementedError，情绪识别工具 100% 失效。本测试验证 async 工具在 Agent
循环中被正确异步调用。
"""
import asyncio
import unittest
from unittest import mock

import ai.chat as chat_mod
from ai.chat import _agent_chat


class _FakeResp:
    def __init__(self, tool_calls=None, content=""):
        self.tool_calls = tool_calls or []
        self.content = content


class _FakeLLM:
    """第一轮返回工具调用，第二轮返回最终回答"""
    def __init__(self):
        self.round = 0

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages):
        self.round += 1
        if self.round == 1:
            return _FakeResp([{"name": "detect_user_emotion", "args": {"text": "用户很生气"}, "id": "call_1"}])
        return _FakeResp([], content="好的，已为您转接人工客服。")


class TestAgentChatAsyncTool(unittest.TestCase):
    def setUp(self):
        self._p1 = mock.patch.object(chat_mod, "_create_llm")
        self._p2 = mock.patch.object(chat_mod, "get_available_provider")
        self.mock_create = self._p1.start()
        self.mock_provider = self._p2.start()
        self.mock_provider.return_value = "deepseek"

    def tearDown(self):
        self._p1.stop()
        self._p2.stop()

    def test_async_tool_is_awaited(self):
        calls = {"n": 0}
        real_emotion = chat_mod.detect_user_emotion

        # 用假工具替代 async 工具：ainvoke 生效、invoke 抛错（模拟旧代码的失败）
        fake_tool = mock.Mock()
        fake_tool.name = "detect_user_emotion"
        fake_tool.invoke.side_effect = RuntimeError("sync invoke 不应被调用")
        async def fake_ainvoke(args):
            calls["n"] += 1
            return "用户情绪: 愤怒(9分)。建议转人工。"
        fake_tool.ainvoke = fake_ainvoke

        fake_llm = _FakeLLM()
        self.mock_create.return_value = fake_llm

        with mock.patch.object(chat_mod, "detect_user_emotion", fake_tool):
            r = asyncio.run(_agent_chat("conv_h1", "我很生气", "deepseek"))

        # async 工具应被真正执行一次
        self.assertEqual(calls["n"], 1)
        self.assertEqual(r["type"], "ai")
        self.assertEqual(r["answer"], "好的，已为您转接人工客服。")


if __name__ == "__main__":
    unittest.main()
