// Shared node:sqlite loader (without leaking process.emitWarning wrappers) and corrupt-DB quarantine helper.
'use strict';
const fs = require('fs');

let cachedSqlite = undefined;

function loadSqlite() {
  if (cachedSqlite !== undefined) return cachedSqlite;
  const origEmit = process.emitWarning;
  process.emitWarning = function suppressSqliteWarning(w, ...rest) {
    if (/SQLite/i.test(String((w && w.message) || w))) return;
    return origEmit.call(process, w, ...rest);
  };
  try {
    cachedSqlite = require('node:sqlite');
  } catch {
    cachedSqlite = null;
  } finally {
    setImmediate(() => {
      if (process.emitWarning !== origEmit) process.emitWarning = origEmit;
    });
  }
  return cachedSqlite;
}

function quarantineSqliteFiles(file) {
  for (const sfx of ['', '-wal', '-shm']) {
    const src = file + sfx;
    const dst = src + '.bad';
    try { fs.rmSync(dst, { force: true }); } catch {}
    try { fs.renameSync(src, dst); } catch {}
  }
}

module.exports = {
  loadSqlite,
  quarantineSqliteFiles,
};
