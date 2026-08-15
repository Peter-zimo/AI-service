# Quality Evaluation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only 30-case quality gate, reproducible run audit, Badcase lifecycle, and admin review/export UI for the customer-service demo.

**Architecture:** A versioned JSON gate set is evaluated by a Node CLI against a temporary SQLite copy and the existing offline knowledge service. SQLite stores only run metadata, individual evaluation results, and failures; a small quality service owns persistence and attribution. An admin-only Express route exposes read, filter, update, candidate, and CSV export operations, while the existing `admin.html` receives a read-only quality review tab.

**Tech Stack:** Node.js, node:test, better-sqlite3, Express, existing local knowledge service, existing CSV encoder, vanilla HTML/CSS/JavaScript.

## Global Constraints

- Never make an LLM, embedding API, or model-download request from evaluation or its tests.
- The gate set has exactly 30 cases and is versioned in `quality/eval-cases-v1.json`.
- Evaluation runs against a temporary SQLite copy; it must not mutate production knowledge or conversations.
- Quality audit data stores no phone number, visitor ID, full conversation, or credential.
- All quality HTTP endpoints require the existing `admin` JWT middleware.
- The browser may review/export but may not trigger an evaluation run.
- Preserve existing uncommitted changes and avoid unrelated refactoring.

---

### Task 1: Define the 30-case local quality gate

**Files:**
- Create: `quality/eval-cases-v1.json`
- Test: `test/quality-eval-cases.test.js`

**Interfaces:**
- Produces: an array of exactly 30 `{ id, category, query, expectedKind, expectedQuestion?, tags }` records.
- `expectedKind` is one of `knowledge` or `reject`; `expectedQuestion` is required only for `knowledge`.

- [ ] **Step 1: Write the failing test**

```js
const cases = require('../quality/eval-cases-v1.json');

test('quality gate has exactly 30 well-formed local retrieval cases', () => {
  assert.equal(cases.length, 30);
  for (const item of cases) {
    assert.match(item.id, /^qv1-\d{2}$/);
    assert.ok(item.query.trim());
    assert.ok(['knowledge', 'reject'].includes(item.expectedKind));
    assert.ok(Array.isArray(item.tags) && item.tags.length > 0);
    assert.equal(Boolean(item.expectedQuestion), item.expectedKind === 'knowledge');
  }
  assert.ok(cases.some(item => item.expectedKind === 'reject'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/quality-eval-cases.test.js`

Expected: FAIL because the gate data file does not exist.

- [ ] **Step 3: Add the fixed 30-case data set**

Create cases `qv1-01` through `qv1-30`, using existing `server/data/knowledge.json` questions for knowledge expectations. Include 22 knowledge cases across membership, riding, parking, billing/refunds, faults and human support; include 8 reject cases for unrelated weather, stock, film, food, employer, medical, legal and political queries. Use only local retrieval assertions; do not include expected answer text.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/quality-eval-cases.test.js`

Expected: PASS with 30 records and valid contracts.

- [ ] **Step 5: Commit**

```bash
git add quality/eval-cases-v1.json test/quality-eval-cases.test.js
git commit -m "test: add 30-case local quality gate"
```

### Task 2: Persist quality runs, case evidence, and Badcase lifecycle

**Files:**
- Modify: `server/services/sqlite.js`
- Create: `server/services/quality.js`
- Test: `test/quality-service.test.js`

**Interfaces:**
- Produces `quality.createRun({ id, suiteVersion, knowledgeHash, startedAt, actor })`, `quality.recordCase(runId, result)`, `quality.finishRun(runId, summary)`, `quality.listRuns(limit)`, `quality.listCases(runId, filters)`, `quality.updateBadcase(id, patch, actor)`, and `quality.listCandidates(limit)`.
- `result` contains `{ caseId, category, query, expectedKind, expectedQuestion, actualQuestion, source, score, passed, suggestedCause, error }`.
- Badcase causes: `retrieval_threshold`, `retrieval_wrong_match`, `reject_failure`, `system_error`, `knowledge_gap`, `answer_inconsistent`.
- Badcase statuses: `open`, `triaged`, `fixed`, `verified`, `closed`.

- [ ] **Step 1: Write the failing test**

```js
test('failed quality case creates an open Badcase with its suggested cause', () => {
  const run = quality.createRun({ id: 'run-1', suiteVersion: 'v1', knowledgeHash: 'abc', startedAt: now, actor: 'cli' });
  quality.recordCase(run.id, { caseId: 'qv1-01', category: 'FAQ', query: '押金怎么退', expectedKind: 'knowledge', expectedQuestion: '押金退款多久到账？', actualQuestion: null, source: null, score: null, passed: false, suggestedCause: 'retrieval_threshold', error: null });
  const [row] = quality.listCases(run.id, { failed: true });
  assert.equal(row.badcase.status, 'open');
  assert.equal(row.badcase.cause, 'retrieval_threshold');
});

