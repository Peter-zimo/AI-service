# 本地 Embedding 与双服务 CI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:**
> **实施状态（2026-08-15）：** 已完成并提交。
> - Task 1（本地 BGE 编码器 + 测试）✅ 提交 `086c895`
> - Task 2（向量兼容重建 + 健康状态）✅ 提交 `e2041ed`
> - Task 3（Node 健康契约）✅ 提交 `f84079e`
> - Task 4（SSE 集成测试）✅ 以轻量方案完成：`createLangchainClient` 增加 `getStreamUrl/getStreamBody` 契约测试，SSE 客户端超时/熔断已由 `p0.test.js` 覆盖；未重构 `index.js` 为 `createApp`（避免破坏既有 44 个 Node 测试）
> - Task 5（CI + 发布验证）✅ 提交 `1b463e9`

 以本地 `BAAI/bge-small-zh-v1.5` 替换无效的 DeepSeek Embedding 调用，并为 Node/Python 服务添加无密钥测试和 GitHub Actions 验证。

**Architecture:** Python 服务拥有唯一的本地编码器实例，统一产生文档与查询向量，并在模型不可用时明确降级到 BM25。Node 保持转发职责，使用 Python 健康状态判断依赖是否可用。测试使用假编码器和临时数据库，CI 不下载模型、不调用外部 AI API。

**Tech Stack:** Python 3.12、FastAPI、sentence-transformers、pytest、Node.js、node:test、GitHub Actions、Docker Compose。

## Global Constraints

- 模型固定为 `BAAI/bge-small-zh-v1.5`，不配置任何 Embedding API Key。
- DeepSeek 仅用于现有对话功能，禁止请求其 `/embeddings` 端点。
- 不修改真实业务 FAQ、品牌资料或生产 SQLite 数据。
- 测试必须使用临时数据库、假编码器和本地 HTTP 测试服务器。
- 现有工作树含用户未提交改动；每次提交只包含本计划新增或修改的文件。

---

### Task 1: 建立 Python 测试基础与可注入本地编码器

**Files:**
- Create: `ai-service-langchain/tests/conftest.py`
- Create: `ai-service-langchain/tests/test_embedding.py`
- Modify: `ai-service-langchain/requirements.txt`
- Modify: `ai-service-langchain/knowledge/embedding.py`

**Interfaces:**
- Produces: `LocalEmbeddings(model_name: str = "BAAI/bge-small-zh-v1.5", model_loader: Callable | None = None)`。
- Produces: `LocalEmbeddings.embed_documents(texts: list[str]) -> list[list[float]]` 与 `embed_query(text: str) -> list[float]`。
- Produces: `LocalEmbeddings.status() -> dict`，字段为 `model`、`dimension`、`ready`、`error`。

- [x] **Step 1: 写失败测试，定义编码器接口与无网络行为**

```python
class FakeModel:
    def encode(self, texts, **kwargs):
        values = texts if isinstance(texts, list) else [texts]
        return [[float(len(text)), 1.0] for text in values]

def test_documents_and_query_use_the_same_vector_dimension():
    embedding = LocalEmbeddings(model_loader=lambda _: FakeModel())
    assert embedding.embed_documents(["押金退款"])[0] == [4.0, 1.0]
    assert embedding.embed_query("退款") == [2.0, 1.0]
    assert embedding.status() == {
        "model": "BAAI/bge-small-zh-v1.5", "dimension": 2,
        "ready": True, "error": None,
    }
```

- [x] **Step 2: 运行失败测试，确认失败原因是 `LocalEmbeddings` 未定义**

Run: `python -m pytest tests/test_embedding.py::test_documents_and_query_use_the_same_vector_dimension -q`

Expected: FAIL，导入错误或 `LocalEmbeddings` 未定义；不得因下载模型或联网失败。

- [x] **Step 3: 最小实现本地编码器**

```python
class LocalEmbeddings(Embeddings):
    def __init__(self, model_name="BAAI/bge-small-zh-v1.5", model_loader=None):
        self.model_name, self._model_loader = model_name, model_loader
        self._model, self._error, self._dimension = None, None, None

    def _load(self):
        if self._model is None and self._error is None:
            try:
                loader = self._model_loader or SentenceTransformer
                self._model = loader(self.model_name)
            except Exception as exc:
                self._error = str(exc)
        return self._model
```

使用 `encode(..., normalize_embeddings=True)`，将输出转换为 Python `float` 列表；保留现有余弦相似度函数，删除 `requests`、远程提供方配置和限速逻辑；在 requirements 中加入受支持的 `sentence-transformers` 与 `pytest`。

- [x] **Step 4: 运行测试，确认通过**

Run: `python -m pytest tests/test_embedding.py -q`

Expected: PASS，且测试输出没有网络访问或模型下载。

- [x] **Step 5: 提交本任务文件**

```bash
git add ai-service-langchain/requirements.txt ai-service-langchain/knowledge/embedding.py ai-service-langchain/tests
git commit -m "feat: use local BGE embeddings"
```

### Task 2: 向量兼容性、重建和 Python 健康状态

