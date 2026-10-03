// Phone notifications (server/push/): the message decrypts as a browser would (RFC 8291), the VAPID signature checks out
// with the public key (RFC 8292), only browsers' push services are accepted, a gone subscription is dropped, a device
// on screen gets nothing, and the events that notify (approval, finished, context, mail) -- through a stand-in push service.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const wp = require('../server/push/webpush');
const { createPush } = require('../server/push');
const { createPushEvents } = require('../server/push/events');
const res = []; const chk = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x).slice(0, 400)));
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

// a browser's side of a subscription, and its decryption
function browser() {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, endpoint: 'https://fcm.googleapis.com/fcm/send/abc' + crypto.randomBytes(4).toString('hex'), keys: { p256dh: wp.b64u(ua.getPublicKey()), auth: wp.b64u(auth) } };
}
function decrypt(b, body) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const shared = b.ua.computeSecret(asPublic);
  const ikm = hmac(hmac(b.auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), b.ua.getPublicKey(), asPublic, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return { rs, text: plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'), delim: plain[plain.length - 1] };
}

(async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-push-'));
  try {
    // the cryptography
    const b = browser();
    const msg = JSON.stringify({ title: '需要确认 · Bash', body: 'npm test 中文 ✓' });
    const dec = decrypt(b, wp.encrypt(b, msg));
    chk('encryption: the browser decrypts it to the same text (one record, last-record mark)', dec.text === msg && dec.delim === 2 && dec.rs === 4096, dec);
    const keys = wp.newKeys();
    const auth = wp.vapid(b.endpoint, keys, 'mailto:x@y');
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
    const pub = wp.fromB64u(keys.publicKey);
    const pubKey = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: wp.b64u(pub.subarray(1, 33)), y: wp.b64u(pub.subarray(33)) } });
    const okSig = m && crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pubKey, dsaEncoding: 'ieee-p1363' }, wp.fromB64u(m[3]));
    const claims = m && JSON.parse(wp.fromB64u(m[2]).toString());
    chk('VAPID: signed with the server key, for that push service, expiring', okSig && m[4] === keys.publicKey && claims.aud === 'https://fcm.googleapis.com' && claims.exp > Date.now() / 1000 && claims.sub === 'mailto:x@y', { claims, okSig });
    chk('only browsers\' push services', wp.okEndpoint('https://fcm.googleapis.com/x') && wp.okEndpoint('https://web.push.apple.com/x') && wp.okEndpoint('https://updates.push.services.mozilla.com/x') &&
      !wp.okEndpoint('http://fcm.googleapis.com/x') && !wp.okEndpoint('https://192.168.1.6/x') && !wp.okEndpoint('https://evil.com/googleapis.com') && !wp.okEndpoint('https://fcm.googleapis.com:8443/x') && !wp.okEndpoint('https://googleapis.com.evil.com/x'), 0);

    // the module, with a stand-in push service
    const posted = []; let answer = 201;
    const request = async (url, opts) => { posted.push({ url, headers: opts.headers, body: opts.body }); return { status: typeof answer === 'function' ? answer(url) : answer, body: Buffer.from('') }; };
    const push = createPush({ dataDir: T, request, subject: 'https://win98.example.org' });
    const st = fs.statSync(path.join(T, 'push.json'));
    chk('server key made once, kept private (0600 on Linux)', push.publicKey().length > 80 && (process.platform === 'win32' || (st.mode & 0o777) === 0o600), st.mode.toString(8));
    const api = async (p, body) => { let out; const r = { req: { method: body === undefined ? 'GET' : 'POST' } };
      const req = Object.assign(require('stream').Readable.from([Buffer.from(JSON.stringify(body || {}))]), { method: r.req.method });
      await push.handle(req, null, p, '1.2.3.4', (_, __, o) => { out = o; }, async () => JSON.stringify(body || {})); return out; };
    chk('subscribe: an endpoint that is not a push service is refused', !(await api('/api/push/subscribe', { sub: { endpoint: 'https://127.0.0.1/x', keys: b.keys }, name: 'x' })).ok, 0);
    const phone = browser(), pc = browser();
    const s1 = await api('/api/push/subscribe', { sub: { endpoint: phone.endpoint, keys: phone.keys }, name: '安卓 Chrome' });
    const s2 = await api('/api/push/subscribe', { sub: { endpoint: pc.endpoint, keys: pc.keys }, name: 'Windows Edge' });
    const info = await api('/api/push');
    chk('subscribe: two devices, all kinds on, the key for the page', s1.ok && s2.ok && info.devices.length === 2 && info.devices.every((d) => d.kinds.approval && d.kinds.mail) && info.key === push.publicKey(), info);
    // events
    const ev = createPushEvents({ push });
    const S = (state, perms = [], lines = []) => ({ id: 'S1', label: 'demo 会话', state, perms, lines });
    const P = { id: 'p1', tool: 'Bash', input: JSON.stringify({ command: 'npm test' }) };
    ev.sessions('box', [S('waiting', [P])], true);
    await new Promise((r) => setTimeout(r, 50));
    chk('first report after connecting: noted, not told', posted.length === 0, posted.length);
    ev.sessions('box', [S('waiting', [P, { ...P, id: 'p2', input: JSON.stringify({ command: 'rm -rf build' }) }])], true);
    await new Promise((r) => setTimeout(r, 50));
    const got = posted.map((p) => JSON.parse(decrypt(p.url === phone.endpoint ? phone : pc, p.body).text));
    chk('a new approval: to both devices, once, with the command and a link to the session', posted.length === 2 && got.every((g) => g.kind === 'approval' && g.title === '需要确认 · Bash' && g.body.includes('rm -rf build') && g.url === '/#s=' + encodeURIComponent('box|S1')), got);
    chk('approval: urgent, encrypted, signed', posted.every((p) => p.headers.Urgency === 'high' && p.headers['Content-Encoding'] === 'aes128gcm' && /^vapid t=/.test(p.headers.Authorization)), posted.map((p) => p.headers));
    posted.length = 0;
    ev.sessions('box', [S('waiting', [P])], false);
    chk('where approvals cannot be answered from here (no control): not told', posted.length === 0, 0);
    // a device on screen gets nothing
    push.here(pc.endpoint, true);
    ev.sessions('box', [S('waiting', [{ ...P, id: 'p3' }])], true);
    await new Promise((r) => setTimeout(r, 50));
    chk('the device showing Windose gets nothing, the other does', posted.length === 1 && posted[0].url === phone.endpoint, posted.map((p) => p.url));
    push.here(pc.endpoint, false); posted.length = 0;
    // finished after a while of work (the clock moved on)
    const realNow = Date.now; let now = realNow();
    Date.now = () => now;
    try {
      ev.sessions('box', [S('message')], true);
      now += 30e3; ev.sessions('box', [S('done', [], [{ text: '改好了' }])], true);
      await new Promise((r) => setTimeout(r, 50));
      chk('done after half a minute of work: not worth telling', posted.length === 0, posted.length);
      ev.sessions('box', [S('thinking')], true);
      now += 3 * 60e3; ev.sessions('box', [S('done', [], [{ text: '全部测试通过' }])], true);
      await new Promise((r) => setTimeout(r, 50));
      const g = posted.map((p) => JSON.parse(decrypt(p.url === phone.endpoint ? phone : pc, p.body).text));
      chk('done after three minutes of work: told, with its last line', posted.length === 2 && g[0].kind === 'done' && g[0].title === '完成 · demo 会话' && g[0].body.includes('全部测试通过'), g);
    } finally { Date.now = realNow; }
    posted.length = 0;
    // context nearly full: once, again only after it was freed
    ev.ctx('box', 'S1', { used: 120000, win: 200000 }, 'demo 会话');
    ev.ctx('box', 'S1', { used: 155000, win: 200000 }, 'demo 会话');
    ev.ctx('box', 'S1', { used: 160000, win: 200000 }, 'demo 会话');
    await new Promise((r) => setTimeout(r, 50));
    chk('context at 7% left: told once', posted.length === 2 && JSON.parse(decrypt(phone, posted.find((p) => p.url === phone.endpoint).body).text).kind === 'ctx', posted.length);
    posted.length = 0;
    // a device that turned a kind off; mail
    await api('/api/push/update', { id: s2.id, kinds: { mail: false } });
    ev.mail({ id: 'm1', key: 'acc:1:5', kind: 'action', subject: '关于年度报销的通知', todo: '提交报销单', deadline: '2026-10-15' });
    await new Promise((r) => setTimeout(r, 50));
    const mg = posted.map((p) => JSON.parse(decrypt(phone, p.body).text));
    chk('mail: only to the device that wants it, with what to do and the deadline, opening that message', posted.length === 1 && posted[0].url === phone.endpoint && mg[0].title.startsWith('邮件待办') && mg[0].body.includes('截止 2026-10-15') && mg[0].url === '/#mail=' + encodeURIComponent('acc:1:5'), mg);
    // the push service says the subscription is gone: dropped
    posted.length = 0; answer = (url) => (url === phone.endpoint ? 410 : 201);
    const t = await api('/api/push/test', {});
    chk('test: to every device; a gone subscription (410) is dropped', posted.length === 2 && (await api('/api/push')).devices.map((d) => d.name).join() === 'Windows Edge', [t, (await api('/api/push')).devices]);
    chk('remove', (await api('/api/push/remove', { id: s2.id })).ok && (await api('/api/push')).devices.length === 0, 0);
  } catch (e) { res.push('FAIL script ' + e.stack); }
  finally { fs.rmSync(T, { recursive: true, force: true }); }
  console.log(res.join('\n'));
})();
