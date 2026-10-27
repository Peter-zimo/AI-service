# AI 智能客服 LangChain 服务 — 完成概要

## 项目位置
D:\AI应用\ai-service-langchain\

## 目录结构
```
ai-service-langchain/
├── main.py                   # FastAPI 应用入口 + 启动（python main.py --port 8000）
├── config.py                 # 配置管理（.env + ai-config.json + 热更新）
├── requirements.txt          # Python 依赖
├── .env                      # API Key 配置
│
├── knowledge/
│   ├── __init__.py
│   ├── retriever.py          # 混合检索（BM25 + Embedding + RRF + 三级降级）
│   └── embedding.py          # DeepSeek/智谱 Embedding 封装
│
├── ai/
│   ├── __init__.py
│   └── chat.py               # AI对话（Agent决策 / 流式输出 / 历史管理）
│
└── routers/
    ├── __init__.py
    └── api.py                # FastAPI 路由定义
```

## 已实现的 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 ✅ |
| `/api/config/status` | GET | AI配置状态 ✅ |
| `/api/chat` | POST | AI对话（Agent/非Agent模式）✅ |
| `/api/chat/stream` | POST | 流式SSE对话 ✅ |
| `/api/kb/search` | GET | 知识库混合检索 ✅ |
| `/api/kb/best-match` | GET | 获取最佳匹配 ✅ |
| `/api/kb/list` | GET | 列出知识库全部条目 ✅ |
| `/api/history/{id}` | GET | 获取对话历史 ✅ |
| `/api/history/{id}/clear` | POST | 清除对话历史 ✅ |

## Node.js 对接方式

在 `server/routes/chat.js` 中，把 AI 调用从本地 `aiService.chat()` 改为 HTTP 调用 Python 服务：

```javascript
const AI_SERVICE = 'http://localhost:8000';

// 替换 aiService.chat()
async function callLangChain(convId, message) {
  const res = await fetch(`${AI_SERVICE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, message, use_agent: true })
  });
  return res.json();
}

// 替换 SSE 流式
// 用 EventSource 连接到 http://localhost:8000/api/chat/stream
```

## 启动方式

```bash
cd D:\AI应用\ai-service-langchain
python main.py --port 8000
# 监听 http://0.0.0.0:8000
# API文档 http://localhost:8000/docs
```
