// context fill: transcript usage -> ctx records (Claude / Codex), the agent's window, the store keeping only the latest
const fs = require('fs'), path = require('path'), os = require('os');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x)));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-ctx-'));
process.env.HOME = process.env.USERPROFILE = T;
delete process.env.ANTHROPIC_MODEL;
const { recordsOf } = require('../../app/transcript');
const codex = require('../agent/codex-records');
const records = require('../agent/records');
const { createStore } = require('../server/store');
const J = (o) => JSON.stringify(o) + '\n';
const asst = (uuid, ts, usage, side) => ({ type: 'assistant', uuid, isSidechain: !!side, timestamp: ts, message: { id: 'm' + uuid, role: 'assistant', content: [{ type: 'text', text: 'hi ' + uuid }], usage } });
const r1 = recordsOf(asst('a', '2026-10-01T10:00:00Z', { input_tokens: 5, cache_read_input_tokens: 100000, cache_creation_input_tokens: 2000, output_tokens: 300 }));
chk('claude: a ctx record with the sum, window left open', r1.some((r) => r.role === 'ctx' && r.text === '102305/0'), r1);
chk('claude: sidechain (subagent) usage ignored', !recordsOf(asst('b', '2026-10-01T10:00:00Z', { input_tokens: 9 }, true)).length, 0);
const rc = codex.recordsOf({ timestamp: '2026-10-01T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 136369 }, model_context_window: 258400 } } });
chk('codex: used/window from token_count', rc.length === 1 && rc[0].text === '136369/258400', rc);
chk('codex: token_count without info ignored', !codex.recordsOf({ type: 'event_msg', payload: { type: 'token_count', info: null } }).length, 0);
// the agent's reader fills the Claude window: 1M (the current models), 200k for a reply by Haiku
const haiku = asst('d', '2026-10-01T10:03:00Z', { input_tokens: 1, cache_read_input_tokens: 30000, output_tokens: 10 }); haiku.message.model = 'claude-haiku-4-5-20251001';
const opus = asst('e', '2026-10-01T10:04:00Z', { input_tokens: 1, cache_read_input_tokens: 40000, output_tokens: 10 }); opus.message.model = 'claude-opus-5-5';
const f = path.join(T, 's.jsonl');
fs.writeFileSync(f, J(asst('a', '2026-10-01T10:00:00Z', { input_tokens: 1, cache_read_input_tokens: 150000, output_tokens: 10 })) +
  J(asst('b', '2026-10-01T10:01:00Z', { input_tokens: 1, cache_read_input_tokens: 250000, output_tokens: 10 })) +
  J(haiku) + J(opus) +
  J(asst('c', '2026-10-01T10:02:00Z', { input_tokens: 1, cache_read_input_tokens: 20000, output_tokens: 10 })));
const rd = records.createReader(f, 0);
const b = records.readNext(rd);
const ctx = b.recs.filter((r) => r.role === 'ctx').map((r) => r.text);
chk('reader: a 1M window whatever the fill; 200k for a reply by Haiku', JSON.stringify(ctx) === JSON.stringify(['150011/1000000', '250011/1000000', '30011/200000', '40011/1000000', '20011/1000000']), ctx);
// the store keeps only the latest in its state, never in the day logs
const st = createStore(path.join(T, 'data'));
const recs = b.recs.map((r) => ({ ...r }));
const a = st.accept('pc', { id: 'S1', from: 0, to: 100, recs });
chk('store: accepted, flagged for a broadcast', a.ok && a.modeChanged, a);
const e = st.sessions().pc.find((x) => x.id === 'S1');
chk('store: latest ctx in the session list', e.ctx && e.ctx.used === 20011 && e.ctx.win === 1e6, e);
st.flush && st.flush();
const logged = st.records('pc', 'S1', 0, Date.now() + 1e9);
chk('store: ctx not in the log', logged.length > 0 && !logged.some((r) => r.role === 'ctx'), logged.map((r) => r.role));
const a2 = st.accept('pc', { id: 'S1', from: 100, to: 200, recs: [{ role: 'ctx', text: '20500/1000000', t: Date.parse('2026-10-01T10:03:00Z') }] });
chk('store: under a percent of change is not broadcast', a2.ok && !a2.modeChanged, a2);
chk('store: bad ctx ignored', st.accept('pc', { id: 'S1', from: 200, to: 300, recs: [{ role: 'ctx', text: 'x/y', t: 1 }] }).ok && st.sessions().pc[0].ctx.used === 20500, st.sessions().pc[0]);
fs.rmSync(T, { recursive: true, force: true });
console.log(res.join('\n'));
