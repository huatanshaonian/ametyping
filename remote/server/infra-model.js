// Static topology defaults, display metadata, and report sanitizer for Infrastructure Monitor (`infra.js`).
'use strict';

const OFFLINE_MS = 5 * 60 * 1000;   // 5 heartbeats (60s * 5) without report -> offline
const STALL_MS = 45 * 1000;         // event-loop stall threshold (e.g. SQLite backup pause)
const ALERT_COOLDOWN_MS = 10 * 60e3; // 10 min cooldown per alert key
const MAX_EVENTS = 80;

// What remote/deploy/nas/docker-upgrade.sh reports about a container's last one-click upgrade
const UPGRADE_STATES = ['running', 'latest', 'done', 'failed', 'rolledback'];
const UPGRADE_EVENTS = {
  done: ['ok', '已升级'],
  latest: ['ok', '已是最新版本'],
  rolledback: ['err', '升级失败，已回退到旧版本'],
  failed: ['err', '升级失败'],
};

const DEFAULT_NODES = [
  {
    id: 'openwrt',
    label: 'OpenWrt 软路由',
    role: 'router',
    host: '192.168.114.1',
    tier: 1,
    watched: ['sing-box', 'singbox-watchdog', 'tailscale', 'dnsmasq'],
  },
  {
    id: 'huatanshaonian',
    label: '主力工作站 (huatanshaonian)',
    role: 'workstation',
    host: 'LAN / Tailscale',
    tier: 0,
    watched: [],
  },
  {
    id: 'dell97',
    label: 'Linux 工作站 (dell97)',
    role: 'workstation',
    host: '100.107.95.65',
    tier: 0,
    watched: [],
  },
  {
    id: 'nas',
    label: '群晖 NAS (huatan_balcony)',
    role: 'nas',
    host: '192.168.114.6 / 100.65.10.90',
    tier: 1,
    watched: ['ame-remote', 'egress-tunnel', 'tailscaled', 'docker:partdb', 'docker:zotero', 'docker:ame-onlyoffice', 'docker:jellyfin'],
  },
  {
    id: 'aws1',
    label: 'AWS 东京 (aws1)',
    role: 'cloud',
    host: '3.114.240.137 / 100.120.53.46',
    tier: 2,
    watched: ['danted', 'frps', 'rustdesk-hbbs', 'rustdesk-hbbr', 'nginx', 'tailscaled', 'vnstat'],
  },
  {
    id: 'gcp1',
    label: 'GCP 节点 (gcp1)',
    role: 'cloud',
    host: '136.69.199.90 / 100.104.233.112',
    tier: 2,
    watched: ['claude-gcp-proxy', 'danted', 'magpie', 'tailscaled'],
  },
];

const DEFAULT_LINKS = [
  { id: 'l_pc_openwrt', from: 'huatanshaonian', to: 'openwrt', label: 'LAN 网关 / Sing-box', service: 'sing-box', probeHost: '192.168.114.1', probePort: 9090 },
  { id: 'l_pc_nas', from: 'huatanshaonian', to: 'nas', label: 'LAN 直连 / NAS :445', service: 'ame-remote', probeHost: '192.168.114.6', probePort: 445 },
  { id: 'l_dell_nas', from: 'dell97', to: 'nas', label: 'Tailscale :8788', service: 'tailscaled', probeHost: '100.65.10.90', probePort: 8788 },
  { id: 'l_nas_aws_egress', from: 'nas', to: 'aws1', label: 'SSH -D :1058 (egress.sh)', service: 'egress-tunnel', probeHost: '127.0.0.1', probePort: 1057, standby: true },
  { id: 'l_nas_aws_socks', from: 'nas', to: 'aws1', label: 'Tailscale SOCKS5 :1080', service: 'danted', probeHost: '100.120.53.46', probePort: 1080 },
  { id: 'l_nas_aws_frp', from: 'nas', to: 'aws1', label: 'FRP 穿透 :7000', service: 'frps', probeHost: '100.120.53.46', probePort: 7000 },
  { id: 'l_nas_gcp_claude', from: 'nas', to: 'gcp1', label: 'Claude HTTP :18888', service: 'claude-gcp-proxy', probeHost: '100.104.233.112', probePort: 18888 },
  { id: 'l_nas_gcp_socks', from: 'nas', to: 'gcp1', label: 'Tailscale SOCKS5 :1080', service: 'danted', probeHost: '100.104.233.112', probePort: 1080 },
  { id: 'l_openwrt_aws', from: 'openwrt', to: 'aws1', label: 'Sing-box / Tailscale', service: 'sing-box', probeHost: '100.120.53.46', probePort: 1080 },
  { id: 'l_openwrt_gcp', from: 'openwrt', to: 'gcp1', label: 'Tailscale 互联', service: 'tailscale', probeHost: '100.104.233.112', probePort: 1080 },
];

