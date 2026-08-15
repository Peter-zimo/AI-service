# LangChain 快速入门指南（从你的 AI 客服系统出发）

> 你不是从零学 LangChain，你是把 300 行手写代码替换成一个标准化框架。
> 所有概念都对应你系统里的某一段代码。

---

## 一、LangChain 是什么

一句话：**LLM 应用的乐高积木**。

你现在的 AI 客服系统是"手捏陶土"——每个模块（AI 调用、知识库检索、输出处理）都是手工搓出来的，接口不统一，扩展靠改 if-else。

LangChain 是"标准化积木"——每个模块都有标准接口（`Runnable` 协议），积木用管道符 `|` 连接，插拔即用，不用改上下文。

**你系统里对应什么**：`ai.js` 的 `streamChatWithAI()` 方法就是你手工搓的积木，它做的事 = LangChain 的 Chain + prompt template + output parser 的集合体。

---

## 二、5 分钟掌握核心概念

### 2.1 Models — 模型封装

**你现在的写法**（`ai.js:306`）：
```javascript
const response = await axios.post(
  `${config.baseURL}/chat/completions`,
  { model, messages, stream: true },
  { headers: { Authorization: `Bearer ${config.apiKey}` } }
);
```

**LangChain 写法**：
```python
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="deepseek-chat", api_key="...", base_url="...")
llm.invoke("你好")  # 一行搞定
```

**优势**：LangChain 封装了 100+ 模型（DeepSeek/智谱/Gemini/Claude/Ollama 本地），接口完全一致。切换模型只需改模型名，不用改调用代码。

---

### 2.2 Prompt Templates — 模板引擎

**你现在的写法**（`ai.js:296`）：
```javascript
const messages = [
  { role: 'system', content: systemPrompt },
  ...history.map(h => ({ role: h.role, content: h.content })),
  { role: 'user', content: userMessage }
];
```

**LangChain 写法**：
```python
from langchain_core.prompts import ChatPromptTemplate
prompt = ChatPromptTemplate.from_messages([
    ("system", "你是{name}，回答{context}相关的问题"),
    ("user", "{question}")
])
prompt.invoke({"name": "智能客服", "context": "共享单车", "question": "怎么开锁"})
# 自动拼装成 messages 数组
```

**优势**：模板可以单独管理、复用、版本控制。你现在的 systemPrompt 是硬编码在 JS 文件里的，改一次要重启服务。

---

### 2.3 Output Parsers — 输出解析

**你现在的写法**（散落在各处）：
```javascript
const token = parsed.choices?.[0]?.delta?.content || '';
const source = aiSensitiveCheck.hasSensitive ? 'fallback' : 'ai';
```

**LangChain 写法**：
```python
from langchain_core.output_parsers import StrOutputParser
from langchain_core.pydantic_v1 import BaseModel

class Answer(BaseModel):
    content: str
    source: str  # "knowledge" | "ai" | "fallback"
    confidence: float

parser = PydanticOutputParser(pydantic_object=Answer)
```

**优势**：用 Pydantic 定义输出结构，LangChain 自动让 LLM 输出 JSON 并帮你校验。不用手写 `JSON.parse` + `try-catch`。

---

### 2.4 LCEL — 管道语言（LangChain 的精髓）

```python
# 把上面的积木用 | 串起来
chain = prompt | llm | parser

# 调用
result = chain.invoke({"question": "怎么开锁"})
# ↑ 等于执行了：prompt.invoke → llm.invoke → parser.invoke
```

| 操作符 | 意义 | 你系统的对应 |
|--------|------|-------------|
| `prompt \| llm` | prompt 输出 → llm 输入 | `拼装 messages → axios.post` |
| `llm \| parser` | llm 输出 → parser 结构化 | `token 累加 → finalizeStreamBubble` |
| `{"key": value} \| chain` | 字典作为输入 | 无对应，你靠参数传递 |

**关键理解**：LCEL 中的 `|` 就是 Unix 管道——上一个命令的输出就是下一个命令的输入。

---

### 2.5 RAG — 检索增强生成（你的 knowledge.js）

**你现在的写法**：
```javascript
// 1. FTS5 检索
const ftsResults = ftsStmt.all(query);
// 2. Embedding 语义检索
const semanticResults = computeEmbedding(query);
// 3. RRF 融合
const merged = rrfMerge(ftsResults, semanticResults);
// 4. 取最佳匹配
if (merged.length > 0) return merged[0];
```

**LangChain 写法**：
```python
from langchain_community.vectorstores import Chroma
from langchain_core.runnables import RunnablePassthrough

# 1-2 行：加载文档 + 分割 + 存入向量库
vectorstore = Chroma.from_documents(docs, embedding=DeepSeekEmbeddings())

# 3-4 行：构建检索链
retriever = vectorstore.as_retriever(search_kwargs={"k": 5})
chain = (
    {"context": retriever, "question": RunnablePassthrough()}
    | prompt | llm | StrOutputParser()
)
chain.invoke("怎么开锁")  # 自动检索+回答
```

**优势**：
- 你手写的 FTS5 + Embedding + RRF 共约 80 行，LangChain 约 4 行
- 你还需要处理 Embedding API 不可用时的降级逻辑，LangChain 每个组件都有优雅降级
- 你想切换向量库（从 SQLite 到 Chroma/FAISS/Pinecone），改一行配置就行

---

### 2.6 Agent — 智能体（LangChain 最核心的能力）

这是你当前系统**完全没有**的能力，也是 LangChain 最大的价值。

**你现在的做法**：if-else 判断流（chat.js 的 /message 路由）：
```
if (知识库匹配) → 返回知识答案
else if (AI可用) → streamChatWithAI()
else → 兜底回复
```

