"""
FastAPI 路由 — 对话 / 流式 / 检索 / 健康检查
"""

import json
import os
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ai.chat import chat, chat_stream, clear_conversation, get_conversation_history
from knowledge.retriever import _get_kb as get_kb
from knowledge.embedding import bge_embedding
from config import load_config, get_available_provider

router = APIRouter(prefix="/api")


# ============ 数据模型 ============

class ChatRequest(BaseModel):
    conversation_id: str = Field(..., min_length=1, max_length=128)
    message: str = Field(..., min_length=1, max_length=2000)
    use_agent: bool = True


class ChatResponse(BaseModel):
    success: bool
    type: str
    answer: str
    confidence: float = 0.0
    match_question: Optional[str] = None
    provider: Optional[str] = None


# ============ 健康检查 ============

@router.get("/health")
async def health():
    from knowledge.embedding import embedding_health
    return {
        "status": "ok",
        "time": datetime.now().isoformat(),
        "embedding": embedding_health(),
    }


# ============ 配置状态 ============

@router.get("/config/status")
async def config_status():
    cfg = load_config()
    return {
        "success": True,
        "data": {
            "deepseek": {"enabled": cfg["deepseek"]["enabled"], "has_key": bool(cfg["deepseek"]["api_key"]), "model": cfg["deepseek"]["model"]},
            "zhipu": {"enabled": cfg["zhipu"]["enabled"], "has_key": bool(cfg["zhipu"]["api_key"]), "model": cfg["zhipu"]["model"]},
            "default_provider": cfg["default_provider"],
            "available_provider": get_available_provider(),
            "_debug_env": bool(os.environ.get("DEEPSEEK_API_KEY")),
        }
    }


# ============ AI 对话 ============

@router.post("/chat", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest):
    """AI 对话（非流式）"""
    try:
        result = await chat(req.conversation_id, req.message, req.use_agent)
        return ChatResponse(
            success=True,
            type=result.get("type", "ai"),
            answer=result.get("answer", ""),
            confidence=result.get("confidence", 0.0),
            match_question=result.get("match_question"),
            provider=result.get("provider"),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============ 流式对话（SSE） ============

@router.post("/chat/stream")
async def chat_stream_endpoint(req: ChatRequest):
    """AI 流式对话（SSE）"""
    async def event_generator():
        yield f"event: start\ndata: {json.dumps({'status': 'connected'})}\n\n"
        try:
            async for token in chat_stream(req.conversation_id, req.message, use_agent=req.use_agent):
                data = json.loads(token)
                if data["type"] == "token":
                    yield f"event: token\ndata: {json.dumps(data['content'])}\n\n"
                elif data["type"] == "knowledge":
                    yield f"event: knowledge\ndata: {json.dumps(data['content'])}\n\n"
                    yield f"event: end\ndata: {json.dumps({'fullContent': data['content'], 'type': 'knowledge'})}\n\n"
                    return
                elif data["type"] == "end":
                    yield f"event: end\ndata: {json.dumps({'fullContent': data['content'], 'type': data.get('source', 'ai')})}\n\n"
                    return
                elif data["type"] == "error":
                    yield f"event: error\ndata: {json.dumps(data['content'])}\n\n"
                    return
        except Exception as e:
            # 流式处理异常：发送 error 事件，避免前端无法区分断流原因
            import logging
            logging.getLogger("uvicorn.error").exception("[SSE] 流式处理异常")
            yield f"event: error\ndata: {json.dumps(f'流式处理异常: {e}')}\n\n"
            return
        # 兜底
        yield f"event: end\ndata: {json.dumps({'fullContent': '', 'type': 'fallback'})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ============ 敏感词检测 ============

from ai.sensitive import check_sensitive, batch_check


class SensitiveCheckRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


class SensitiveBatchRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=50)


@router.post("/sensitive/check")
async def sensitive_check_endpoint(req: SensitiveCheckRequest):
    """LLM 语义级敏感词检测"""
    result = await check_sensitive(req.text)
    return {"success": True, "data": result}