const SERVICE_META = {
  danted: { label: 'Dante SOCKS5 代理 (danted)', port: 1080 },
  'claude-gcp-proxy': { label: 'Claude HTTP 代理 (tinyproxy)', port: 18888 },
  frps: { label: 'FRP 穿透服务端 (frps)', port: 7000 },
  'rustdesk-hbbs': { label: 'RustDesk ID 服务 (hbbs)', port: 21116 },
  'rustdesk-hbbr': { label: 'RustDesk 中继服务 (hbbr)', port: 21117 },
  nginx: { label: 'Nginx Web/反代', port: 443 },
  tailscaled: { label: 'Tailscale 节点服务' },
  vnstat: { label: 'vnStat 流量统计' },
  magpie: { label: 'Magpie Web 服务', port: 3430 },
  'ame-probe': { label: 'AmeTyping 监控探针' },
  'sing-box': { label: 'Sing-box 代理', port: 9090 },
  'singbox-watchdog': { label: 'Sing-box 断流自愈守护' },
  tailscale: { label: 'Tailscale 路由节点' },
  dnsmasq: { label: 'Dnsmasq (DHCP/DNS)', port: 53 },
  odhcpd: { label: 'odhcpd (DHCPv6/RA)' },
  uhttpd: { label: 'LuCI 管理界面 (uhttpd)', port: 443 },
  dropbear: { label: 'Dropbear SSH', port: 22 },
  wpad: { label: 'Wi-Fi (hostapd)' },
  firewall: { label: '防火墙 (fw4)' },
  'adblock-fast': { label: '广告拦截 (adblock-fast)' },
  sysntpd: { label: 'NTP 时间同步' },
  cron: { label: '计划任务 (cron)' },
};

const str = (v, n = 80) => String(v == null ? '' : v).trim().slice(0, n);

