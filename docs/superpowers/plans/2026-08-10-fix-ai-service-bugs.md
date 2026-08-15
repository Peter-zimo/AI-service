# AI 智能客服系统问题修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:test-driven-development 逐项修复，并用 superpowers:verification-before-completion 以真实运行证据验证。

**Goal:** 修复排查发现的全部问题（知识库误报、错误数据库路径、并发改写、安全凭据泄露），使系统完全正常可用。

**Architecture:**
- 主对话路径：Node `/api/chat/stream` → Python LangChain 服务（`D:\AI应用\ai-service-langchain`）`/api/chat` → `ai/chat.py _smart_kb_match` → `knowledge/retriever.py get_best_match`。
- 修复核心在 Python 端 `knowledge/retriever.py`（阈值 + 逻辑 bug）与配置（数据库路径）。
- Node 端修复安全项（git 凭据泄露、`SENSITIVE_LOG_KEY`）。

**Tech Stack:** Python 3.13（workbuddy python）、LangChain、FastAPI、SQLite；Node.js（Express）。

## Global Constraints

- Python 服务使用解释器：`C:\Users\Dell\.workbuddy\binaries\python\versions\3.13.12\python.exe`
- 测试使用标准库 `unittest`（不新增依赖）
- 语义阈值对齐 Node 端：语义 0.45、legacy 20（与提交 cbcdc7a 一致）
- 每次修改后必须以真实运行（重启服务 + API 调用）验证

---

### Task 1: 修复 Python 知识库检索误报

**Files:**
- Modify: `D:\AI应用\ai-service-langchain\knowledge\retriever.py`
- Test: `D:\AI应用\ai-service-langchain\tests\test_retriever.py`

**Interfaces:**
- `KnowledgeService.get_best_match(query) -> Optional[Dict]`
- `KnowledgeService.search_semantic(query, top_k=5, threshold=0.45)`

- [ ] Step 1: 写失败测试（无关查询返回 None；低置信返回 None；高置信返回条目）
- [ ] Step 2: 运行测试确认失败
- [ ] Step 3: 修改 `search_semantic` 阈值 0.3→0.45；`get_best_match` 改为按 `best` 条目自身原始分回查（legacy≥20、bm25≥3.5、semantic≥0.45）
- [ ] Step 4: 运行测试确认通过
- [ ] Step 5: 重启 Python 服务，API 实测"今天天气怎么样"不再命中错误知识

### Task 2: 修复 Python 读取错误数据库路径

**Files:**
- Modify: `D:\AI应用\ai-service-langchain\.env`

- [ ] Step 1: 在 `.env` 增加 `NODE_SQLITE_PATH` 与 `NODE_AI_CONFIG` 指向当前项目
- [ ] Step 2: 重启服务，确认从当前项目 `service.db` 加载 13 条知识库

### Task 3: 修复 embedding 后台并发改写

**Files:**
- Modify: `D:\AI应用\ai-service-langchain\knowledge\retriever.py`

- [ ] Step 1: 为 embedding 重算加锁，避免多线程并发改写 `items`
- [ ] Step 2: 重启服务确认无并发告警

### Task 4: 安全修复（git 凭据泄露 + SENSITIVE_LOG_KEY）

**Files:**
- Modify: `D:\AI应用\AI智能客服V3（node.js版）\.gitignore`
- Modify: `D:\AI应用\AI智能客服V3（node.js版）\.env.production`
- Modify: `D:\AI应用\AI智能客服V3（node.js版）\.env`

- [ ] Step 1: 将 `server/config/auth.json` 加入 `.gitignore` 并从 git 移除（`git rm --cached`）
- [ ] Step 2: 为 agent/viewer 账号密码改为 bcrypt 哈希；轮换 `jwtSecret`
- [ ] Step 3: 设置 `SENSITIVE_LOG_KEY`
- [ ] Step 4: 重启 Node 服务，确认日志不再告警

### Task 5: 端到端验证

- [ ] Step 1: 重启 Node + Python 服务
- [ ] Step 2: 批量验证无关查询（天气→AI 闲聊）与合法查询（押金/客服→正确知识库）均正确