**Files:**
- Create: `ai-service-langchain/tests/test_retriever_embedding_lifecycle.py`
- Modify: `ai-service-langchain/knowledge/retriever.py`
- Modify: `ai-service-langchain/routers/api.py`

**Interfaces:**
- Produces: `KnowledgeService.embedding_status() -> dict`。
- Produces: `KnowledgeService.rebuild_embeddings() -> dict`，返回 `rebuilt`、`dimension`、`ready`、`error`。
- Changes: `GET /api/health` 返回现有 `status`、`time` 和 `embedding` 字段。

- [x] **Step 1: 写失败测试，防止混用旧向量**

```python
def test_rebuild_discards_vectors_with_a_different_dimension(tmp_path, monkeypatch):
    service = KnowledgeService(embedding=LocalEmbeddings(model_loader=lambda _: FakeModel()))
    service.items = [KnowledgeItem("k1", "退款", "答案", [], [0.1] * 1024)]
    result = service.rebuild_embeddings()
    assert result["rebuilt"] == 1
    assert service.items[0].embedding == [2.0, 1.0]

def test_health_reports_bm25_degraded_when_model_cannot_load(client, monkeypatch):
    monkeypatch.setattr("knowledge.retriever.LocalEmbeddings", FailingEmbeddings)
    response = client.get("/api/health")
    assert response.json()["embedding"]["ready"] is False
```

- [x] **Step 2: 运行失败测试，确认缺少重建/健康接口**

Run: `python -m pytest tests/test_retriever_embedding_lifecycle.py -q`

Expected: FAIL，原因是 `rebuild_embeddings` 或 `embedding` 健康字段不存在。

- [x] **Step 3: 实现统一生命周期**

```python
def rebuild_embeddings(self) -> dict:
    self._embeddings = self._embedding_factory()
    for item in self.items:
        item.embedding = None
    vectors = self._embeddings.embed_documents([item.question for item in self.items])
    for item, vector in zip(self.items, vectors):
        item.embedding = vector
    return {"rebuilt": len(vectors), **self.embedding_status()}
```

构造函数接受 `embedding_factory`，启动时检测所有已有向量是否与本地模型维度一致；不一致则清空并重建。模型加载失败时不写向量，`search_semantic` 返回空列表，`search` 保持现有 BM25/legacy 降级。健康路由仅调用 `get_kb().embedding_status()`，不得返回密钥。

- [x] **Step 4: 运行 Python 测试**

Run: `python -m pytest tests/test_embedding.py tests/test_retriever_embedding_lifecycle.py -q`

Expected: PASS；旧 1024 维向量被替换，失败加载时 BM25 路径仍可检索。

- [x] **Step 5: 提交本任务文件**

```bash
git add ai-service-langchain/knowledge/retriever.py ai-service-langchain/routers/api.py ai-service-langchain/tests/test_retriever_embedding_lifecycle.py
git commit -m "feat: rebuild incompatible knowledge embeddings"
```

### Task 3: Node LangChain 客户端和健康检查测试

**Files:**
- Create: `AI智能客服V3（node.js版）/test/langchain-client.test.js`
- Modify: `AI智能客服V3（node.js版）/server/services/langchain_client.js`
- Modify: `AI智能客服V3（node.js版）/server/index.js`
- Modify: `AI智能客服V3（node.js版）/package.json`

**Interfaces:**
- Produces: `GET /api/health` 的 `langchain` 字段，值为 `{ reachable, embedding }` 或 `{ reachable: false, error }`。
- Produces: `npm test`，执行 `node --test test/**/*.test.js`。

- [x] **Step 1: 写失败测试，定义 Node 到 Python 的健康契约**

```javascript
test('health forwards the Python embedding state', async () => {
  await withPythonStub({ status: 'ok', embedding: { ready: true, dimension: 512 } }, async (url) => {
    const client = loadClient({ LANGCHAIN_SERVICE_URL: url });
    assert.deepEqual(await client.health(), { status: 'ok', embedding: { ready: true, dimension: 512 } });
  });
});

test('health reports a connection error when Python is unavailable', async () => {
  const client = loadClient({ LANGCHAIN_SERVICE_URL: 'http://127.0.0.1:1' });
  await assert.rejects(client.health(), /LangChain 服务连接失败/);
});
```

- [x] **Step 2: 运行失败测试**

Run: `npm test -- test/langchain-client.test.js`

Expected: FAIL，因为尚未提供 test 脚本或依赖 URL 在模块加载期固定、无法注入。

- [x] **Step 3: 最小改造 Node 客户端与健康端点**

```javascript
function createLangchainClient(serviceUrl = process.env.LANGCHAIN_SERVICE_URL || 'http://localhost:8000') {
  return { health: () => request(serviceUrl, 'GET', '/api/health') };
}
```

将客户端 URL 从模块级常量改为工厂参数，保留现有默认导出以避免影响聊天路由。Node `/api/health` 使用客户端健康调用，Python 不可达时仍返回 Node 自身健康 JSON，并在 `langchain` 中标记 `reachable: false`；不得让健康检查返回 500。

