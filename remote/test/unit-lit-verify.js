'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { clickTurnstile } = require('../server/literature/browser/verify');
const { createLibrary } = require('../server/literature/browser/library');
const { createFakeBrowser } = require('./fake-browser');

const src = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/test';
const frame = (url = src, id = 9) => ({ nodeName: 'IFRAME', backendNodeId: id, frameId: 'CF_' + id, attributes: ['src', url] });
function client(nodes, { quad = [650, 220, 950, 220, 950, 285, 650, 285], width = 1920, height = 1080, hidden = false } = {}) {
  const events = [];
  let discovered = false;
  return { events, async attach() { assert.ok(discovered, 'cross-origin frame must be discovered before attach'); return 'widget'; }, async send(method, params, sid) {
    if (method === 'Target.getTargets') { discovered = true; return { targetInfos: [{ targetId: 'CF_9', type: 'iframe' }] }; }
    if (method === 'DOM.getDocument' && sid === 'widget') return { root: { nodeName: '#document', children: [{ nodeName: 'INPUT', backendNodeId: 10, attributes: ['type', 'checkbox'] }] } };
    if (method === 'DOM.getDocument') return { root: { nodeName: '#document', children: nodes } };
    if (method === 'DOM.getBoxModel') { if (hidden) throw new Error('no box'); return { model: { content: sid === 'widget' ? [9, 20.5, 139, 20.5, 139, 44.5, 9, 44.5] : quad } }; }
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: width, clientHeight: height } };
    if (method === 'Input.dispatchMouseEvent') { events.push(params); return {}; }
    throw new Error(method);
  } };
}

test('finds the visible normal widget through shadow roots and sends one ordinary click', async () => {
  const c = client([{ nodeName: 'DIV', shadowRoots: [{ nodeName: '#document-fragment', children: [frame()] }] }]);
  assert.equal(await clickTurnstile(c, 's'), true);
  assert.deepEqual(c.events.map(e => e.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(c.events.every(e => e.x === 671 && e.y === 252.5));
});

test('does not click unknown, hidden, ambiguous, offscreen, nested or different-size widgets', async () => {
  const cases = [
    client([frame('https://challenges.cloudflare.com.evil.test/cdn-cgi/challenge-platform/turnstile/f/test')]),
    client([frame('https://www.google.com/recaptcha/api2/anchor')]),
    client([frame()], { hidden: true }), client([frame(), frame(src, 10)]),
    client([frame()], { width: 600 }), client([frame()], { height: 200 }),
    client([frame()], { quad: [650, 220, 800, 220, 800, 360, 650, 360] }),
    client([{ nodeName: 'IFRAME', attributes: ['src', 'https://login.test/'], contentDocument: { nodeName: '#document', children: [frame()] } }]),
  ];
  for (const c of cases) { assert.equal(await clickTurnstile(c, 's', { waitMs: 0 }), false); assert.equal(c.events.length, 0); }
});

const pdf = Buffer.from('%PDF-1.4\n' + 'a test PDF body\n'.repeat(60));
async function setup(t, opts = {}) {
  const browser = createFakeBrowser({ pdf });
  browser.turnstile = true;
  const port = await browser.listen();
  t.after(() => browser.close());
  const logs = [];
  const library = createLibrary({ port: () => port, access: null, stepMs: 5, settleMs: 1, slowMs: 10, loadMs: 300,
    checkMs: 5, verifyMs: 50, quietMs: 30, pdfMs: 300, absMs: 300, lookMs: 5, log: s => logs.push(s), ...opts });
  return { browser, library, logs };
}

test('an article checkbox is passed and the real PDF capture path proceeds', async t => {
  const { browser, library, logs } = await setup(t);
  const got = await library.fetch({ doi: '10.1016/check' });
  assert.deepEqual(got.buf, pdf);
  assert.equal(browser.checkClicks, 1);
  assert.equal(browser.opened, browser.closed);
  assert.ok(logs.some(s => /已通过/.test(s)));
});

test('a challenge at the PDF address is verified and the same PDF is captured again', async t => {
  const { browser, library } = await setup(t);
  browser.pdfChallenge = true;
  const got = await library.fetch({ doi: '10.1016/ok' });
  assert.deepEqual(got.buf, pdf);
  assert.equal(browser.checkClicks, 1);
  assert.equal(browser.log.filter(u => /pdfft/.test(u)).length, 2);
});

test('an unsuccessful checkbox leaves the paper waiting for the user and is never called success', async t => {
  const { browser, library, logs } = await setup(t);
  browser.checkPass = false;
  await assert.rejects(library.fetch({ doi: '10.1016/check' }), e => e.need === 'verify');
  assert.equal(browser.checkClicks, 1);
  assert.equal(browser.opened - browser.closed, 1);
  assert.ok(!logs.some(s => /已通过/.test(s)));
});

test('abstract fetching continues after the checkbox instead of abandoning the publisher for the day', async t => {
  const { browser, library } = await setup(t);
  const got = await library.abstract({ doi: '10.1016/check' });
  assert.ok(got.abs.length >= 80);
  assert.equal(browser.checkClicks, 1);
  assert.equal(browser.opened, browser.closed);
});

test('waits through the widget spinner and clicks only when an actual checkbox has rendered', async t => {
  const { browser, library } = await setup(t);
  browser.readyAfter = 3;
  const got = await library.abstract({ doi: '10.1016/check' });
  assert.ok(got.abs.length >= 80);
  assert.ok(browser.widgetLooks > 3);
  assert.equal(browser.checkClicks, 1);
});