@router.post("/sensitive/batch-check")
async def sensitive_batch_check_endpoint(req: SensitiveBatchRequest):
    """批量检测"""
    results = await batch_check(req.texts)
    return {"success": True, "data": results}


# ============ 知识库检索 ============

@router.get("/kb/search")
async def kb_search(query: str = Query(..., description="搜索关键词")):
    """知识库检索"""
    kb = get_kb()
    results = kb.search(query)
    return {"success": True, "data": results, "total": len(results)}


@router.get("/kb/best-match")
async def kb_best_match(query: str = Query(..., description="搜索关键词")):
    """获取最佳匹配"""
    kb = get_kb()
    match = kb.get_best_match(query)
    return {"success": True, "data": match}


@router.post("/embed")
async def embed_text(req: dict):
    """BGE 文本嵌入（512 维）：供 Node 端查询向量与知识库向量对齐（API key 不可用时）"""
    text = (req or {}).get("text", "")
    if not text or not text.strip():
        return {"success": False, "error": "text 不能为空"}
    vec = bge_embedding(text.strip()[:512])
    if not vec:
        return {"success": False, "error": "embedding 计算失败"}
    return {"success": True, "data": {"embedding": vec, "dim": len(vec)}}


# ============ 对话历史 ============

@router.get("/history/{conversation_id}")
async def get_history(conversation_id: str):
    """获取对话历史"""
    history = get_conversation_history(conversation_id)
    return {"success": True, "messages": history}


@router.post("/history/{conversation_id}/clear")
async def clear_history(conversation_id: str):
    """清除对话历史"""
    clear_conversation(conversation_id)
    return {"success": True}


# ============ 知识库管理（CRUD） ============

from pydantic import Field

class KnowledgeItemIn(BaseModel):
    question: str = Field(..., min_length=1, max_length=500)
    answer: str = Field(..., min_length=1, max_length=5000)
    keywords: list[str] = []


@router.get("/kb/list")
async def kb_list():
    """列出所有知识库条目"""
    kb = get_kb()
    return {
        "success": True,
        "data": [
            {
                "id": item.id,
                "question": item.question,
                "answer": item.answer,
                "keywords": item.keywords,
            }
            for item in kb.items
        ],
        "total": len(kb.items),
    }


@router.post("/kb/reload")
async def kb_reload():
    """重新加载知识库（Node.js 侧新增/修改后调用）"""
    from knowledge.retriever import _get_kb, KnowledgeService
    import importlib
    import knowledge.retriever as kr
    importlib.reload(kr)
    new_kb = _get_kb()
    return {"success": True, "total": len(new_kb.items)}


# ============ 知识库扩写 ============

from ai.expand import expand_knowledge_item, expand_all


class ExpandRequest(BaseModel):
    question: str = Field(..., min_length=1)
    answer: str = Field(..., min_length=1)


@router.post("/kb/expand")
async def kb_expand_endpoint(req: ExpandRequest):
    """AI 扩写一条知识库（生成同义问法+关键词+相关问题）"""
    result = await expand_knowledge_item(req.question, req.answer)
    return {"success": True, "data": result}


# ============ 情绪识别 ============

from ai.emotion import detect_emotion


class EmotionRequest(BaseModel):
    text: str = Field(..., min_length=1)


@router.post("/emotion/detect")
async def emotion_detect_endpoint(req: EmotionRequest):
    """检测用户消息情绪"""
    result = await detect_emotion(req.text)
    return {"success": True, "data": result}


# ============ 关键词提取 ============

from ai.keywords import extract_keywords, extract_keywords_batch


class KeywordRequest(BaseModel):
    text: str = Field(..., min_length=1)


@router.post("/kb/extract-keywords")
async def extract_keywords_endpoint(req: KeywordRequest):
    """从文本中提取关键词"""
    result = await extract_keywords(req.text)
    return {"success": True, "data": result}


class KeywordBatchRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=50)


@router.post("/kb/extract-keywords-batch")
async def extract_keywords_batch_endpoint(req: KeywordBatchRequest):
    """批量提取关键词"""
    results = await extract_keywords_batch(req.texts)
    return {"success": True, "data": results}
