// remote/deploy/deploy-lib.js: telling a machine's files apart -- the same as the commit, an older version git knows
// (updated), a version git never had (edited on the machine: stops the deploy), files the commit does not have.
// (No ssh here: the machine's files are made up.)
const fs = require('fs'), path = require('path'), os = require('os');
const { blobId, treeOf, compare, git } = require('../deploy/deploy-lib');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-deploy-t-'));
try {
  // blob ids as git computes them, also for a file with Windows line ends (git stores text with LF)
  const lf = path.join(T, 'a.txt'); fs.writeFileSync(lf, 'one\ntwo\n');
  chk('blob id: as git hash-object', blobId(fs.readFileSync(lf)) === git(['hash-object', '--no-filters', lf]), 0);
  chk('blob id: CRLF text counts as its LF version', blobId(Buffer.from('one\r\ntwo\r\n')) === blobId(Buffer.from('one\ntwo\n')), 0);
  chk('blob id: binary (has a NUL) left as it is', blobId(Buffer.from('a\r\n\0')) !== blobId(Buffer.from('a\n\0')), 0);
  // a real commit's tree vs a made-up machine
  const tree = treeOf('HEAD', ['remote/deploy']);
  const [[p1, id1], [p2]] = [...tree];                             // (p2: edited on the machine)
  const older = git(['log', '--format=%H', '-n', '2', '--', 'remote/server/server.js']).split('\n')[1];
  const oldServer = older ? git(['rev-parse', `${older}:remote/server/server.js`]) : null;
  const machine = new Map([[p1, id1], [p2, blobId(Buffer.from('// edited on the NAS\n'))], ['remote/deploy/notes.txt', 'x'.repeat(40)]]);
  const tree2 = new Map(tree); if (oldServer) { tree2.set('remote/server/server.js', git(['rev-parse', 'HEAD:remote/server/server.js'])); machine.set('remote/server/server.js', oldServer); }
  const c = compare(machine, tree2);
  chk('compare: an edit git never had is reported', c.local.includes(p2), c);
  chk('compare: an older version git knows is just updated, not an edit', !oldServer || (c.changed.includes('remote/server/server.js') && !c.local.includes('remote/server/server.js')), c);
  chk('compare: the same file is left alone', !c.changed.includes(p1), c);
  chk('compare: files the commit does not have are listed apart', c.extra.includes('remote/deploy/notes.txt'), c);
  chk('compare: files missing on the machine are uploaded', [...tree2.keys()].filter((p) => !machine.has(p)).every((p) => c.changed.includes(p)), c);
} catch (e) { res.push('FAIL script ' + e.stack); }
finally { fs.rmSync(T, { recursive: true, force: true }); }
console.log(res.join('\n'));
