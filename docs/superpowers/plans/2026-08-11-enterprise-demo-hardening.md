# Enterprise Demo Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the customer-service demo offline-first for RAG, secure its external boundaries, and make its critical behavior independently testable.

**Architecture:** Node owns the authoritative SQLite knowledge base and performs offline FTS/BM25/hash-vector retrieval. Python receives an explicit SQLite location and uses an offline-only embedding fallback; cloud LLM calls remain limited to unmatched user conversations. Security enforcement stays in Node's HTTP/WebSocket boundary.

**Tech Stack:** Node.js 24, Express 5, ws, node:test, SQLite, Python 3.12, FastAPI, unittest.

## Global Constraints

- Do not read, print, replace, or commit real `.env` credential values.
- Do not make external model or model-download requests during tests.
- Preserve the user's existing uncommitted changes unless a task explicitly changes the same behavior.
- Use temporary SQLite copies in tests; never mutate the working `service.db`.
- Keep real cloud LLM calls opt-in and only after a local knowledge-base miss.

---

### Task 1: Make Node knowledge embeddings offline-only

**Files:**
- Modify: `server/services/knowledge.js:59-124`
- Test: `test/knowledge-offline.test.js`

**Interfaces:**
- Produces: `computeEmbedding(text): Promise<number[] | null>` that returns the local 128-dimension vector without network access.
- Consumes: existing `localEmbedding(text): number[]`.

- [ ] **Step 1: Write the failing test**

```js
test('computeEmbedding does not call fetch or axios and returns a local vector', async () => {
  const service = loadKnowledgeServiceWithNetworkForbidden();
  const vector = await service._test.computeEmbedding('押金怎么退');
  assert.equal(vector.length, 128);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/knowledge-offline.test.js`

Expected: FAIL because the current implementation attempts provider and localhost embedding requests.

- [ ] **Step 3: Write minimal implementation**

```js
async function computeEmbedding(text) {
  if (!text || !text.trim()) return null;
  return localEmbedding(text.trim().slice(0, 512));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/knowledge-offline.test.js`

Expected: PASS with no network attempt.

- [ ] **Step 5: Commit**

```bash
git add test/knowledge-offline.test.js server/services/knowledge.js
git commit -m "fix: keep knowledge embeddings offline"
```

### Task 2: Make Python knowledge loading and embedding offline-safe

**Files:**
- Modify: `D:/AI应用/ai-service-langchain/knowledge/retriever.py:130-177`
- Modify: `D:/AI应用/ai-service-langchain/knowledge/embedding.py:48-94`
- Test: `D:/AI应用/ai-service-langchain/tests/test_offline_config.py`

**Interfaces:**
- Produces: `resolve_node_sqlite_path() -> pathlib.Path | None` that prioritizes `NODE_SQLITE_PATH` and never uses the obsolete `workbuddy files` path.
- Produces: `bge_embedding(text) -> list[float]` that returns `[]` without a preinstalled local BGE model and never downloads one.

- [ ] **Step 1: Write the failing tests**

```python
def test_node_sqlite_path_uses_explicit_environment_value(monkeypatch, tmp_path):
    db = tmp_path / "service.db"
    db.touch()
    monkeypatch.setenv("NODE_SQLITE_PATH", str(db))
    assert retriever.resolve_node_sqlite_path() == db

def test_missing_bge_model_never_constructs_remote_model(monkeypatch):
    monkeypatch.setattr(embedding, "_BGE_MODEL_NAME", "not-a-local-directory")
    monkeypatch.setattr(embedding, "SentenceTransformer", fail_if_called)
    assert embedding.bge_embedding("押金怎么退") == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:PYTHONDONTWRITEBYTECODE='1'; python -m unittest tests.test_offline_config`

Expected: FAIL because the obsolete default path and remote `SentenceTransformer` construction still exist.

- [ ] **Step 3: Write minimal implementation**

```python
def resolve_node_sqlite_path() -> Path | None:
    configured = os.environ.get("NODE_SQLITE_PATH")
    if configured and Path(configured).is_file():
        return Path(configured)
    return None

def _load_bge():
    if not os.path.isdir(_BGE_MODEL_NAME):
        return False
    return SentenceTransformer(_BGE_MODEL_NAME, local_files_only=True)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:PYTHONDONTWRITEBYTECODE='1'; python -m unittest tests.test_offline_config tests.test_retriever tests.test_kb_priority`

