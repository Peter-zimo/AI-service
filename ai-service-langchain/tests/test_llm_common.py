# -*- coding: utf-8 -*-
"""回归测试：ai/ 辅助模块收敛到 llm_common 后行为不变。

覆盖：
- parse_json_loose：裸 JSON、```json 围栏、``` 裸围栏、空白，与原逐字逻辑一致
- make_llm：无 provider 返回 None；有 provider 时把 temperature/max_tokens 透传
- 四个模块 _get_llm 委托：参数（temperature/max_tokens）与收敛前一致
"""
import unittest
from unittest import mock

import ai.llm_common as common
from ai.llm_common import make_llm, parse_json_loose


class TestParseJsonLoose(unittest.TestCase):
    def test_bare_json(self):
        self.assertEqual(parse_json_loose('{"a": 1}'), {"a": 1})

    def test_json_fence(self):
        self.assertEqual(parse_json_loose('```json\n{"a": 1}\n```'), {"a": 1})

    def test_plain_fence(self):
        self.assertEqual(parse_json_loose('```\n{"a": 1}\n```'), {"a": 1})

    def test_surrounding_whitespace(self):
        self.assertEqual(parse_json_loose('  {"a": 1}  '), {"a": 1})

    def test_invalid_raises(self):
        with self.assertRaises(Exception):
            parse_json_loose("不是 JSON")


class TestMakeLlm(unittest.TestCase):
    def test_no_provider_returns_none(self):
        with mock.patch.object(common, "get_available_provider", return_value=None):
            self.assertIsNone(make_llm(temperature=0.1, max_tokens=80))

    def test_params_are_forwarded(self):
        captured = {}
        fake_chat = mock.Mock(side_effect=lambda **kw: captured.update(kw) or "LLM")

        with mock.patch.object(common, "get_available_provider", return_value="deepseek"), \
             mock.patch.object(common, "get_provider_config",
                               return_value={"model": "m", "api_key": "k", "base_url": "u"}), \
             mock.patch.dict("sys.modules", {"langchain_openai": mock.Mock(ChatOpenAI=fake_chat)}):
            result = make_llm(temperature=0.3, max_tokens=500)

        self.assertEqual(result, "LLM")
        self.assertEqual(captured["temperature"], 0.3)
        self.assertEqual(captured["max_tokens"], 500)
        self.assertEqual(captured["model"], "m")


class TestDelegatedGetLlmParams(unittest.TestCase):
    """确保四个模块的 _get_llm 委托参数与收敛前逐字一致。"""

    def _assert_delegates(self, module_name, expected_temp, expected_max):
        mod = __import__(f"ai.{module_name}", fromlist=["_get_llm"])
        with mock.patch.object(mod, "make_llm", return_value="X") as m:
            result = mod._get_llm()
        m.assert_called_once_with(temperature=expected_temp, max_tokens=expected_max)
        self.assertEqual(result, "X")

    def test_emotion_params(self):
        self._assert_delegates("emotion", 0.1, 80)

    def test_keywords_params(self):
        self._assert_delegates("keywords", 0.1, 100)

    def test_expand_params(self):
        self._assert_delegates("expand", 0.3, 500)

    def test_sensitive_params(self):
        self._assert_delegates("sensitive", 0.1, 100)


if __name__ == "__main__":
    unittest.main()
