#!/usr/bin/env node
/**
 * 架构约束检查（Architecture Guard）
 *
 * 目的：把「分层别乱来」变成可执行的检查，而不是口头约定。
 * 每次 npm test 都会跑，任何人（或 AI）改完代码都能立刻知道有没有跑偏。
 *
 * 五条硬约束：
 *   1. routes 层只做取参 → 调 service → 返回，禁止直接访问数据层
 *   2. SQL 只允许出现在 *.repo.js 与 infra/db/ 下
 *   3. *.service.js 禁止碰 HTTP（req / res / express）
 *   4. 模块之间只允许通过 index.js 交互，禁止深挖别的模块内部文件
 *   5. 单文件不得超过 MAX_LINES 行（存量豁免见 architecture-allowlist.json）
 *
 * 用法：
 *   node scripts/check-architecture.js            正常检查，有违规退出码 1
 *   node scripts/check-architecture.js --json     输出 JSON
 *   node scripts/check-architecture.js --verbose  打印通过项
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const MAX_LINES = 400;

const args = new Set(process.argv.slice(2));
const AS_JSON = args.has('--json');
const VERBOSE = args.has('--verbose');

// ============ 工具 ============

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

/** 去掉注释与字符串外的干扰，降低误报 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function loadAllowlist() {
  const file = path.join(__dirname, 'architecture-allowlist.json');
  if (!fs.existsSync(file)) return { rules: [], files: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { rules: raw.rules || [], files: raw.files || {} };
  } catch (e) {
    console.error(`[架构检查] 无法解析 allowlist: ${e.message}`);
    return { rules: [], files: {} };
  }
}

/**
 * 判断某条违规是否被存量豁免。
 * 支持两级豁免：
 *   - 全局按规则豁免（allowlist.rules）
 *   - 按文件 + 规则豁免（allowlist.files[file].exemptRules）
 */
function isExempt(violation, allowlist) {
  if (allowlist.rules.some(r => r.rule === violation.rule)) return true;

  const entry = allowlist.files[violation.file];
  if (entry && Array.isArray(entry.exemptRules) && entry.exemptRules.includes(violation.rule)) {
    return true;
  }
  return false;
}

// ============ 规则实现 ============