Expected: PASS without external connections or downloads.

- [ ] **Step 5: Commit**

```bash
git -C D:/AI应用/ai-service-langchain add knowledge/retriever.py knowledge/embedding.py tests/test_offline_config.py
git -C D:/AI应用/ai-service-langchain commit -m "fix: make Python retrieval offline safe"
```

### Task 3: Require authenticated agent WebSocket connections

**Files:**
- Modify: `server/index.js:342-351`
- Test: `test/websocket-auth.test.js`

**Interfaces:**
- Consumes: `token` query parameter and existing `jwtAuth` secret/signature helpers.
- Produces: close code `1008` for missing, invalid, mismatched, or non-agent/admin tokens.

- [ ] **Step 1: Write the failing test**

```js
test('agent WebSocket rejects a connection without a JWT', async () => {
  const ws = await connect('/ws?type=agent&id=agent_001');
  assert.equal(await closeCode(ws), 1008);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/websocket-auth.test.js`

Expected: FAIL because an existing agent ID is currently accepted without a token.

- [ ] **Step 3: Write minimal implementation**

```js
const token = url.searchParams.get('token');
const claims = verifyAccessToken(token);
if (!claims || !['admin', 'agent'].includes(claims.role) || claims.sub !== id) {
  ws.close(1008, 'Unauthorized');
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/websocket-auth.test.js`

Expected: PASS for rejected anonymous/mismatched connections and accepted matching agent token.

- [ ] **Step 5: Commit**

```bash
git add server/index.js test/websocket-auth.test.js
git commit -m "fix: authenticate agent WebSocket connections"
```

### Task 4: Restrict production CORS, metrics, and health output

**Files:**
- Modify: `server/index.js:72-90`
- Modify: `server/index.js:146-170`
- Test: `test/security-boundaries.test.js`

**Interfaces:**
- Produces: a production CORS policy that rejects any Origin if `ALLOWED_ORIGINS` is empty.
- Produces: authenticated `/api/metrics` and a health payload limited to `{ status, time }`.

- [ ] **Step 1: Write the failing tests**

```js
test('production rejects cross-origin requests without an allowlist', async () => {
  const res = await request({ origin: 'https://attacker.example' });
  assert.equal(res.status, 403);
});

test('metrics requires an admin token', async () => {
  assert.equal((await requestMetrics()).status, 401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/security-boundaries.test.js`

Expected: FAIL because empty configuration allows all Origins and metrics is anonymous.

- [ ] **Step 3: Write minimal implementation**

```js
if (process.env.NODE_ENV === 'production' && !allowedOrigins?.length) {
  return callback(new Error('CORS allowlist required'));
}
app.get('/api/metrics', jwtAuth(['admin']), metricsHandler);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/security-boundaries.test.js`

Expected: PASS with no anonymous metrics access and no process details in health output.

- [ ] **Step 5: Commit**

```bash
git add server/index.js test/security-boundaries.test.js
git commit -m "fix: restrict production observability endpoints"
```

### Task 5: Make RAG tests self-contained and verify the integrated offline path

**Files:**
- Modify: `test/knowledge.test.js:33-87`
- Modify: `D:/AI应用/ai-service-langchain/tests/test_smart_kb_match.py`
- Test: existing Node and Python suites

**Interfaces:**
- Produces: RAG regressions that always run against temporary SQLite data and local embeddings.

- [ ] **Step 1: Write the failing regression assertion**

```js
test('RAG regression does not skip when no AI service is listening', async () => {
  assert.equal(aiUp, false);
  assert.equal(await kb.getBestMatch('押金怎么退'), expectedKnowledge);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/knowledge.test.js`

Expected: FAIL because three important cases are guarded by `skip: () => !aiUp`.

- [ ] **Step 3: Write minimal implementation**

```js
// Remove AI service probing and all skip predicates.
// Keep the isolated temporary SQLite setup and exercise local retrieval only.
```

- [ ] **Step 4: Run complete offline verification**

Run: `npm test`

Run: `$env:PYTHONDONTWRITEBYTECODE='1'; python -m unittest discover -s tests -p 'test_*.py'`

Expected: all tests pass; no test is skipped due to a missing AI service; no test process lingers after completion.

- [ ] **Step 5: Commit**

```bash
git add test/knowledge.test.js
git commit -m "test: make RAG regressions independent of AI service"
```
