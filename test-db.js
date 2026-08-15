const db = require('./server/services/database');
console.log('exports:', Object.keys(db));
console.log('_db type:', typeof db._db);
console.log('has prepare:', typeof db._db?.prepare);
