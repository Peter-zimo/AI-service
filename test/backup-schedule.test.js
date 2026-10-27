const test = require('node:test');
const assert = require('node:assert/strict');

const { localDateStr, nextBackupDelay } = require('../server/infra/db/backup-schedule');

const HOUR = 60 * 60 * 1000;

test('localDateStr uses local calendar date', () => {
  assert.equal(localDateStr(new Date(2026, 9, 27, 23, 59, 59)), '2026-10-27');
  assert.equal(localDateStr(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01');
});

test('nextBackupDelay targets today 03:00 when before 03:00', () => {
  const now = new Date(2026, 9, 27, 0, 30, 0, 0);
  const next = new Date(now.getTime() + nextBackupDelay(now));
  assert.equal(next.getDate(), 27);
  assert.equal(next.getHours(), 3);
  assert.equal(next.getMinutes(), 0);
  assert.equal(nextBackupDelay(now), 2.5 * HOUR);
});

test('nextBackupDelay targets next day at exactly 03:00', () => {
  const now = new Date(2026, 9, 27, 3, 0, 0, 0);
  const next = new Date(now.getTime() + nextBackupDelay(now));
  assert.equal(next.getDate(), 28);
  assert.equal(next.getHours(), 3);
  assert.equal(nextBackupDelay(now), 24 * HOUR);
});

test('nextBackupDelay targets next day after 03:00', () => {
  const now = new Date(2026, 9, 27, 4, 0, 0, 0);
  const next = new Date(now.getTime() + nextBackupDelay(now));
  assert.equal(next.getDate(), 28);
  assert.equal(next.getHours(), 3);
  assert.equal(nextBackupDelay(now), 23 * HOUR);
});

test('nextBackupDelay targets next day late at night', () => {
  const now = new Date(2026, 9, 27, 23, 59, 0, 0);
  const next = new Date(now.getTime() + nextBackupDelay(now));
  assert.equal(next.getDate(), 28);
  assert.equal(next.getHours(), 3);
  assert.equal(nextBackupDelay(now), 3 * HOUR + 60 * 1000);
});

test('nextBackupDelay handles 02:59:59.999', () => {
  const now = new Date(2026, 9, 27, 2, 59, 59, 999);
  const next = new Date(now.getTime() + nextBackupDelay(now));
  assert.equal(next.getDate(), 27);
  assert.equal(next.getHours(), 3);
  assert.equal(nextBackupDelay(now), 1);
});

test('nextBackupDelay crosses year boundary', () => {
  const now = new Date(2026, 11, 31, 4, 0, 0, 0);
  const next = new Date(now.getTime() + nextBackupDelay(now));
  assert.equal(next.getFullYear(), 2027);
  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), 3);
  assert.equal(nextBackupDelay(now), 23 * HOUR);
});
