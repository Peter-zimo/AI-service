try {
  const path = require('path');
  const db = require(path.join(__dirname, 'server/services/database'));
  console.log('OK - exports:', Object.keys(db));
  console.log('_db type:', typeof db._db);
} catch(e) {
  console.log('FAIL:', e.message);
}
