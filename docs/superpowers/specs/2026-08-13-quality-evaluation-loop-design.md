# 质量评测闭环设计

## 目标

为共享单车客服 Demo 建立一个不依赖外部模型的最小质量闭环：固定 30 条发布门槛评测、真实会话候选池、可复现运行审计，以及可归因、可关闭的 Badcase。

## 范围与约束

- 评测只调用 Node 本地知识库检索，不发起 LLM、embedding API 或模型下载请求。
- 评测使用临时 SQLite 副本，不修改生产知识库或真实会话。
- 发布门槛集固定为恰好 30 条；新增真实问题先进入候选池，人工确认后才可替换或扩展后续版本。
- 所有管理接口仅限 admin；浏览器只能查看、筛选、修改 Badcase 状态/归因和导出，不可运行评测。
- 不记录用户手机号、visitorId、完整对话或密钥到质量审计数据；候选池仅保存经截断的用户问题、来源类型和出现次数。

## 数据模型

### 评测集

`quality/eval-cases-v1.json` 是版本化的静态文件，包含 30 条记录。每条有：`id`、`category`、`query`、`expectedKind`（`knowledge` 或 `reject`）、`expectedQuestion`（知识命中题必填）和 `tags`。

分类覆盖：核心 FAQ、同义问法、流程指引、故障、费用/退款、人工转接、无关拒答与敏感边界。运行时以知识条目 question 或 `null` 判断，不进行答案文本相似度判断。

### 运行审计与 Badcase

SQLite 新增三张表：

- `quality_runs`：运行 ID、评测集版本、知识库哈希、开始/结束时间、总数、通过数、失败数、拒答正确数和运行者。
- `quality_cases`：每个运行的单条结果，保留评测输入、预期、实际命中题、来源、分数、是否通过和自动归因建议。
- `quality_badcases`：仅失败记录的闭环状态；保存 `case_id`、归因、归因来源（自动/人工）、状态、处理备注、更新时间和操作者。

真实候选池复用 `unanswered_queries`，但通过新服务将 `fallback`、低评分或人工转接对应的脱敏问题汇总为候选；本期不自动把候选写进发布门槛集。

## 运行与判定

`npm run eval:quality` 创建临时数据库副本，加载本地 `knowledge` 服务，并逐条调用 `getBestMatch(query)`。

- `expectedKind=knowledge`：实际命中且 `question === expectedQuestion` 为通过。
- `expectedKind=reject`：实际为 `null` 为通过。
- 其他情况为失败，并写入该运行的单条审计与 Badcase。

自动归因规则：期望知识题但未命中为“召回/阈值错误”；命中错误知识题为“召回错误”；应拒答却命中为“拒答错误”；执行异常为“系统异常”。“知识缺失”和“答案不一致”保留给人工改判，因为静态检索结果无法可靠地自动证明它们。

脚本输出 JSON 与 CSV 到 `reports/quality/`；JSON 是完整可机读运行报告，CSV 只包含失败项，供复核。

## 管理接口与页面

新增 `/api/quality`（admin）：

- `GET /runs`：历史运行汇总。
- `GET /runs/:id/cases`：按是否失败、归因、状态筛选单条结果。
- `PATCH /badcases/:id`：人工确认归因、状态和备注。状态只允许 `open`、`triaged`、`fixed`、`verified`、`closed`。
- `GET /runs/:id/export`：导出该次 Badcase CSV。
- `GET /candidates`：从未答问题查看真实问题候选。

后台添加“质量评测”页：展示最近运行、失败数和通过率；可筛选 Badcase、编辑归因/状态/备注，下载 CSV，并查看候选池。页面不包含“运行评测”按钮。

## 验证

测试必须确认：评测集正好 30 条；本地运行不会调用网络且结果可写入运行、单条审计和 Badcase；错误命中、拒答错误和系统异常被正确归因；Badcase 只能由管理员更新为允许值；CSV 以安全转义方式导出。

端到端验证运行 `npm run eval:quality` 后，检查报告文件和管理 API 返回的同一运行记录；完整 Node 测试必须全部通过。
