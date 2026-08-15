# 本地 Embedding、双服务联调与 CI 设计

## 目标

移除对不存在的 DeepSeek Embedding API 的依赖，使用本机运行的 `BAAI/bge-small-zh-v1.5` 完成中文知识库向量检索；保留 DeepSeek 作为对话模型。为 Node.js 与 Python 服务的联调建立可重复测试，并在 GitHub Actions 中执行验证。真实业务资料和现有 FAQ 内容不在本次范围内。

## 现状与问题

- `knowledge/embedding.py` 把 DeepSeek 请求发往 `/embeddings`，历史日志已记录 404。
- `KnowledgeService` 在启动时给缺失条目计算向量，并在查询时使用同一类生成查询向量；旧向量可能来自 1024 维的远程服务，不能与新模型向量混用。
- Node 聊天路由把流式请求转发到 Python 服务的 `/api/chat/stream`；两服务目前没有自动化联调覆盖。
- Node 项目没有标准 `test` 脚本或 CI。

## 方案选择

采用本地 `BAAI/bge-small-zh-v1.5`，通过 `sentence-transformers` 在 CPU 上运行。

选择原因：它面向中文语义检索、无需 API Key，并以 MIT 许可证发布。相较于临时免费云端额度，它不引入服务商账户、配额或密钥管理；相较于仅保留 BM25，它能恢复语义召回能力。

## 架构与数据流

1. Python 服务启动时加载本地 SentenceTransformer 模型，向外提供 `embed_documents` 和 `embed_query`。
2. 知识库加载后，检查已持久化向量的维度及 Embedding 模型标识。只要有旧维度或旧模型标识，就清除所有旧向量并统一重建。
3. 文档向量与查询向量均由同一个本地模型生成；语义结果继续与 BM25 通过现有 RRF 合并。
4. Python 健康端点返回 Embedding 状态（模型名、维度、是否已就绪），不返回任何密钥或用户数据。
5. Node 继续通过 `LANGCHAIN_SERVICE_URL` 调用 Python。其健康检查将验证 Python 的状态，并在服务不可用时输出可读错误。

## 错误与降级

- 模型未下载、加载失败或向量重建失败时，Python 服务健康状态为降级；查询只返回 BM25/传统关键词结果，不能伪造语义检索成功。
- Node 无法连接 Python 时，聊天接口保持现有的错误处理与人工兜底，不泄露底层异常细节给访客。
- 不使用 OpenAI、智谱或其他 Embedding API，也不新增 API Key。

## 测试策略

测试不下载真实模型，也不访问互联网或外部 AI 服务。

- Python 单元测试：通过可注入的轻量假编码器验证查询/文档向量一致性、旧向量清除重建、加载失败时的 BM25 降级和健康状态。
- Node 单元测试：验证 LangChain 客户端的 URL、请求体和 Python 不可用时的错误信息。
- 双服务集成测试：启动 Python 测试服务和 Node 测试实例，验证健康检查、SSE 事件转发以及知识命中回答。
- 所有测试均使用临时 SQLite 数据库，不写入现有 `server/data/service.db`。

## CI/CD 与发布检查

GitHub Actions 在 push 和 pull request 时运行：Python 测试、Node 测试、JavaScript/Python 语法检查及 Docker Compose 构建。工作流不需要任何生产密钥。

发布采用手动触发的 GitHub Actions：先执行相同测试与构建，再生成可追溯的构建摘要；不自动部署，不接触生产数据或真实业务知识库。

## 验收标准

- 不再向 DeepSeek 发送 `/embeddings` 请求。
- 在本地模型可用时，知识库能够生成同维度向量并完成语义检索。
- 旧向量不会参与新模型的相似度计算。
- 本地模型不可用时，健康接口明确报告降级，BM25 仍可用。
- Node 与 Python 的健康、流式聊天和知识命中测试可重复通过。
- GitHub Actions 在无任何 API Key 的环境中通过。