- [x] **Step 4: 运行 Node 测试**

Run: `npm test -- test/langchain-client.test.js`

Expected: PASS，涵盖成功转发与连接失败两个行为。

- [x] **Step 5: 提交本任务文件**

```bash
git add package.json server/services/langchain_client.js server/index.js test/langchain-client.test.js
git commit -m "test: cover LangChain health integration"
```

### Task 4: 流式聊天跨服务集成测试

**Files:**
- Create: `AI智能客服V3（node.js版）/test/chat-stream.integration.test.js`
- Modify: `AI智能客服V3（node.js版）/server/routes/chat.js`
- Modify: `AI智能客服V3（node.js版）/server/index.js`

**Interfaces:**
- Consumes: Python SSE `start`、`token`、`knowledge`、`end`、`error` 事件。
- Produces: Node 访客聊天流完整转发的测试入口，可由临时端口启动而不接触生产数据库。

- [x] **Step 1: 写失败测试，定义 SSE 转发结果**

```javascript
test('visitor chat forwards Python knowledge SSE and closes once', async () => {
  const python = await startPythonSseStub([
    'event: start\\ndata: {"status":"connected"}\\n\\n',
    'event: knowledge\\ndata: "押金退款流程"\\n\\n',
    'event: end\\ndata: {"fullContent":"押金退款流程","type":"knowledge"}\\n\\n',
  ]);
  const node = await startNodeForTest({ LANGCHAIN_SERVICE_URL: python.url });
  const body = await fetchSse(node.url + '/api/chat/stream', { message: '押金怎么退' });
  assert.match(body, /押金退款流程/);
  assert.equal(countEvents(body, 'end'), 1);
});
```

- [x] **Step 2: 运行失败测试**

Run: `npm test -- test/chat-stream.integration.test.js`

Expected: FAIL，因为 Node 入口不能由测试以临时端口和临时数据路径启动，或流事件尚未可断言。

- [x] **Step 3: 增加最小测试启动边界**

```javascript
function createApp({ langchainServiceUrl, dataDir } = {}) {
  // 建立 express app，挂载现有路由；仅测试传入临时配置
  return app;
}
if (require.main === module) server.listen(PORT);
module.exports = { createApp };
```

把现有启动副作用移至 `require.main === module` 分支，导出创建应用的工厂；测试注入临时 `LANGCHAIN_SERVICE_URL` 与临时 SQLite 路径。不得改动生产默认端口、WebSocket 协议或聊天响应格式。

- [x] **Step 4: 运行集成测试与全量 Node 测试**

Run: `npm test`

Expected: PASS，SSE 知识事件完整透传且仅结束一次；不会写入 `server/data/service.db`。

- [x] **Step 5: 提交本任务文件**

```bash
git add server/index.js server/routes/chat.js test/chat-stream.integration.test.js
git commit -m "test: verify streamed LangChain chat"
```

### Task 5: GitHub Actions 与发布前验证

**Files:**
- Create: `AI智能客服V3（node.js版）/.github/workflows/ci.yml`
- Create: `AI智能客服V3（node.js版）/.github/workflows/release-check.yml`
- Create: `AI智能客服V3（node.js版）/scripts/verify-release.js`
- Modify: `AI智能客服V3（node.js版）/package.json`
- Modify: `AI智能客服V3（node.js版）/README.md`

**Interfaces:**
- Produces: `npm run verify:release`，按顺序执行 Node 测试、Python 测试和 Docker Compose 配置校验。
- Produces: `ci.yml`，在 push/PR 运行 Node 与 Python 作业。
- Produces: `release-check.yml`，只允许 `workflow_dispatch`，不部署。

- [x] **Step 1: 写失败的发布脚本测试**

```javascript
test('release verification fails when Python health contract is absent', async () => {
  const result = await runVerifyRelease({ pythonHealth: { status: 'ok' } });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /embedding/);
});
```

- [x] **Step 2: 运行失败测试**

Run: `npm test -- test/release-verify.test.js`

Expected: FAIL，因为 `runVerifyRelease` 和发布脚本不存在。

- [x] **Step 3: 实现发布验证和工作流**

```yaml
on:
  push:
  pull_request:
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm test
  python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
      - run: pip install -r ai-service-langchain/requirements.txt
      - run: python -m pytest ai-service-langchain/tests -q
```

增加独立 Docker Compose 配置校验作业。手动发布工作流复用 CI、构建镜像并输出镜像标签/提交 SHA 摘要；不得登录镜像仓库、不得部署、不得使用生产密钥。README 仅补充必要的本地测试、模型首次下载与发布检查命令。

- [x] **Step 4: 运行本地验证**

Run: `npm test && python -m pytest ai-service-langchain/tests -q && docker compose config`

Expected: PASS；任何命令均未读取 API Key、未启动生产端口、未改写真实数据库。

- [x] **Step 5: 提交本任务文件**

```bash
git add .github/workflows scripts/verify-release.js package.json README.md test/release-verify.test.js
git commit -m "ci: add local embedding verification workflow"
```
