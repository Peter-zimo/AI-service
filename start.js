#!/usr/bin/env node
/**
 * AI智能客服系统 — 一键启动/停止脚本
 *
 * 用法：
 *   node start.js          启动全部服务（Python AI + Node 主服务）
 *   node start.js stop     停止全部服务
 *   node start.js restart  重启全部服务
 *   node start.js status   查看服务状态
 *
 * 通过 start.bat 双击即可使用
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const ROOT = __dirname;
const PIDS_FILE = path.join(ROOT, 'server', 'data', 'pids.json');
const LOG_DIR = path.join(ROOT, 'logs');
const NODE_STDOUT = path.join(ROOT, 'server', 'data', 'stdout.log');

// ===== 环境自适应探测（Demo 换机器也能跑）=====
function detectAIServiceDir() {
  const candidates = [
    process.env.AI_SERVICE_DIR,                          // 1. 显式指定
    path.join(ROOT, '..', 'ai-service-langchain'),       // 2. 项目同级（推荐 demo 布局）
    'D:/AI应用/ai-service-langchain',                    // 3. 本机原路径（兜底）
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'run.py'))) return c;
  }
  return candidates[0] || 'D:/AI应用/ai-service-langchain';
}

function detectPython() {
  const candidates = [
    process.env.AI_PYTHON,                               // 1. 显式指定
    'C:/Users/Dell/.workbuddy/binaries/python/versions/3.13.12/python.exe', // 2. 本机已验证路径
    'python',                                            // 3. PATH 中的 python（换机器用）
  ].filter(Boolean);
  for (const c of candidates) {
    try { execSync(`"${c}" --version`, { stdio: 'pipe' }); return c; } catch (_) {}
  }
  return candidates[0];
}

// ===== 服务配置 =====
const SERVICES = {
  ai: {
    name: 'Python AI 服务',
    port: 8000,
    health: 'http://localhost:8000/api/health',
    cwd: detectAIServiceDir(),
    cmd: detectPython(),
    args: ['run.py'],
    log: path.join(LOG_DIR, 'ai-service.log'),
    startDelay: 8000,
    env: {
      NODE_SQLITE_PATH: path.join(ROOT, 'server', 'data', 'service_init.db'),
      NODE_AI_CONFIG: path.join(ROOT, 'server', 'data', 'ai-config.json'),
    },
  },
  node: {
    name: 'Node 主服务',
    port: 3456,
    health: 'http://localhost:3456/api/health',
    cwd: ROOT,
    cmd: process.execPath, // 当前 node
    args: ['server/index.js'],
    log: NODE_STDOUT,
    env: {
      SQLITE_DB_PATH: path.join(ROOT, 'server', 'data', 'service_init.db'),
    },
    startDelay: 5000,
  },
};

// ===== 工具函数 =====

function ensureDirs() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const dataDir = path.join(ROOT, 'server', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function log(msg, type) {
  const prefix = type === 'ok' ? '✅' : type === 'err' ? '❌' : type === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`${prefix} ${msg}`);
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1', timeout: 1500 });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function waitHealthy(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch (_) { /* 未就绪，继续等 */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

function savePids(pids) {
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids, null, 2), 'utf-8');
}

function loadPids() {
  try { return JSON.parse(fs.readFileSync(PIDS_FILE, 'utf-8')); }
  catch (_) { return {}; }
}

function readPid(pid) {
  try {
    // Windows 判断进程是否存在
    execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { stdio: 'pipe' });
    return true;
  } catch (_) { return false; }
}

function killTree(pid) {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' });
    return true;
  } catch (_) { return false; }
}

