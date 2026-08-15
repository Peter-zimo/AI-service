const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, toCsv } = require('../server/utils/csv');

test('CSV utilities preserve quoted commas and line breaks', () => {
  const rows = parseCsv('question,answer,keywords\n"What, now?","Line 1\nLine 2","a,b"');

  assert.deepEqual(rows, [{
    question: 'What, now?',
    answer: 'Line 1\nLine 2',
    keywords: 'a,b'
  }]);
});

test('CSV export escapes formulas and quotes', () => {
  const csv = toCsv([{ question: '=SUM(A1:A2)', answer: 'He said "hello"' }]);

  assert.equal(csv, 'question,answer\r\n\'=SUM(A1:A2),"He said ""hello"""');
});
