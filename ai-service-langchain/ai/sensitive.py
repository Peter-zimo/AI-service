"""
LLM 语义级敏感词检测
替代 Node.js 端的关键词匹配，减少误杀
"""

from __future__ import annotations

import json
from typing import Optional

from config import load_config, get_available_provider, get_provider_config

_LOCAL_HIGH_RISK_TERMS = ("毒品", "赌博", "诈骗", "恐吓", "炸弹", "枪支")


def local_sensitive_fallback(text: str) -> dict:
    """Deterministic safety floor used when semantic moderation is unavailable."""
    matched = next((term for term in _LOCAL_HIGH_RISK_TERMS if term in (text or "")), None)
    if matched:
        return {"has_sensitive": True, "reason": f"本地规则命中：{matched}", "risk_level": "high"}
    return {"has_sensitive": False, "reason": "本地规则未命中", "risk_level": "none"}


def _get_llm() -> Optional[object]:
    """获取 LLM 实例"""
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


async def check_sensitive(text: str) -> dict:
    """
    用 LLM 判断文本是否包含敏感内容
    返回: {"has_sensitive": bool, "reason": str, "risk_level": str}
    """
    llm = _get_llm()
    if not llm:
        return local_sensitive_fallback(text)

    prompt = f"""你是一个内容安全审查员。判断以下文本是否包含违规内容：

违规类型包括：
1. 政治敏感（领导人攻击、分裂言论等）
2. 色情低俗（露骨性描写等）
3. 暴力威胁（人身攻击、恐吓等）
4. 违法信息（赌博、毒品、诈骗等）

正常业务讨论如"微信支付"、"支付宝"、"退款"、"扫码"、"投诉"等属于正常内容，不是敏感词。
仅回复 JSON 格式（不要任何其他文字）：
{{"has_sensitive": false/true, "reason": "判断原因", "risk_level": "none/low/high"}}

文本: {text}"""

    try:
        response = await llm.ainvoke(prompt)
        content = response.content.strip()
        # 提取 JSON
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
        result = json.loads(content)
        return {
            "has_sensitive": bool(result.get("has_sensitive", False)),
            "reason": str(result.get("reason", "")),
            "risk_level": str(result.get("risk_level", "none")),
        }
    except Exception as e:
        print(f"[敏感检测] LLM 判断失败: {e}")
        return local_sensitive_fallback(text)


async def batch_check(texts: list[str]) -> list[dict]:
    """批量检测"""
    results = []
    for text in texts:
        r = await check_sensitive(text)
        results.append(r)
    return results
