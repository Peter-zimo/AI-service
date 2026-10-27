"""
关键词提取模块
用 LLM 从问题中智能提取关键词（替代手写 extractKeywords）
"""

from __future__ import annotations

import json
from typing import Optional

from config import get_available_provider, get_provider_config


def _get_llm() -> Optional[object]:
    provider = get_available_provider()
    if not provider:
        return None
    cfg = get_provider_config(provider)
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        model=cfg.get("model", "deepseek-chat"),
        api_key=cfg.get("api_key", ""),
        base_url=cfg.get("base_url", ""),
        temperature=0.1,
        max_tokens=100,
    )


async def extract_keywords(text: str, max_keywords: int = 8) -> list[str]:
    """
    用 LLM 从文本中提取关键词
    返回: ["关键词1", "关键词2", ...]
    """
    llm = _get_llm()
    if not llm:
        return []

    prompt = f"""从以下问题中提取最相关的搜索关键词，用于知识库检索。

要求：
- 提取名词、核心动词、业务术语
- 去除停用词（的、了、是、吗等）
- 返回纯 JSON 数组，如 ["关键词1", "关键词2", ...]
- 最多 {max_keywords} 个

问题: {text}"""

    try:
        response = await llm.ainvoke(prompt)
        content = response.content.strip()
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
        keywords = json.loads(content)
        if isinstance(keywords, list):
            return [str(k).strip() for k in keywords if k][:max_keywords]
        return []
    except Exception as e:
        print(f"[关键词提取] 失败: {e}")
        return []


async def extract_keywords_batch(texts: list[str]) -> list[list[str]]:
    """批量提取"""
    return [await extract_keywords(t) for t in texts]
