const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cases = require('../quality/eval-cases-v1.json');
const { toCsv } = require('../server/utils/csv');

function classifyResult(expected, actual, error = null) {
  if (error) return { passed: false, suggestedCause: 'system_error' };
  if (expected.expectedKind === 'reject') {
    return actual ? { passed: false, suggestedCause: 'reject_failure' } : { passed: true, suggestedCause: null };
  }
  if (!actual) return { passed: false, suggestedCause: 'retrieval_threshold' };
  return actual.question === expected.expectedQuestion
    ? { passed: true, suggestedCause: null }
    : { passed: false, suggestedCause: 'retrieval_wrong_match' };
}

function localKnowledgeHash(knowledge) {
  const canonical = [...knowledge.knowledgeBase]
    .map(item => `${item.id}|${item.question}|${item.answer}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function runEvaluation(options = {}) {
  const startedAt = new Date().toISOString();
  const runId = options.runId || uuidv4();
  let knowledge = options.knowledge;
  let quality = options.quality;

  if (!knowledge) {
    knowledge = require('../server/services/knowledge');
    await knowledge._ready;
  }
  if (!quality && options.persist !== false) quality = require('../server/services/quality');
  const knowledgeHash = options.knowledgeHash || localKnowledgeHash(knowledge);
  if (quality) quality.createRun({ id: runId, suiteVersion: 'v1', knowledgeHash, startedAt, actor: options.actor || 'cli' });

  const results = [];
  for (const item of cases) {
    let actual = null;
    let error = null;
    try {
      actual = await (options.getBestMatch || knowledge.getBestMatch.bind(knowledge))(item.query);
    } catch (caught) {
      error = caught.message;
    }
    const verdict = classifyResult(item, actual, error);
    const result = {
      caseId: item.id, category: item.category, query: item.query, expectedKind: item.expectedKind,
      expectedQuestion: item.expectedQuestion || null, actualQuestion: actual?.question || null,
      source: actual?.source || null, score: actual?.score ?? null, error, ...verdict
    };
    results.push(result);
    if (quality) quality.recordCase(runId, result);
  }
  const report = {
    runId, suiteVersion: 'v1', knowledgeHash, startedAt, finishedAt: new Date().toISOString(),
    total: results.length, passed: results.filter(row => row.passed).length,
    failed: results.filter(row => !row.passed).length,
    rejectPassed: results.filter(row => row.expectedKind === 'reject' && row.passed).length,
    results
  };
  if (quality) quality.finishRun(runId, report);
  if (options.writeReports !== false) {
    const reportDir = path.join(__dirname, '..', 'reports', 'quality');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, `${runId}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(reportDir, `${runId}-badcases.csv`), '\uFEFF' + toCsv(results.filter(row => !row.passed)));
  }
  return report;
}

async function main() {
  const sourceDb = path.join(__dirname, '..', 'server', 'data', 'service.db');
  const dbPath = path.join(os.tmpdir(), `quality-eval-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(sourceDb, dbPath);
  process.env.SQLITE_DB_PATH = dbPath;
  process.env.DISABLE_DB_BACKUP = 'true';
  try {
    const report = await runEvaluation();
    console.log(`Quality evaluation ${report.runId}: total=${report.total} passed=${report.passed} failed=${report.failed}`);
  } finally {
    const db = require('../server/services/sqlite');
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { classifyResult, runEvaluation };
