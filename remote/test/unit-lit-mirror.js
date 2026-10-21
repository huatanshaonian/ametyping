// The Zotero mirror's error state: a failed read (Zotero not up yet after a reboot) must clear as soon as Zotero
// answers again, even when the library has not changed since the last copy (the version check returns early).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMirror } = require('../server/literature/zotero/mirror');

let pass = 0, fail = 0;
const ok = (name, c, extra) => { if (c) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-mirror-'));
  let up = true, reads = 0;
  const api = {
    serverId: () => 'srv',
    version: async () => { if (!up) throw new Error('connect ECONNREFUSED 127.0.0.1:23119'); return 7; },
    get: async (p) => { reads++; return p.startsWith('items') ? { version: 7, data: [{ data: { key: 'A1', itemType: 'journalArticle', title: 'Sheath', creators: [], date: '2020' } }] } : { version: 7, data: [] }; },
  };

  const m1 = createMirror({ api, dir, everyMs: 0 });
  ok('first read copies the library', await m1.refresh() === true && m1.items().length === 1 && m1.status().error === '');

  // the server restarts while Zotero is still starting: the copy on disk is kept, the failure is shown
  up = false;
  const m2 = createMirror({ api, dir, everyMs: 0 });
  let err = '';
  try { await m2.refresh(); } catch (e) { err = e.message; }
  ok('a refused connection is reported', /ECONNREFUSED/.test(err) && /ECONNREFUSED/.test(m2.status().error), m2.status().error);
  ok('the copy on disk is still there', m2.items().length === 1);

  // Zotero comes up, nothing in the library changed: no new read, and the error is gone
  up = true; reads = 0;
  ok('Zotero back, library unchanged: nothing re-read', await m2.refresh() === false && reads === 0);
  ok('...and the old error is cleared', m2.status().error === '', m2.status().error);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
