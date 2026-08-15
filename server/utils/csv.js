function parseCsv(text) {
  const records = [];
  let record = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      record.push(value);
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      record.push(value);
      if (record.some(cell => cell !== '')) records.push(record);
      record = [];
      value = '';
    } else {
      value += char;
    }
  }
  record.push(value);
  if (record.some(cell => cell !== '')) records.push(record);

  const [headers = [], ...data] = records;
  return data.map(row => Object.fromEntries(headers.map((header, index) => [header.trim(), row[index] || ''])));
}

function escapeValue(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const lines = [headers, ...rows.map(row => headers.map(header => row[header]))];
  return lines.map(row => row.map(escapeValue).join(',')).join('\r\n');
}

module.exports = { parseCsv, toCsv };