function sanitizeReport(d) {
  if (!d || typeof d !== 'object') return {};
  const services = Array.isArray(d.services) ? d.services.slice(0, 60).map((s) => {
    const name = str(s && s.name, 64);
    const meta = Object.prototype.hasOwnProperty.call(SERVICE_META, name) ? SERVICE_META[name] : null;
    const rawLabel = str(s && s.label, 80);
    return {
      name,
      label: (rawLabel && rawLabel !== name) ? rawLabel : ((meta && meta.label) || name),
      state: ['running', 'stopped', 'degraded'].includes(s && s.state) ? s.state : 'stopped',
      kind: str((s && s.kind) || 'service', 20),
      port: +(s && s.port) || (meta && meta.port) || undefined,
      detail: s && s.detail ? str(s.detail, 120) : undefined,
    };
  }).filter((s) => s.name) : [];

  const containers = Array.isArray(d.containers) ? d.containers.slice(0, 50).map((c) => ({
    name: str(c && c.name, 64),
    state: (c && c.state) === 'running' ? 'running' : 'stopped',
    status: str(c && c.status, 80),
    ports: str(c && c.ports, 120),
    image: str(c && c.image, 80),
    compose: c && c.compose ? str(c.compose, 64) : undefined,
    upgrade: c && c.upgrade && typeof c.upgrade === 'object' && UPGRADE_STATES.includes(c.upgrade.state) ? {
      state: c.upgrade.state,
      msg: str(c.upgrade.msg, 300),
      from: str(c.upgrade.from, 20),
      to: str(c.upgrade.to, 20),
      at: Math.max(0, +c.upgrade.at || 0),
    } : undefined,
  })).filter((c) => c.name) : [];

  const gpus = Array.isArray(d.gpus) ? d.gpus.slice(0, 8).map((g) => ({
    name: str(g && g.name, 60),
    utilPct: Math.max(0, Math.min(100, +(g && g.utilPct) || 0)),
    memUsedMb: Math.max(0, +(g && g.memUsedMb) || 0),
    memTotalMb: Math.max(0, +(g && g.memTotalMb) || 0),
    tempC: Math.max(0, +(g && g.tempC) || 0),
  })) : [];

  const links = {};
  if (d.links && typeof d.links === 'object') {
    for (const [k, v] of Object.entries(d.links)) {
      if (!v || typeof v !== 'object') continue;
      links[str(k, 40)] = { ok: !!v.ok, ms: v.ok && Number.isFinite(+v.ms) ? Math.round(+v.ms) : null, err: str(v.err, 40) };
    }
  }

  const mem = d.mem && typeof d.mem === 'object' ? {
    totalMb: Math.max(0, +d.mem.totalMb || 0),
    usedMb: Math.max(0, +d.mem.usedMb || 0),
    pct: Math.max(0, Math.min(100, +d.mem.pct || 0)),
  } : null;

  const disk = d.disk && typeof d.disk === 'object' ? {
    totalGb: Math.max(0, +d.disk.totalGb || 0),
    usedGb: Math.max(0, +d.disk.usedGb || 0),
    pct: Math.max(0, Math.min(100, +d.disk.pct || 0)),
    mount: str(d.disk.mount || '/', 30),
  } : null;

  const netStat = d.net && typeof d.net === 'object' ? {
    rxBytes: Math.max(0, +d.net.rxBytes || 0),
    txBytes: Math.max(0, +d.net.txBytes || 0),
    rxKbps: Math.max(0, +d.net.rxKbps || 0),
    txKbps: Math.max(0, +d.net.txKbps || 0),
    monthRxGb: d.net.monthRxGb != null ? Math.round(+d.net.monthRxGb * 100) / 100 : undefined,
    monthTxGb: d.net.monthTxGb != null ? Math.round(+d.net.monthTxGb * 100) / 100 : undefined,
  } : null;

  const proxy = d.proxy && typeof d.proxy === 'object' ? {
    active: str(d.proxy.active, 60),
    group: str(d.proxy.group, 40),
    delayMs: Number.isFinite(+d.proxy.delayMs) ? Math.round(+d.proxy.delayMs) : null,
    watchdogDupes: Number.isFinite(+d.proxy.watchdogDupes) ? +d.proxy.watchdogDupes : undefined,
  } : null;

  return {
    ts: Date.now(),
    uptimeSec: Math.max(0, +d.uptimeSec || 0),
    load1: Math.max(0, Math.round((+d.load1 || 0) * 100) / 100),
    cpuPct: Math.max(0, Math.min(100, Math.round(+d.cpuPct || 0))),
    mem,
    disk,
    net: netStat,
    gpus,
    services,
    containers,
    links,
    proxy,
  };
}

module.exports = {
  OFFLINE_MS,
  STALL_MS,
  ALERT_COOLDOWN_MS,
  MAX_EVENTS,
  UPGRADE_STATES,
  UPGRADE_EVENTS,
  DEFAULT_NODES,
  DEFAULT_LINKS,
  SERVICE_META,
  str,
  sanitizeReport,
};
