#!/usr/bin/env node
'use strict';
/**
 * 发布前验证脚本
 * 按顺序执行 Node 测试、Python 测试与 Docker Compose 配置校验，
 * 并校验 Python 健康契约（/api/health 必须包含 embedding 字段）。
 * 本地运行：npm run verify:release
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 执行发布前验证。
 * @param {object} [opts] 可注入依赖，便于单元测试
 * @param {{ status?: string, embedding?: unknown }} [opts.pythonHealth] Python /api/health 响应
 * @param {Function} [opts.spawn] 替代 spawnSync（测试注入）
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function runVerifyRelease({ pythonHealth, spawn = spawnSync } = {}) {
  const stderr = [];

  // 1) Python 健康契约：/api/health 必须暴露 embedding 状态
  if (pythonHealth && !('embedding' in pythonHealth)) {
    stderr.push('[verify] Python 健康契约缺失 embedding 字段');
    return { exitCode: 1, stdout: '', stderr: stderr.join('\n') };
  }

  // 2) Node 测试
  const nodeTest = spawn('npm', ['test'], { cwd: ROOT, shell: true });
  if (nodeTest.status !== 0) {
    stderr.push('[verify] Node 测试失败');
    return { exitCode: 1, stdout: nodeTest.stdout?.toString() || '', stderr: stderr.join('\n') };
  }

  // 3) Python 测试（目录存在时）
  if (fs.existsSync(path.join(ROOT, 'ai-service-langchain'))) {
    const py = spawn('python', ['-m', 'pytest', 'ai-service-langchain/tests', '-q'], { cwd: ROOT, shell: true });
    if (py.status !== 0) {
      stderr.push('[verify] Python 测试失败');
      return { exitCode: 1, stdout: py.stdout?.toString() || '', stderr: stderr.join('\n') };
    }
  }

  // 4) Docker Compose 配置校验（存在时）
  if (fs.existsSync(path.join(ROOT, 'docker-compose.yml'))) {
    const dc = spawn('docker', ['compose', 'config', '--quiet'], { cwd: ROOT, shell: true });
    if (dc.status !== 0) {
      stderr.push('[verify] Docker Compose 配置校验失败');
      return { exitCode: 1, stdout: dc.stdout?.toString() || '', stderr: stderr.join('\n') };
    }
  }

  return { exitCode: 0, stdout: '[verify] 发布前验证通过', stderr: '' };
}

if (require.main === module) {
  const result = runVerifyRelease({});
  process.stdout.write(result.stdout + '\n');
  if (result.stderr) process.stderr.write(result.stderr + '\n');
  process.exit(result.exitCode);
}

module.exports = { runVerifyRelease };