function spawnService(key) {
  const svc = SERVICES[key];
  const logStream = fs.openSync(svc.log, 'a');
  const child = spawn(svc.cmd, svc.args, {
    cwd: svc.cwd,
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: { ...process.env, ...(svc.env || {}) },
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// ===== 主逻辑 =====

async function startAll() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AI智能客服系统 — 一键启动');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ensureDirs();

  const pids = loadPids();
  const started = [];

  // 1. Python AI 服务
  const aiPortOpen = await isPortOpen(SERVICES.ai.port);
  if (aiPortOpen) {
    log(`${SERVICES.ai.name} 已在运行（端口 ${SERVICES.ai.port}），跳过`, 'warn');
  } else {
    log(`启动 ${SERVICES.ai.name} ...`);
    const pid = spawnService('ai');
    pids.ai = pid;
    started.push('ai');
    log(`${SERVICES.ai.name} 启动中 (PID ${pid})`);
  }

  // 2. Node 主服务
  const nodePortOpen = await isPortOpen(SERVICES.node.port);
  if (nodePortOpen) {
    log(`${SERVICES.node.name} 已在运行（端口 ${SERVICES.node.port}），跳过`, 'warn');
  } else {
    log(`启动 ${SERVICES.node.name} ...`);
    const pid = spawnService('node');
    pids.node = pid;
    started.push('node');
    log(`${SERVICES.node.name} 启动中 (PID ${pid})`);
  }

  savePids(pids);

  // 3. 等待健康检查
  if (started.includes('ai')) {
    log('等待 AI 服务就绪 ...');
    const ok = await waitHealthy(SERVICES.ai.health, 30000);
    log(ok ? 'Python AI 服务 ✅ 已就绪' : 'Python AI 服务 启动缓慢（可继续等）', ok ? 'ok' : 'warn');
  }
  if (started.includes('node')) {
    log('等待主服务就绪 ...');
    const ok = await waitHealthy(SERVICES.node.health, 40000);
    log(ok ? 'Node 主服务 ✅ 已就绪' : 'Node 主服务 启动缓慢（可继续等）', ok ? 'ok' : 'warn');
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅ 全部就绪，访问地址：');
  console.log('    访客端:  http://localhost:3456');
  console.log('    管理后台: http://localhost:3456/admin.html');
  console.log('    客服台:  http://localhost:3456/agent.html');
  console.log('    统计面板: http://localhost:3456/stats.html');
  console.log('  ─────────────────────────────');
  console.log('  停止服务:  双击 start-stop.bat 或运行 node start.js stop');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

async function stopAll() {
  console.log('停止全部服务 ...');
  const pids = loadPids();
  let any = false;

  for (const key of ['node', 'ai']) {
    const pid = pids[key];
    if (pid && readPid(pid)) {
      log(`停止 ${SERVICES[key].name} (PID ${pid})`, 'warn');
      killTree(pid);
      any = true;
    } else {
      log(`${SERVICES[key].name} 未在运行`);
    }
  }

  if (!any) log('没有检测到由本脚本启动的服务');

  // 兜底：按端口清理残留进程
  for (const svc of Object.values(SERVICES)) {
    if (await isPortOpen(svc.port)) {
      log(`端口 ${svc.port} 仍有进程占用，尝试清理 ...`, 'warn');
      try {
        execSync(`netstat -ano | findstr :${svc.port} | findstr LISTENING`, { stdio: 'pipe' })
          .toString().split('\n').forEach(line => {
            const m = line.trim().match(/(\d+)\s*$/);
            if (m) killTree(parseInt(m[1]));
          });
      } catch (_) { /* 无残留 */ }
    }
  }

  savePids({});
  log('已全部停止');
}

async function statusAll() {
  console.log('服务状态：');
  for (const key of ['ai', 'node']) {
    const svc = SERVICES[key];
    const open = await isPortOpen(svc.port);
    log(`${svc.name}: ${open ? '🟢 运行中' : '⚫ 未运行'} (端口 ${svc.port})`, open ? 'ok' : 'warn');
  }
}

// ===== 入口 =====
const arg = process.argv[2] || 'start';

(async () => {
  switch (arg) {
    case 'start':   await startAll(); break;
    case 'stop':    await stopAll(); break;
    case 'restart':
      await stopAll();
      await new Promise(r => setTimeout(r, 2000));
      await startAll();
      break;
    case 'status':  await statusAll(); break;
    default:
      console.log('用法: node start.js [start|stop|restart|status]');
  }
})();
