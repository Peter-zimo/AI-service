"""
情绪识别模块
用 LLM 检测用户消息中的情绪，辅助 Agent 决策
"""

from __future__ import annotations

from typing import Optional

from ai.llm_common import make_llm, parse_json_loose


def _get_llm() -> Optional[object]:
    return make_llm(temperature=0.1, max_tokens=80)


async def detect_emotion(text: str) -> dict:
    """
    检测用户情绪
    返回: {"emotion": str, "score": int, "needs_human": bool, "reason": str}
    emotion: 'positive' / 'neutral' / 'negative' / 'angry' / 'urgent'
    score: 1-10 (1=最负面, 10=最正面)
    needs_human: 是否需要转人工 (score <= 3 或 emotion 为 angry/urgent)
    """
    llm = _get_llm()
    if not llm:
        return {"emotion": "neutral", "score": 5, "needs_human": False, "reason": "AI未配置"}

    prompt = f"""分析以下用户消息的情绪。仅输出 JSON：

{{
  "emotion": "positive/neutral/negative/angry/urgent",
  "score": 数字1-10,
  "needs_human": true/false,
  "reason": "一句话判断原因"
}}

判定规则：
- score 1-3: 负面/愤怒/紧急 → needs_human: true
- score 4-6: 中性
- score 7-10: 正面

消息: {text}"""

    try:
        response = await llm.ainvoke(prompt)
        result = parse_json_loose(response.content)
        return {
            "emotion": str(result.get("emotion", "neutral")),
            "score": int(result.get("score", 5)),
            "needs_human": bool(result.get("needs_human", False)),
            "reason": str(result.get("reason", "")),
        }
    except Exception as e:
        print(f"[情绪识别] 失败: {e}")
        return {"emotion": "neutral", "score": 5, "needs_human": False, "reason": f"检测异常"}
