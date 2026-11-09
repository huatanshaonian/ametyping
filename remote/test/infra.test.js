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

  it('compensates event-loop stalls and records node-online recovery after real offline', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-infra-test-'));
    try {
      const notifications = [];
      const infra = createInfra({
        dataDir: tmp,
        localNas: false,
        offlineMs: 60000,
        notify: (msg) => notifications.push(msg),
      });

      infra.ingestReport('aws1', {
        uptimeSec: 1000,
        services: [{ name: 'danted', state: 'running' }],
      });

      const t0 = Date.now();
      // Simulate a 180s server event-loop stall (e.g. heavy SQLite backup):
      // sweepOffline should compensate lastSeen and NOT trigger a false node-offline alarm
      const stalled = infra.sweepOffline(t0 + 180000);
      assert.equal(stalled, false);
      assert.equal(notifications.length, 0);

      // Now advance in normal 15s increments past offlineMs (60s) without new heartbeats
      let cur = t0 + 180000;
      for (let i = 0; i < 5; i++) {
        cur += 15000;
        infra.sweepOffline(cur);
      }
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].body, /心跳超时离线/);

      // Next report from aws1 should record node-online recovery event even though prev.report existed
      infra.ingestReport('aws1', {
        uptimeSec: 1200,
        services: [{ name: 'danted', state: 'running' }],
      });
      const events = infra.snapshot().events;
      assert.equal(events[0].kind, 'node-online');
      assert.match(events[0].summary, /已恢复在线/);

      infra.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports downgrading (muting) intentionally stopped containers/services to yellow without alert', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-infra-test-'));
    try {
      const notifications = [];
      const infra = createInfra({
        dataDir: tmp,
        localNas: false,
        notify: (msg) => notifications.push(msg),
      });

      // NAS reports jellyfin stopped while watched
      infra.ingestReport('nas', {
        uptimeSec: 1000,
        services: [{ name: 'ame-remote', state: 'running' }, { name: 'egress-tunnel', state: 'running' }, { name: 'tailscaled', state: 'running' }],
        containers: [
          { name: 'partdb', state: 'running' },
          { name: 'zotero', state: 'running' },
          { name: 'ame-onlyoffice', state: 'running' },
          { name: 'jellyfin', state: 'stopped', status: 'Exited (0)' },
        ],
      });

      let nasNode = infra.snapshot().nodes.find((n) => n.id === 'nas');
      assert.equal(nasNode.alertCount, 1);

      // Right-click downgrade jellyfin to muted (intentionally off)
      const muteMock = mockReqRes('POST', '/api/infra/pin', {
        nodeId: 'nas',
        item: 'docker:jellyfin',
        mute: true,
      });
      await infra.handleBrowser(muteMock.req, muteMock.res, muteMock.url, '127.0.0.1', muteMock.json, muteMock.readBody, () => false);
      assert.equal(muteMock.getPayload().ok, true);
      assert.ok(muteMock.getPayload().muted.includes('docker:jellyfin'));

      nasNode = infra.snapshot().nodes.find((n) => n.id === 'nas');
      assert.equal(nasNode.alertCount, 0);
      const jf = nasNode.containers.find((c) => c.name === 'jellyfin');
      assert.equal(jf.muted, true);

      // Transition from running -> stopped while muted should not push alert
      infra.ingestReport('nas', {
        uptimeSec: 1010,
        services: [{ name: 'ame-remote', state: 'running' }, { name: 'egress-tunnel', state: 'running' }, { name: 'tailscaled', state: 'running' }],
        containers: [
          { name: 'partdb', state: 'running' },
          { name: 'zotero', state: 'running' },
          { name: 'ame-onlyoffice', state: 'running' },
          { name: 'jellyfin', state: 'running' },
        ],
      });
      infra.ingestReport('nas', {
        uptimeSec: 1020,
        services: [{ name: 'ame-remote', state: 'running' }, { name: 'egress-tunnel', state: 'running' }, { name: 'tailscaled', state: 'running' }],
        containers: [
          { name: 'partdb', state: 'running' },
          { name: 'zotero', state: 'running' },
          { name: 'ame-onlyoffice', state: 'running' },
          { name: 'jellyfin', state: 'stopped' },
        ],
      });
      assert.equal(notifications.length, 0);

      infra.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes container compose/upgrade state through, logs finished upgrades once, and validates the upgrade op', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-infra-test-'));
    try {
      const notifications = [];
      const infra = createInfra({ dataDir: tmp, localNas: false, control: true, notify: (m) => notifications.push(m) });
      const rep = (upgrade) => ({ uptimeSec: 1, containers: [
        { name: 'jellyfin', state: 'running', compose: 'jellyfin', upgrade },
        { name: 'v2raya', state: 'stopped' },
      ] });
      infra.ingestReport('nas', rep(undefined));
      infra.ingestReport('nas', rep({ state: 'running', msg: '开始升级', from: 'aaa', at: 1 }));
      infra.ingestReport('nas', rep({ state: 'done', msg: '已升级', from: 'aaa', to: 'bbb', at: 2 }));
      infra.ingestReport('nas', rep({ state: 'done', msg: '已升级', from: 'aaa', to: 'bbb', at: 2 }));   // same result again
      infra.ingestReport('nas', rep({ state: 'bogus', at: 3 }));                                          // unknown state dropped
      infra.ingestReport('nas', rep({ state: 'rolledback', msg: '新版本启动失败', from: 'bbb', to: 'ccc', at: 4 }));

      const nas = infra.snapshot().nodes.find((n) => n.id === 'nas');
      const jf = nas.containers.find((c) => c.name === 'jellyfin');
      assert.equal(jf.compose, 'jellyfin');
      assert.equal(jf.upgrade.state, 'rolledback');
      assert.equal(nas.containers.find((c) => c.name === 'v2raya').compose, undefined);
      const ups = infra.snapshot().events.filter((e) => e.kind === 'docker-upgrade');
      assert.equal(ups.length, 2);
      assert.match(ups[1].summary, /jellyfin 已升级（aaa → bbb）/);
      assert.match(ups[0].summary, /已回退.*新版本启动失败/);
      assert.equal(notifications.length, 1);   // the rolled-back one is an alert

      for (const body of [{ nodeId: 'nas', kind: 'service', target: 'x', op: 'upgrade' }, { nodeId: 'nas', kind: 'docker', target: 'x', op: 'rm' }]) {
        const m = mockReqRes('POST', '/api/infra/control', body);
        await infra.handleBrowser(m.req, m.res, m.url, '127.0.0.1', m.json, m.readBody, () => true);
        assert.equal(m.getPayload().ok, false);
        assert.match(m.getPayload().msg, /无效的控制参数/);
      }
      infra.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('probe refuses upgrade for anything but a docker container name', async () => {
    const { createCollector } = require('../agent/infra-probe');
    const c = createCollector({ isNas: false });
    assert.match((await c.executeControl({ kind: 'service', target: 'nginx', op: 'upgrade' })).msg, /只有 Docker 容器/);
    assert.match((await c.executeControl({ kind: 'docker', target: '-rf', op: 'upgrade' })).msg, /只有 Docker 容器/);
    assert.match((await c.executeControl({ kind: 'docker', target: 'a b', op: 'upgrade' })).msg, /无效的目标名称/);
    assert.match((await c.executeControl({ kind: 'docker', target: 'x', op: 'exec' })).msg, /不支持的操作类型/);
  });

  it('fills service labels/ports from server metadata and keeps probe-supplied labels', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-infra-test-'));
    try {
      const infra = createInfra({ dataDir: tmp, localNas: false });
      infra.ingestReport('aws1', {
        services: [
          { name: 'danted', label: 'danted', state: 'running', kind: 'systemd' },
          { name: 'custom', label: '自定义标签', state: 'running', port: 8080 },
          { name: 'unknown-unit', state: 'degraded', detail: '1 个重复实例运行中' },
        ],
      });
      const svcs = infra.snapshot().nodes.find((n) => n.id === 'aws1').services;
      const by = (n) => svcs.find((s) => s.name === n);
      assert.equal(by('danted').label, 'Dante SOCKS5 代理 (danted)');
      assert.equal(by('danted').port, 1080);
      assert.equal(by('custom').label, '自定义标签');
      assert.equal(by('custom').port, 8080);
      assert.equal(by('unknown-unit').label, 'unknown-unit');
      assert.equal(by('unknown-unit').state, 'degraded');
      infra.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('migrates the router watch list and links from tailscaled to the procd name tailscale', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-infra-test-'));
    try {
      fs.writeFileSync(path.join(tmp, 'infra.json'), JSON.stringify({
        nodes: [
          { id: 'openwrt', role: 'router', watched: ['sing-box', 'tailscaled'], muted: ['tailscaled'] },
          { id: 'aws1', role: 'cloud', watched: ['tailscaled'], muted: [] },
        ],
        links: [
          { id: 'l1', from: 'openwrt', to: 'aws1', service: 'tailscaled' },
          { id: 'l2', from: 'aws1', to: 'openwrt', service: 'tailscaled' },
        ],
        events: [],
      }));
      const infra = createInfra({ dataDir: tmp, localNas: false });
      const snap = infra.snapshot();
      const wrt = snap.nodes.find((n) => n.id === 'openwrt');
      assert.deepEqual(wrt.watched, ['sing-box', 'tailscale']);
      assert.deepEqual(wrt.muted, ['tailscale']);
      assert.deepEqual(snap.nodes.find((n) => n.id === 'aws1').watched, ['tailscaled']);
      assert.equal(snap.links.find((l) => l.id === 'l1').service, 'tailscale');
      assert.equal(snap.links.find((l) => l.id === 'l2').service, 'tailscaled');
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'infra.json'), 'utf8'));
      assert.deepEqual(onDisk.nodes.find((n) => n.id === 'openwrt').watched, ['sing-box', 'tailscale']);
      infra.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
