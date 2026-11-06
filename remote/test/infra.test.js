'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../server/auth');
const { createInfra } = require('../server/infra');
const { stateSignature } = require('../agent/infra-probe');

function mockReqRes(method, urlStr, body = null, headers = {}) {
  const url = new URL(urlStr, 'http://localhost');
  const req = {
    method,
    url: urlStr,
    headers,
    on: (ev, fn) => { if (ev === 'end') setImmediate(fn); },
  };
  let status = 0, payload = null;
  const res = {};
  const json = (_res, code, obj) => { status = code; payload = obj; };
  const readBody = async () => (body ? JSON.stringify(body) : '');
  return { req, res, url, json, readBody, getStatus: () => status, getPayload: () => payload };
}

describe('infra monitor & topology', () => {
  it('seeds default nodes (nas, openwrt, aws1, gcp1) and links', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-infra-test-'));
    try {
      const infra = createInfra({ dataDir: tmp, localNas: false });
      const snap = infra.snapshot();
      const ids = snap.nodes.map((n) => n.id);
      assert.ok(ids.includes('openwrt'));
      assert.ok(ids.includes('nas'));
      assert.ok(ids.includes('aws1'));
      assert.ok(ids.includes('gcp1'));
      assert.ok(snap.links.length >= 8);
      assert.equal(snap.intervalSec, 60);
      infra.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('authenticates probe Bearer token, ingests reports, and triggers watched service alerts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-infra-test-'));
    try {
      const tok = auth.token();
      const agents = [{ name: 'aws1', hash: auth.hashToken(tok) }];
      const notifications = [];
      const infra = createInfra({
        dataDir: tmp,
        getAgents: () => agents,
        localNas: false,
        notify: (msg) => notifications.push(msg),
      });

      // 1. Reject invalid token
      {
        const m = mockReqRes('POST', '/api/infra/report', { report: {} }, { authorization: 'Bearer wrong' });
        const handled = await infra.handleProbe(m.req, m.res, m.url, '10.0.0.1', m.json, m.readBody);
        assert.equal(handled, true);
        assert.equal(m.getStatus(), 401);
      }

      // 2. Accept valid report from aws1 with all watched services running
      {
        const m = mockReqRes('POST', '/api/infra/report', {
          role: 'cloud',
          report: {
            uptimeSec: 86400,
            load1: 0.15,
            cpuPct: 8,
            mem: { totalMb: 2048, usedMb: 512, pct: 25 },
            disk: { totalGb: 40, usedGb: 12, pct: 30, mount: '/' },
            net: { rxBytes: 1000, txBytes: 2000, rxKbps: 12, txKbps: 34, monthRxGb: 15.4, monthTxGb: 42.8 },
            services: [
              { name: 'danted', state: 'running', port: 1080 },
              { name: 'frps', state: 'running', port: 7000 },
              { name: 'rustdesk-hbbs', state: 'running', port: 21116 },
              { name: 'rustdesk-hbbr', state: 'running', port: 21117 },
              { name: 'nginx', state: 'running', port: 443 },
              { name: 'tailscaled', state: 'running' },
              { name: 'vnstat', state: 'running' },
            ],
          },
        }, { authorization: `Bearer ${tok}` });
        await infra.handleProbe(m.req, m.res, m.url, '100.120.53.46', m.json, m.readBody);
        assert.equal(m.getStatus(), 200);
        assert.equal(m.getPayload().ok, true);
        assert.equal(m.getPayload().intervalSec, 60);
      }

      assert.equal(infra.isNodeOnline('aws1'), true);
      let awsNode = infra.snapshot().nodes.find((n) => n.id === 'aws1');
      assert.equal(awsNode.online, true);
      assert.equal(awsNode.alertCount, 0);
      assert.equal(awsNode.net.monthTxGb, 42.8);

      // 3. Simulate danted stopping -> should record err event and push notification
      {
        const m = mockReqRes('POST', '/api/infra/report', {
          report: {
            uptimeSec: 86460,
            cpuPct: 5,
            services: [
              { name: 'danted', state: 'stopped', port: 1080 },
              { name: 'frps', state: 'running', port: 7000 },
              { name: 'rustdesk-hbbs', state: 'running', port: 21116 },
              { name: 'rustdesk-hbbr', state: 'running', port: 21117 },
              { name: 'nginx', state: 'running', port: 443 },
              { name: 'tailscaled', state: 'running' },
              { name: 'vnstat', state: 'running' },
            ],
          },
        }, { authorization: `Bearer ${tok}` });
        await infra.handleProbe(m.req, m.res, m.url, '100.120.53.46', m.json, m.readBody);
      }

      awsNode = infra.snapshot().nodes.find((n) => n.id === 'aws1');
      assert.equal(awsNode.alertCount, 1);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].body, /danted/);

      infra.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dispatches remote control over HTTP long-poll and enforces TOTP step-up', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-infra-test-'));
    try {
      const tok = auth.token();
      const agents = [{ name: 'openwrt', hash: auth.hashToken(tok) }];
      const infra = createInfra({
        dataDir: tmp,
        getAgents: () => agents,
        localNas: false,
        control: true,
      });

      // 1. Reject control when TOTP is not fresh
      {
        const m = mockReqRes('POST', '/api/infra/control', {
          nodeId: 'openwrt',
          kind: 'singbox',
          target: 'auto',
          op: 'retest',
        });
        await infra.handleBrowser(m.req, m.res, m.url, '127.0.0.1', m.json, m.readBody, () => false);
        assert.equal(m.getPayload().ok, false);
        assert.equal(m.getPayload().need, 'totp');
      }

      // 2. Open long-poll from openwrt probe
      const pollMock = mockReqRes('GET', '/api/infra/poll', null, { authorization: `Bearer ${tok}` });
      await infra.handleProbe(pollMock.req, pollMock.res, pollMock.url, '192.168.114.1', pollMock.json, pollMock.readBody);

      // 3. Browser triggers control with fresh TOTP
      const ctlMock = mockReqRes('POST', '/api/infra/control', {
        nodeId: 'openwrt',
        kind: 'singbox',
        target: 'auto',
        op: 'retest',
      });
      const ctlPromise = infra.handleBrowser(ctlMock.req, ctlMock.res, ctlMock.url, '127.0.0.1', ctlMock.json, ctlMock.readBody, () => true);

      // Wait a tick so long-poll receives the action
      await new Promise((r) => setImmediate(r));
      const pollOut = pollMock.getPayload();
      assert.equal(pollOut.ok, true);
      assert.equal(pollOut.actions.length, 1);
      const act = pollOut.actions[0];
      assert.equal(act.kind, 'singbox');
      assert.equal(act.op, 'retest');

      // 4. Probe posts control-result back
      const resMock = mockReqRes('POST', '/api/infra/control-result', {
        rid: act.rid,
        ok: true,
        msg: '已完成 Sing-box 节点分级重测与切换',
        report: {
          uptimeSec: 3600,
          proxy: { group: 'auto-gold', active: 'HK-Gold-01', delayMs: 38 },
          services: [{ name: 'sing-box', state: 'running', port: 9090 }],
        },
      }, { authorization: `Bearer ${tok}` });
      await infra.handleProbe(resMock.req, resMock.res, resMock.url, '192.168.114.1', resMock.json, resMock.readBody);

      await ctlPromise;
      assert.equal(ctlMock.getPayload().ok, true);
      assert.match(ctlMock.getPayload().msg, /Sing-box/);

      const wrtNode = infra.snapshot().nodes.find((n) => n.id === 'openwrt');
      assert.equal(wrtNode.proxy.active, 'HK-Gold-01');
      assert.equal(wrtNode.proxy.delayMs, 38);

      infra.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('computes deterministic state signatures for event-driven reporting', () => {
    const s1 = stateSignature({
      services: [{ name: 'b', state: 'running' }, { name: 'a', state: 'running' }],
      containers: [{ name: 'zotero', state: 'running' }],
    });
    const s2 = stateSignature({
      services: [{ name: 'a', state: 'running' }, { name: 'b', state: 'running' }],
      containers: [{ name: 'zotero', state: 'running' }],
    });
    const s3 = stateSignature({
      services: [{ name: 'a', state: 'stopped' }, { name: 'b', state: 'running' }],
      containers: [{ name: 'zotero', state: 'running' }],
    });
    assert.equal(s1, s2);
    assert.notEqual(s1, s3);
  });
});
