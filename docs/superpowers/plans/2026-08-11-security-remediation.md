# Security Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the audit P0-P2 security, consistency, deployment, and dependency risks without changing the browser-facing Node API contract unnecessarily.

**Architecture:** Node remains the browser boundary. Python is authenticated as an internal dependency; visitor and agent access is bound to server-side conversation ownership. Deployment exposes only Node/Nginx.

**Tech Stack:** Express, FastAPI, better-sqlite3, PostgreSQL adapter, Docker Compose, Node test runner, unittest.

## Global Constraints

- Do not make live LLM calls in tests.
- Preserve the user’s existing dirty worktree and do not reset it.
- Add a failing regression test before each production behavior change.
- Run the focused test immediately after each task, then run both full suites at the end.

---

### Task 1: Internal Python service boundary

**Files:** `ai-service-langchain/main.py`, `routers/api.py`, Node stream clients, Python tests.

- [ ] Add tests that reject missing/wrong internal token and accept health unauthenticated.
- [ ] Add an `X-Internal-Service-Token` FastAPI dependency, loopback default binding, CORS allowlist, request size constraints, and Node header injection.
- [ ] Run Python security tests and existing Node stream tests.

### Task 2: Visitor and agent authorization

**Files:** `server/routes/actions.js`, `server/routes/chat.js`, `server/routes/human.js`, Node tests.

- [ ] Add failing tests for anonymous order enumeration, cross-visitor status access, and cross-agent history access.
- [ ] Bind order reads to an owned conversation and a phone stored in that conversation; authorize visitor status and agent history.
- [ ] Run focused authorization tests.

### Task 3: Conversation lifecycle consistency

**Files:** `server/services/database.js`, Node tests.

- [ ] Add failing lifecycle tests for create/close/update/idle behavior using an isolated SQLite database.
- [ ] Await database reads and verify state transitions.
- [ ] Run lifecycle and full Node tests.

### Task 4: Knowledge-source consistency and moderation resilience

**Files:** Python retriever/API, Node protected knowledge endpoint/client, tests.

- [ ] Add tests for protected reload and PostgreSQL-mode knowledge source selection.
- [ ] Route PostgreSQL-mode Python retrieval through Node’s internal API; retain SQLite only for local mode.
- [ ] Add local moderation fallback and bounded input tests.
- [ ] Run Python retrieval and moderation tests.

### Task 5: Login, configuration, and deployment hardening

**Files:** Node index/auth/config, Docker Compose, Dockerfiles, package manifests, environment examples, tests/docs.

- [ ] Add tests for login rate limiting and production configuration validation.
- [ ] Add dedicated login limiters, token revocation/version validation, atomic secret/config writes, and explicit production environment validation.
- [ ] Remove public PostgreSQL/Python port mappings and default DB password; set Compose secrets as required variables.
- [ ] Upgrade dependency versions where safe and document remaining upstream advisories.
- [ ] Run all test suites, syntax checks, dependency checks, and configuration validation.
