'use strict';
// Shared Unix CLI binary lookup and prefixed UUID parser for headless/*.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

function findUnixBin(name, env = process.env) {
  const pathStr = (env && env.PATH) || process.env.PATH || '';
  for (const dir of pathStr.split(path.delimiter)) {
    const f = dir && path.join(dir, name);
    if (f && fs.existsSync(f)) return f;
  }
  const localBin = path.join(os.homedir(), '.local', 'bin', name);
  return fs.existsSync(localBin) ? localBin : null;
}

function makeThreadOf(prefix, caseInsensitive = true) {
  const idRe = new RegExp('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseInsensitive ? 'i' : '');
  const prefixRe = new RegExp(`^${prefix}:(.+)$`);
  return (id) => {
    const m = prefixRe.exec(String(id));
    return m && idRe.test(m[1]) ? m[1] : null;
  };
}

module.exports = { findUnixBin, makeThreadOf };