const SQL_PATTERN = /\b(SELECT\s+[\w*]|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|VIRTUAL\s+TABLE|INDEX))\b/i;
const PREPARE_PATTERN = /\.prepare\s*\(|\.exec\s*\(\s*[`'"]/;

/** 规则 1：routes 层禁止直接访问数据层 */
function checkRoutesLayer(files) {
  const violations = [];
  for (const file of files) {
    const r = rel(file);
    if (!r.startsWith('server/routes/')) continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));

    if (PREPARE_PATTERN.test(src)) {
      violations.push({ rule: 'routes-no-data-layer', file: r, detail: '路由层出现 SQL 调用，应下沉到 modules/*/*.repo.js' });
    }
    if (/\bdb\._db\b|\bdb\._pg\b/.test(src)) {
      violations.push({ rule: 'routes-no-data-layer', file: r, detail: '路由层直接访问数据库内部句柄' });
    }
    if (/require\(['"][^'"]*\/infra\/db/.test(src)) {
      violations.push({ rule: 'routes-no-data-layer', file: r, detail: '路由层直接 require 数据层' });
    }
  }
  return violations;
}

/** 规则 2：SQL 只允许在 repo 与 infra/db */
function checkSqlLocation(files) {
  const violations = [];
  for (const file of files) {
    const r = rel(file);
    const isRepo = r.endsWith('.repo.js');
    const isDbLayer = r.startsWith('server/infra/db/');
    if (isRepo || isDbLayer) continue;

    const src = stripComments(fs.readFileSync(file, 'utf8'));
    if (PREPARE_PATTERN.test(src) || SQL_PATTERN.test(src)) {
      violations.push({
        rule: 'sql-only-in-repo',
        file: r,
        detail: 'SQL 只允许出现在 *.repo.js 或 server/infra/db/ 下',
      });
    }
  }
  return violations;
}

/** 规则 3：service 层禁止碰 HTTP */
function checkServiceLayer(files) {
  const violations = [];
  for (const file of files) {
    const r = rel(file);
    if (!r.endsWith('.service.js')) continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));

    if (/require\(['"]express['"]\)/.test(src)) {
      violations.push({ rule: 'service-no-http', file: r, detail: 'service 层不得依赖 express' });
    }
    if (/\breq\.(body|params|query|headers|cookies)\b/.test(src)) {
      violations.push({ rule: 'service-no-http', file: r, detail: 'service 层不得直接读取 req 对象' });
    }
    if (/\bres\.(json|send|status|setHeader)\s*\(/.test(src)) {
      violations.push({ rule: 'service-no-http', file: r, detail: 'service 层不得直接写 res 响应' });
    }
  }
  return violations;
}

/** 规则 4：模块之间只走 index.js */
function checkModuleBoundary(files) {
  const violations = [];
  for (const file of files) {
    const r = rel(file);
    if (!r.startsWith('server/modules/')) continue;

    const parts = r.split('/'); // server modules <domain> ...
    if (parts.length < 4) continue;
    const ownDomain = parts[2];

    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const requireRe = /require\(['"](\.[^'"]+)['"]\)/g;
    let m;
    while ((m = requireRe.exec(src)) !== null) {
      const spec = m[1];
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(r), spec));
      if (!target.startsWith('server/modules/')) continue;

      const tParts = target.split('/');
      const targetDomain = tParts[2];
      if (targetDomain === ownDomain) continue;

      // 允许 require('../other') 或 '../other/index'，禁止 '../other/内部文件'
      const rest = tParts.slice(3).filter(Boolean);
      const isIndex = rest.length === 0 || (rest.length === 1 && rest[0] === 'index');
      if (!isIndex) {
        violations.push({
          rule: 'module-boundary',
          file: r,
          detail: `跨模块深引用 ${spec}，应改为 require('../${targetDomain}') 走对外出口`,
        });
      }
    }
  }
  return violations;
}

/** 规则 5：单文件行数上限（存量豁免可设基线，只拦增长） */
function checkFileSize(files, allowlist) {
  const violations = [];
  const warnings = [];
  for (const file of files) {
    const r = rel(file);
    const lines = readLines(file).filter(l => l.trim().length > 0).length;
    const baseline = allowlist.files[r];

    if (baseline) {
      if (lines > baseline.maxLines) {
        violations.push({
          rule: 'max-file-lines',
          file: r,
          detail: `存量豁免文件增长到 ${lines} 行，超过基线 ${baseline.maxLines} 行（${baseline.reason || '待拆分'}）`,
        });
      } else {
        warnings.push({ file: r, lines, baseline: baseline.maxLines, reason: baseline.reason });
      }
      continue;
    }

    if (lines > MAX_LINES) {
      violations.push({
        rule: 'max-file-lines',
        file: r,
        detail: `${lines} 行超过上限 ${MAX_LINES} 行，请按职责拆分`,
      });
    }
  }
  return { violations, warnings };
}

// ============ 主流程 ============

function run() {
  const allowlist = loadAllowlist();
  const files = walk(SERVER);

  const all = [
    ...checkRoutesLayer(files),
    ...checkSqlLocation(files),
    ...checkServiceLayer(files),
    ...checkModuleBoundary(files),
  ];

  const sizeResult = checkFileSize(files, allowlist);
  all.push(...sizeResult.violations);

  const active = all.filter(v => !isExempt(v, allowlist));
  const suppressed = all.filter(v => isExempt(v, allowlist));

  // 豁免已失效（对应违规已修复）→ 提示移除，避免清单越来越脏
  const staleExemptions = [];
  for (const [file, entry] of Object.entries(allowlist.files)) {
    if (!Array.isArray(entry.exemptRules)) continue;
    for (const rule of entry.exemptRules) {
      const still = suppressed.some(v => v.file === file && v.rule === rule);
      if (!still) staleExemptions.push({ file, rule });
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ scanned: files.length, violations: active, suppressed, staleExemptions, warnings: sizeResult.warnings }, null, 2));
    return active.length;
  }

  console.log(`\n[架构检查] 扫描 ${files.length} 个文件，${Object.keys(allowlist.files).length} 个存量豁免`);

  if (VERBOSE) {
    for (const w of sizeResult.warnings) {
      console.log(`  · 豁免 ${w.file} — ${w.lines}/${w.baseline} 行（${w.reason}）`);
    }
  }

  for (const s of staleExemptions) {
    console.log(`  · 提示：${s.file} 的 ${s.rule} 豁免已失效，可从 allowlist 移除`);
  }

  if (active.length === 0) {
    console.log('[架构检查] ✅ 通过，0 违规\n');
    return 0;
  }

  const byRule = {};
  for (const v of active) (byRule[v.rule] = byRule[v.rule] || []).push(v);

  const RULE_TITLES = {
    'routes-no-data-layer': '规则 1 · routes 层不得直接访问数据层',
    'sql-only-in-repo': '规则 2 · SQL 只允许在 *.repo.js / infra/db',
    'service-no-http': '规则 3 · service 层不得碰 HTTP',
    'module-boundary': '规则 4 · 模块间只走 index.js',
    'max-file-lines': '规则 5 · 单文件行数超限',
  };

  console.log(`[架构检查] ❌ ${active.length} 处违规\n`);
  for (const [rule, list] of Object.entries(byRule)) {
    console.log(`  ${RULE_TITLES[rule] || rule}`);
    for (const v of list) {
      console.log(`    ✗ ${v.file}`);
      console.log(`      ${v.detail}`);
    }
    console.log('');
  }
  if (suppressed.length > 0) {
    console.log(`  （另有 ${suppressed.length} 处已登记豁免，见 scripts/architecture-allowlist.json）\n`);
  }
  return active.length;
}

process.exit(run() > 0 ? 1 : 0);
