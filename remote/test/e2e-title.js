// A conversation's name after /rename (app/transcript.js): the given name beats the made-up one wherever it is read --
// the panel's poll, the agent's records to the server, the server's store -- although Claude Code writes the made-up
// one again right after it around every message. And the store saying when a name changed (for the server to tell
// the pages and the pets: e2e-launch.js follows that through).
const fs = require('fs'), os = require('os'), path = require('path');
const R = path.resolve(__dirname, '..');
const transcript = require(path.resolve(R, '..', 'app', 'transcript.js'));
const records = require(R + '/agent/records.js');
const { createStore } = require(R + '/server/store.js');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-title-'));
const SID = '11111111-2222-3333-4444-555555555555';

let n = 0;
const L = (o) => JSON.stringify(o.type === 'user' || o.type === 'assistant' ? { uuid: 'u' + (++n), timestamp: new Date(Date.UTC(2026, 9, 1, 10, 0, n)).toISOString(), ...o } : { ...o, sessionId: SID }) + '\n';
const user = (text) => L({ type: 'user', message: { role: 'user', content: text } });
const asst = (text) => L({ type: 'assistant', message: { id: 'm' + n, role: 'assistant', content: [{ type: 'text', text }] } });
// what Claude Code writes around a message: the metadata again, the given name (if any) before the made-up one
const meta = (given) => L({ type: 'last-prompt', lastPrompt: 'x' }) + (given ? L({ type: 'custom-title', customTitle: given }) : '') +
  L({ type: 'ai-title', aiTitle: '自动起的名字' }) + (given ? L({ type: 'agent-name', agentName: given }) : '') + L({ type: 'permission-mode', permissionMode: 'auto' });

const F = path.join(T, SID + '.jsonl');
fs.writeFileSync(F, user('你好') + meta() + asst('在呢'));
const titles = (file, from = 0) => { const r = records.createReader(file, from); const out = []; for (let b; (b = records.readNext(r)); r.offset = b.to) out.push(...b.recs); return { recs: out.filter((x) => x.role === 'title').map((x) => x.text), all: out, r }; };

// before any /rename: the made-up name
const cache = { file: F };
transcript.poll(cache);
chk('no /rename: the made-up name (panel)', cache.title === '自动起的名字', cache.title);
// /rename: Claude Code writes the given name (and the agent name); then the next message, with the metadata again
fs.appendFileSync(F, L({ type: 'custom-title', customTitle: '我起的名字' }) + L({ type: 'agent-name', agentName: '我起的名字' }));
transcript.poll(cache);
chk('right after /rename: the given name (panel)', cache.title === '我起的名字', cache.title);
fs.appendFileSync(F, user('继续') + meta('我起的名字') + asst('好'));
transcript.poll(cache);
chk('the next message writes the made-up name after it again: still the given name (panel)', cache.title === '我起的名字', cache.title);

// the agent's records, read from the start and from part way (an agent restarted: the reader starts where the server stands)
const all = titles(F);
chk('records to the server: the made-up name, then only the given one', all.recs.join() === '自动起的名字,我起的名字,我起的名字', all.recs);
const mid = fs.readFileSync(F, 'utf8').indexOf('"继续"'), off = Buffer.byteLength(fs.readFileSync(F, 'utf8').slice(0, fs.readFileSync(F, 'utf8').lastIndexOf('\n', mid) + 1));
const part = titles(F, off);
chk('a reader started after the /rename: the given name, not the made-up one written after it', part.recs.join() === '我起的名字', part.recs);
// a second /rename: the newest given name
fs.appendFileSync(F, L({ type: 'custom-title', customTitle: '又改了' }) + user('再来') + meta('又改了'));
const again = titles(F, off);
chk('renamed again: the newest given name', again.recs[again.recs.length - 1] === '又改了' && !again.recs.includes('自动起的名字'), again.recs);
transcript.poll(cache);
chk('renamed again (panel)', cache.title === '又改了', cache.title);
// no state to keep (a caller that reads one line alone): each title as it is, as before
chk('one line alone: the made-up name is still a title', transcript.recordsOf(JSON.parse(L({ type: 'ai-title', aiTitle: 'A' }))).map((r) => r.text).join() === 'A', 0);

// the server's store, fed what the agent sends
const store = createStore(path.join(T, 'store'));
const size = fs.statSync(F).size;
store.accept('pc', { id: SID, from: 0, to: size, recs: all.all.concat(again.all) });
const listed = (store.sessions().pc || []).find((e) => e.id === SID);
chk('the server lists it under the given name', listed && listed.title === '又改了', listed);

// the store says when a batch renamed it (the server then tells every page and every machine), and only then
const s2 = createStore(path.join(T, 'store2'));
const G = path.join(T, 'g.jsonl');
fs.writeFileSync(G, user('a') + meta());
const g1 = titles(G), a1 = s2.accept('pc', { id: 'g', from: 0, to: fs.statSync(G).size, recs: g1.all });
const at1 = fs.statSync(G).size;
fs.appendFileSync(G, asst('b') + meta());
const a2 = s2.accept('pc', { id: 'g', from: at1, to: fs.statSync(G).size, recs: titles(G, at1).all });
const at2 = fs.statSync(G).size;
fs.appendFileSync(G, L({ type: 'custom-title', customTitle: '新名字' }) + L({ type: 'agent-name', agentName: '新名字' }) + user('c') + meta('新名字'));
const a3 = s2.accept('pc', { id: 'g', from: at2, to: fs.statSync(G).size, recs: titles(G, at2).all });
chk('store: the first name, then nothing while it stays, then the new one after /rename', a1.title === '自动起的名字' && a2.title === undefined && a3.title === '新名字', [a1.title, a2.title, a3.title]);

store.flush && store.flush();
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(res.join('\n'));
const failed = res.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${res.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
