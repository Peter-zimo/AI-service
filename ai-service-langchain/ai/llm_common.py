"""
LLM 组件公共助手
把 ai/ 下各辅助模块重复的「构造 ChatOpenAI」与「解析 LLM 的 JSON 输出」收敛到一处。

- make_llm：按当前 provider 构造实例；无 provider 时返回 None（与各模块原行为一致）。
- parse_json_loose：容错解析 LLM 输出，兼容 ```json ... ``` 代码围栏与裸 JSON。

刻意保留每个模块各自的 _get_llm() 作为一行委托，避免改动外部 mock 锚点与模块结构。
"""

from __future__ import annotations

import json
from typing import Any, Optional

from config import get_available_provider, get_provider_config


def make_llm(temperature: float, max_tokens: int) -> Optional[Any]:
    """按当前可用 provider 构造 ChatOpenAI；无配置返回 None。"""
    provider = get_available_provider()
    if not provider:
        return None
    cfg = get_provider_config(provider)
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        model=cfg.get("model", "deepseek-chat"),
        api_key=cfg.get("api_key", ""),
        base_url=cfg.get("base_url", ""),
        temperature=temperature,
        max_tokens=max_tokens,
    )


def parse_json_loose(content: str) -> Any:
    """解析 LLM 返回的 JSON，兼容 Markdown 代码围栏。

    LLM 常返回 ```json\\n{...}\\n``` 或带前后空白的内容，这里统一剥离后解析。
    解析失败抛出异常，由调用方按各自兜底策略处理。
    """
    text = (content or "").strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text)