test('Badcase update rejects an unsupported lifecycle status', () => {
  assert.throws(() => quality.updateBadcase('badcase-1', { status: 'ignored' }, 'admin'), /status/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/quality-service.test.js`

Expected: FAIL because the quality service and schema do not exist.

- [ ] **Step 3: Add schema and minimal service implementation**

In `initSchema()`, create `quality_runs`, `quality_cases`, and `quality_badcases` plus indexes on `quality_cases.run_id`, `quality_cases.passed`, `quality_badcases.status`, and `quality_badcases.cause`. In `quality.js`, use parameterized SQLite statements, cap all listed result limits at 500, and create exactly one Badcase for each failed case. Make `updateBadcase` validate cause/status before writing `cause_source='manual'`, `updated_at`, and `updated_by`.

`listCandidates(limit)` must read only `query`, `count`, `first_seen`, `last_seen`, and `status` from `unanswered_queries`; it must not join messages, conversations, phones, or visitor IDs.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/quality-service.test.js`

Expected: PASS for run persistence, failure-to-Badcase creation, safe candidate fields, and lifecycle validation.

- [ ] **Step 5: Commit**

```bash
git add server/services/sqlite.js server/services/quality.js test/quality-service.test.js
git commit -m "feat: persist quality evaluation audit and Badcases"
```

### Task 3: Implement deterministic local evaluation and report generation

**Files:**
- Create: `scripts/run-quality-eval.js`
- Modify: `package.json`
- Test: `test/quality-evaluator.test.js`

**Interfaces:**
- Produces `npm run eval:quality`.
- Creates `reports/quality/<run-id>.json` and `reports/quality/<run-id>-badcases.csv`.
- Exports `classifyResult(expected, actual)` from the script for test use.

- [ ] **Step 1: Write the failing test**

```js
test('classifyResult distinguishes retrieval, reject, and system failures', () => {
  assert.equal(classifyResult({ expectedKind: 'knowledge', expectedQuestion: '退款政策' }, null).suggestedCause, 'retrieval_threshold');
  assert.equal(classifyResult({ expectedKind: 'knowledge', expectedQuestion: '退款政策' }, { question: '会员积分' }).suggestedCause, 'retrieval_wrong_match');
  assert.equal(classifyResult({ expectedKind: 'reject' }, { question: '退款政策' }).suggestedCause, 'reject_failure');
  assert.equal(classifyResult({ expectedKind: 'reject' }, null).passed, true);
});

test('quality evaluation does not use a network client', async () => {
  const report = await runEvaluation({ fetchImpl: () => { throw new Error('network called'); } });
  assert.equal(report.total, 30);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/quality-evaluator.test.js`

Expected: FAIL because the evaluator is absent.

- [ ] **Step 3: Add the CLI evaluator**

Copy `server/data/service_init.db` to an OS temporary file, set `SQLITE_DB_PATH` before requiring `knowledge`, and call only `knowledge.getBestMatch`. Calculate a SHA-256 hash from the sorted local knowledge rows. Persist the run through `quality.js`, write full JSON and failed-row CSV using `toCsv`, print a one-line total/pass/fail summary, then remove the temporary DB in `finally`.

Add this script entry:

```json
"eval:quality": "node scripts/run-quality-eval.js"
```

Create `reports/quality/.gitkeep` and add `reports/quality/*.json` and `reports/quality/*.csv` to `.gitignore`.

- [ ] **Step 4: Run tests and CLI to verify it passes**

Run: `node --test test/quality-evaluator.test.js`

Run: `npm run eval:quality`

Expected: unit test PASS; CLI prints 30 total results and creates one JSON plus one Badcase CSV report without a network attempt.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-quality-eval.js package.json .gitignore reports/quality/.gitkeep test/quality-evaluator.test.js
git commit -m "feat: add deterministic local quality evaluator"
```

### Task 4: Expose admin-only quality review and CSV export APIs

**Files:**
- Create: `server/routes/quality.js`
- Modify: `server/index.js`
- Test: `test/quality-routes.test.js`

**Interfaces:**
- Produces `/api/quality/runs`, `/api/quality/runs/:id/cases`, `/api/quality/badcases/:id`, `/api/quality/runs/:id/export`, and `/api/quality/candidates`.
- Consumes the quality service and `toCsv`.

- [ ] **Step 1: Write the failing test**

```js
test('quality API requires an admin token', async () => {
  const res = await request('/api/quality/runs');
  assert.equal(res.status, 401);
});

test('quality case export emits formula-safe CSV', async () => {
  seedFailedCase({ query: '=unsafe' });
  const res = await adminRequest('/api/quality/runs/run-1/export');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /'=unsafe/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/quality-routes.test.js`

Expected: FAIL because no quality routes are registered.

- [ ] **Step 3: Add route implementation and registration**

Validate `limit` as 1–500. Accept `failed`, `cause`, and `status` filters only. On `PATCH /badcases/:id`, allow only `cause`, `status`, and a trimmed `note` up to 1000 characters. Return 400 for invalid values and 404 for missing IDs. Use `toCsv` for the export and set CSV content/disposition headers. Register with:

```js
app.use('/api/quality', adminLimiter, jwtAuth(['admin']), qualityRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/quality-routes.test.js`

Expected: PASS for auth, filter validation, patch lifecycle, candidate redaction, and safe CSV export.

- [ ] **Step 5: Commit**

```bash
git add server/routes/quality.js server/index.js test/quality-routes.test.js
git commit -m "feat: add admin quality review APIs"
```

### Task 5: Add the admin quality-review page

**Files:**
- Modify: `public/admin.html`
- Test: `test/admin-quality-contract.test.js`

**Interfaces:**
- Produces `switchTab('quality')` UI with run summaries, Badcase filters, editable cause/status/note, CSV download and candidate list.
- Consumes only `/api/quality/*` through existing `apiFetch` and cannot invoke `eval:quality`.

- [ ] **Step 1: Write the failing test**

```js
test('admin quality page uses review APIs and has no browser evaluation trigger', () => {
  const page = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
  assert.match(page, /id="nav-quality"/);
  assert.match(page, /\/api\/quality\/runs/);
  assert.match(page, /\/api\/quality\/candidates/);
  assert.doesNotMatch(page, /eval:quality|run-quality-eval/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/admin-quality-contract.test.js`

Expected: FAIL because no quality review tab exists.

- [ ] **Step 3: Add the smallest review UI**

Add a “质量评测” navigation item after “待补充知识”, a tab with a recent-run table, counters, Badcase cause/status selects, note textarea, save action, export link, and a candidate table. Reuse existing `esc`, `apiFetch`, `toast`, and tab switching patterns. Load quality data only when the tab opens; do not add any endpoint or UI control that triggers evaluation.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/admin-quality-contract.test.js`

Expected: PASS for the review-only browser contract.

- [ ] **Step 5: Commit**

```bash
git add public/admin.html test/admin-quality-contract.test.js
git commit -m "feat: add admin quality review tab"
```

### Task 6: Verify the full quality loop

**Files:**
- Modify: `docs/demo-walkthrough.md`

**Interfaces:**
- Documents local command, report locations, admin review flow, attribution choices and lifecycle statuses.

- [ ] **Step 1: Add the operator walkthrough**

Document this exact sequence: run `npm run eval:quality`; inspect `reports/quality/`; sign in as an admin; open “质量评测”; select a failed run; triage cause/status/note; export Badcases; review candidate queries before separately editing a future evaluation-suite version.

- [ ] **Step 2: Run full verification**

Run: `npm run eval:quality`

Run: `npm test`

Run: `node --check server/services/quality.js`

Run: `node --check server/routes/quality.js`

Run: `git diff --check`

Expected: CLI evaluates exactly 30 cases without external requests; reports exist; all Node tests pass; syntax and diff checks pass.

- [ ] **Step 3: Commit**

```bash
git add docs/demo-walkthrough.md
git commit -m "docs: document quality evaluation workflow"
```
