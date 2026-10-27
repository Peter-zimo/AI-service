"""
AI Service — LangChain 独立服务入口
启动方式: python main.py
"""

import logging
import os
import threading

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import load_config
from routers.api import router as api_router
from security import verify_internal_token

# 初始化：加载配置 + 知识库
load_config(force=True)

app = FastAPI(
    title="AI 智能客服系统 — LangChain 服务",
    version="1.0.0",
    description="基于 LangChain + FastAPI 的 AI 客服后端服务",
)

# Python 服务仅供 Node 内部调用，不允许浏览器跨域访问。
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type", "X-Internal-Service-Token"],
)


@app.middleware("http")
async def require_internal_service_token(request: Request, call_next):
    request_id = (request.headers.get("X-Request-Id") or "-")[:128]
    request.state.request_id = request_id

    configured_token = os.environ.get("AI_SERVICE_TOKEN", "").strip()
    received_token = request.headers.get("X-Internal-Service-Token")
    if not verify_internal_token(request.url.path, received_token, configured_token):
        logging.getLogger("uvicorn.error").warning(
            "[rid=%s] 拒绝未授权调用 %s %s", request_id, request.method, request.url.path
        )
        return JSONResponse(status_code=401, content={"success": False, "error": "未授权的内部服务调用"})

    # AI 关键路径打一条带 requestId 的日志，便于与 Node 侧串联
    if request.url.path.startswith(("/api/chat", "/api/sensitive")):
        logging.getLogger("uvicorn.error").info(
            "[rid=%s] %s %s", request_id, request.method, request.url.path
        )

    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    return response

# 注册路由
app.include_router(api_router)


@app.on_event("startup")
async def _warmup_models():
    """后台预热重型依赖，避免拖慢启动与首个请求"""
    from knowledge.embedding import preload_bge
    from knowledge.retriever import _get_kb
    from ai.chat import preload_llm

    preload_bge()
    preload_llm()
    # 预热知识库（加载 67 条 + BGE 向量重算），让首个检索不再冷启动
    threading.Thread(target=_get_kb, daemon=True).start()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000, help="监听端口")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="监听地址")
    args = parser.parse_args()

    print(f"""
╔══════════════════════════════════════════════════╗
║     AI 智能客服 LangChain 服务已启动              ║
╠══════════════════════════════════════════════════╣
║  端口: {args.port}                                 ║
║  文档: http://localhost:{args.port}/docs            ║
║  健康检查: http://localhost:{args.port}/api/health  ║
╚══════════════════════════════════════════════════╝
    """)

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
