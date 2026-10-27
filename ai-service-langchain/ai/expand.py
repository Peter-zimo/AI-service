"""
知识库扩写模块
用 LLM 自动为知识库条目生成同义问法和关键词
"""

from __future__ import annotations

import json
from typing import Optional

from config import load_config, get_available_provider, get_provider_config


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
        temperature=0.3,
        max_tokens=500,
    )


async def expand_knowledge_item(question: str, answer: str) -> dict:
    """
    为一条知识库条目扩写
    返回: { synonyms: [同义问法], keywords: [关键词], related_topics: [相关问题] }
    """
    llm = _get_llm()
    if not llm:
        return {"synonyms": [], "keywords": [], "related_topics": []}

    prompt = f"""你是一个知识库优化专家。分析以下问答条目，输出扩展内容。

问题: {question}
答案: {answer}

请输出 JSON 格式（不要任何其他文字）：
{{
  "synonyms": ["用户可能用的其他问法，至少3个"],
  "keywords": ["从问题和答案中提取的关键词，5-8个"],
  "related_topics": ["与这个条目相关的其他问题，至少2个"]
}}
"""

    try:
        response = await llm.ainvoke(prompt)
        content = response.content.strip()
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
        result = json.loads(content)
        return {
            "synonyms": result.get("synonyms", [])[:6],
            "keywords": result.get("keywords", [])[:10],
            "related_topics": result.get("related_topics", [])[:4],
        }
    except Exception as e:
        print(f"[知识库扩写] 失败: {e}")
        return {"synonyms": [], "keywords": [], "related_topics": []}


async def expand_all(items: list[dict]) -> list[dict]:
    """批量扩写"""
    results = []
    for item in items:
        r = await expand_knowledge_item(item.get("question", ""), item.get("answer", ""))
        results.append({"id": item.get("id"), "expand": r})
    return results