**LangChain Agent 的做法**：让 LLM 自己决定调用什么工具。
```
Agent 收到"怎么开锁"
→ LLM 判断：需要查知识库 → 调用 retriever 工具
→ 返回结果
↓
Agent 收到"我要退款"
→ LLM 判断：需要查账户 + 调用支付系统 → 调用两个工具
→ 整合结果返回
↓
Agent 收到"转人工"
→ LLM 判断：需要转接 → 调用 transfer_to_human 工具
→ 完成转接
```

**你手写 vs Agent**：

| 场景 | 你手写 | LangChain Agent |
|------|--------|----------------|
| 加一个新功能 | 改 if-else / 加 case | 注册一个新工具（一行代码） |
| 用户说含混问题 | 匹配不到，走兜底 | Agent 会 ask clarifying question |
| 多步推理 | 不支持，只能单次 | 支持 Chain-of-Thought 多步 |
| 工具组合 | 固定顺序 | Agent 自主选择，动态编排 |

---

## 三、实战：用 LangChain 重写你的客服系统

### 3.1 安装

```bash
pip install langchain langchain-community langchain-openai langchain-chroma
```

### 3.2 完整代码（替换 ai.js + knowledge.js 的功能）

```python
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnablePassthrough
from langchain_community.vectorstores import Chroma
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import TextLoader
from langchain.tools import tool
from langchain.agents import create_tool_calling_agent, AgentExecutor

# ========== 1. 模型 ==========
llm = ChatOpenAI(
    model="deepseek-chat",
    openai_api_key="sk-xxx",
    openai_api_base="https://api.deepseek.com/v1",
    streaming=True
)

# ========== 2. 知识库（RAG）==========
loader = TextLoader("knowledge_base.txt")
docs = loader.load()
splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=80)
chunks = splitter.split_documents(docs)
vectorstore = Chroma.from_documents(chunks, OpenAIEmbeddings())
retriever = vectorstore.as_retriever(search_kwargs={"k": 5})

# ========== 3. Prompt ==========
prompt = ChatPromptTemplate.from_messages([
    ("system", "你是一个共享单车客服，根据知识库回答。\n知识库：{context}"),
    ("user", "{question}")
])

# ========== 4. RAG Chain ==========
rag_chain = (
    {"context": retriever, "question": RunnablePassthrough()}
    | prompt | llm | StrOutputParser()
)

# ========== 5. 自定义工具（Agent）==========
@tool
def search_knowledge_base(query: str) -> str:
    """查知识库中的常见问题和答案"""
    return retriever.invoke(query)

@tool
def transfer_to_human(reason: str) -> str:
    """将用户转接到人工客服"""
    # 调用你现有的 humanService.requestHuman()
    return "已转接人工，请稍候"

@tool
def get_order_info(order_id: str) -> dict:
    """查询订单信息"""
    # 调用你的数据库查询
    return {"status": "已支付", "amount": 2.5}

# ========== 6. Agent ==========
agent = create_tool_calling_agent(
    llm=llm,
    tools=[search_knowledge_base, transfer_to_human, get_order_info],
    prompt=ChatPromptTemplate.from_messages([
        ("system", "你是共享单车客服Agent，用工具帮用户解决问题"),
        ("user", "{input}"),
        ("agent_scratchpad", "{agent_scratchpad}")
    ])
)
agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

# ========== 7. 使用 ==========
# RAG 模式
result = rag_chain.invoke("怎么扫码开锁")
print(result)

# Agent 模式（自动判断用哪个工具）
result = agent_executor.invoke({"input": "我要退款，订单号是ABC123"})
print(result["output"])
```

### 3.3 迁移路线图

| 阶段 | 内容 | 工作量 |
|------|------|--------|
| 第1天 | 搭建 Python + LangChain 环境，跑通 RAG Chain | 2h |
| 第2天 | 用 LangChain 重写 knowledge.js 的检索逻辑 | 4h |
| 第3天 | 替换 ai.js 的流式调用为 LangChain streaming | 4h |
| 第4天 | 接入 Agent，用 tool-calling 替代 chat.js 的 if-else | 4h |
| 第5天 | 性能对比 + 写总结 | 2h |

---

## 四、学习资源优先级

| 资源 | 地址 | 时间 | 学什么 |
|------|------|------|--------|
| LangChain 官方教程 | python.langchain.com/docs/tutorials/ | 2h | Quickstart + RAG |
| Learn LangChain with DeepSeek | 搜索"langchain deepseek 实践" | 1h | 便宜好用 |
| AI Agent 实战视频 | YouTube "LangGraph Agent" | 2h | Agent 核心概念 |
| 你的 knowledge.js | 对照上文代码逐行读 | 30min | 理解手写→LCEL 映射 |

---

## 五、常见问题

**Q: Node.js 项目怎么用 LangChain？**
A: LangChain 有 JS 版（`langchain` npm 包），API 几乎一样。但生态不如 Python 版成熟，建议先用 Python 理解，再考虑是否迁移 JS。

**Q: 学习 LangChain 对求职有什么帮助？**
A: 2026 年 AI 应用岗的面试题里，80% 会问 LangChain 或 Agent。能把 LangChain 和你自己写的客服系统做对比，是面试中的"超加分项"——证明你既懂框架，也懂底层。

**Q: 只学 LangChain 够吗？**
A: 不够。LangChain 是"入门工具"，更深的是 LangGraph（多 Agent 编排）和 LangSmith（监控调优）。学完基础后，按这个路线：Chain → Tools → Agent → LangGraph。
