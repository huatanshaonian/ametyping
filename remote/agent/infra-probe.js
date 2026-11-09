// Lightweight host, service, Docker, GPU, and TCP link collector for workstations (agent.js) and the NAS host (infra.js).
// Event-driven: service/container state changes report immediately; steady state sends a compact heartbeat every 60s
// (or 10s while a browser has the 网络与设备 window open).
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

// one-click container upgrade (remote/deploy/nas/docker-upgrade.sh, installed by docker-ps-sudoers.sh)
const UPGRADE_BIN = '/usr/local/bin/ame-docker-upgrade';
const UPGRADE_STATE_DIR = '/var/log/ame-docker-upgrade';

const SYSTEMD_IGNORE = /^(systemd-|dbus|getty@|serial-getty@|multipathd|ModemManager|networkd-dispatcher|polkit|rsyslog|snapd|udisks2|unattended-upgrades|user@|user-runtime-dir@|accounts-daemon|cron|irqbalance|packagekit|acpid|chrony|fwupd|blk-availability|console-setup|dmesg|finalrd|grub-|keyboard-setup|lvm2-|open-iscsi|pollinate|setvtrgb|ua-|uuidd|vgauth|apport|ec2-|google-guest|google-osconfig|snap\.amazon-ssm)/;

function runCmd(bin, args, timeout = 3500) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port: Number(port) });
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve({ ok, ms: ok ? Math.max(1, Date.now() - t0) : null, err: err || '' });
    };
    s.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    s.on('connect', () => finish(true));
    s.on('error', (e) => finish(false, e && e.code ? e.code : 'unreachable'));
  });
}

// CPU usage % from os.cpus() tick deltas (0 child processes)
function createCpuSampler() {
  let prevIdle = 0, prevTotal = 0;
  function sample() {
    const cpus = os.cpus() || [];
    let idle = 0, total = 0;
    for (const c of cpus) {
      const t = c.times;
      const sum = t.user + t.nice + t.sys + t.idle + t.irq;
      idle += t.idle;
      total += sum;
    }
    const dIdle = idle - prevIdle;
    const dTotal = total - prevTotal;
    prevIdle = idle;
    prevTotal = total;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
  }
  sample();
  return sample;
}

function readMemory() {
  const totalBytes = os.totalmem();
  let availBytes = os.freemem();
  if (process.platform === 'linux') {
    try {
      const txt = fs.readFileSync('/proc/meminfo', 'utf8');
      const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(txt);
      if (m) availBytes = Number(m[1]) * 1024;
    } catch {}
  }
  const totalMb = Math.round(totalBytes / 1048576);
  const usedMb = Math.max(0, Math.round((totalBytes - availBytes) / 1048576));
  const pct = totalMb > 0 ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : 0;
  return { totalMb, usedMb, pct };
}

function readDisk(targetPath = '/') {
  try {
    if (typeof fs.statfsSync === 'function') {
      const p = process.platform === 'win32' ? (process.cwd().slice(0, 3) || 'C:\\') : targetPath;
      const st = fs.statfsSync(p);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      const used = Math.max(0, total - free);
      const totalGb = Math.round((total / 1073741824) * 10) / 10;
      const usedGb = Math.round((used / 1073741824) * 10) / 10;
      const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
      return { totalGb, usedGb, pct, mount: p };
    }
  } catch {}
  return null;
}

function createNetSampler() {
  let prevAt = 0, prevRx = 0, prevTx = 0;
  return function sampleNet() {
    if (process.platform !== 'linux') return null;
    try {
      const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
      let rx = 0, tx = 0;
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const iface = line.slice(0, idx).trim();
        if (/^(lo|veth|docker|br-|virbr)/.test(iface)) continue;
        const cols = line.slice(idx + 1).trim().split(/\s+/);
        if (cols.length >= 9) {
          rx += Number(cols[0]) || 0;
          tx += Number(cols[8]) || 0;
        }
      }
      const now = Date.now();
      let rxKbps = 0, txKbps = 0;
      if (prevAt > 0 && now > prevAt && rx >= prevRx && tx >= prevTx) {
        const dt = (now - prevAt) / 1000;
        rxKbps = Math.round((rx - prevRx) / 1024 / dt);
        txKbps = Math.round((tx - prevTx) / 1024 / dt);
      }
      prevAt = now; prevRx = rx; prevTx = tx;
      return { rxBytes: rx, txBytes: tx, rxKbps, txKbps };
    } catch {
      return null;
    }
  };
}

function createCollector({ isNas = false, nasRoot = '/volume2/docker/ame-remote' } = {}) {
  const sampleCpu = createCpuSampler();
  const sampleNet = createNetSampler();
  let hasNvidiaSmi = null; // null = untested, true/false
  let dockerBin = null;    // null = untested, '' = none, or binary path

  async function collectGpu() {
    if (hasNvidiaSmi === false) return [];
    const r = await runCmd('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], 3000);
    if (!r.ok || !r.out) {
      if (hasNvidiaSmi === null) hasNvidiaSmi = false;
      return [];
    }
    hasNvidiaSmi = true;
    return r.out.split('\n').map((line) => {
      const p = line.split(',').map((x) => x.trim());
      if (p.length < 5) return null;
      return {
        name: p[0].slice(0, 60),
        utilPct: +p[1] || 0,
        memUsedMb: +p[2] || 0,
        memTotalMb: +p[3] || 0,
        tempC: +p[4] || 0,
      };
    }).filter(Boolean);
  }

  async function findDocker() {
    if (dockerBin !== null) return dockerBin;
    for (const candidate of ['/usr/local/bin/docker', '/usr/bin/docker', 'docker']) {
      if (candidate.startsWith('/') && !fs.existsSync(candidate)) continue;
      const r = await runCmd(candidate, ['ps', '-a', '--format', '{{.Names}}'], 3000);
      if (r.ok) { dockerBin = candidate; return dockerBin; }
      const rs = await runCmd('sudo', ['-n', candidate, 'ps', '-a', '--format', '{{.Names}}'], 3000);
      if (rs.ok) { dockerBin = 'sudo:' + candidate; return dockerBin; }
    }
    dockerBin = '';
    return '';
  }

  // the last one-click upgrade of a container, as remote/deploy/nas/docker-upgrade.sh left it (world-readable JSON)
  function readUpgradeState(name) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(UPGRADE_STATE_DIR, name + '.json'), 'utf8'));
      if (!j || typeof j !== 'object' || typeof j.state !== 'string') return undefined;
      return { state: j.state, msg: String(j.msg || ''), from: String(j.from || ''), to: String(j.to || ''), at: +j.at || 0 };
    } catch { return undefined; }
  }

  async function collectDocker() {
    const bin = await findDocker();
    if (!bin) return [];
    const fmt = '{{.Names}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.Image}}|{{.Label "com.docker.compose.project"}}';
    const r = bin.startsWith('sudo:')
      ? await runCmd('sudo', ['-n', bin.slice(5), 'ps', '-a', '--format', fmt], 4000)
      : await runCmd(bin, ['ps', '-a', '--format', fmt], 4000);
    if (!r.ok || !r.out) return [];
    return r.out.split('\n').map((line) => {
      const [name, state, status, ports, image, compose] = line.split('|');
      if (!name) return null;
      const n = name.trim().slice(0, 64);
      return {
        name: n,
        state: (state || '').trim().toLowerCase() === 'running' ? 'running' : 'stopped',
        status: (status || '').trim().slice(0, 80),
        ports: (ports || '').trim().slice(0, 120),
        image: (image || '').trim().slice(0, 80),
        compose: (compose || '').trim().slice(0, 64) || undefined,
        upgrade: /^[A-Za-z0-9._-]{1,64}$/.test(n) ? readUpgradeState(n) : undefined,
      };
    }).filter(Boolean);
  }

  async function collectNasServices() {
    const services = [];
    // 1. ame-remote server (clearly running if we are inside it, or check supervisor.pid)
    services.push({ name: 'ame-remote', label: 'Windose 看板服务 (run.sh)', state: 'running', kind: 'daemon', port: 8787 });
    // 2. egress.sh backup tunnel to AWS1
    const egressSup = path.join(nasRoot, 'egress', 'supervisor.pid');
    let egressSupAlive = false;
    try {
      const pid = Number(fs.readFileSync(egressSup, 'utf8').trim());
      if (pid > 0) { process.kill(pid, 0); egressSupAlive = true; }
    } catch {}
    const p1057 = await probeTcp('127.0.0.1', 1057, 1200);
    const p1058 = await probeTcp('127.0.0.1', 1058, 1200);
    services.push({
      name: 'egress-tunnel',
      label: 'AWS 备用出口隧道 (egress.sh :1057/:1058)',
      state: (egressSupAlive && p1057.ok && p1058.ok) ? 'running' : (egressSupAlive ? 'degraded' : 'stopped'),
      detail: `HTTP:1057 ${p1057.ok ? '通' : '断'} · SOCKS:1058 ${p1058.ok ? '通' : '断'}`,
      kind: 'egress',
      port: 1057,
    });
    // 3. System tailscaled + frpc via ps
    const ps = await runCmd('ps', ['-ef'], 2500);
    if (ps.ok) {
      const hasTs = /tailscaled.*@appdata\/Tailscale/.test(ps.out);
      services.push({ name: 'tailscaled', label: '群晖 Tailscale (100.65.10.90)', state: hasTs ? 'running' : 'stopped', kind: 'process' });
      const hasFrpc = /frpc\s+-c/.test(ps.out);
      if (hasFrpc) services.push({ name: 'frpc', label: 'FRP 内网穿透客户端 (frpc)', state: 'running', kind: 'process' });
    }
    return services;
  }

  async function collectWorkstationServices() {
    const services = [];
    if (process.platform === 'win32') {
      const v2 = await probeTcp('127.0.0.1', 10808, 600);
      const v2Http = await probeTcp('127.0.0.1', 10809, 600);
      const clash = await probeTcp('127.0.0.1', 7890, 600);
      if (v2.ok || v2Http.ok) {
        services.push({ name: 'local-proxy', label: `本地代理 (v2rayN :${v2Http.ok ? 10809 : 10808})`, state: 'running', kind: 'port', port: v2Http.ok ? 10809 : 10808 });
      } else if (clash.ok) {
        services.push({ name: 'local-proxy', label: '本地代理 (Clash :7890)', state: 'running', kind: 'port', port: 7890 });
      }
      const ts = await probeTcp('127.0.0.1', 41112, 500);
      services.push({ name: 'tailscaled', label: 'Tailscale 客户端', state: ts.ok ? 'running' : 'running', kind: 'process' });
    } else if (process.platform === 'linux') {
      const r = await runCmd('systemctl', ['list-units', '--type=service', '--state=running', '--no-pager', '--no-legend'], 3000);
      if (r.ok && r.out) {
        for (const line of r.out.split('\n')) {
          const unit = (line.trim().split(/\s+/)[0] || '').replace(/\.service$/, '');
          if (!unit || SYSTEMD_IGNORE.test(unit)) continue;
          services.push({ name: unit, label: unit, state: 'running', kind: 'systemd' });
        }
      }
    }
    return services;
  }

  async function collect({ watched = [], probeTargets = [] } = {}) {
    const cpuPct = sampleCpu();
    const mem = readMemory();
    const disk = readDisk(isNas && fs.existsSync('/volume2') ? '/volume2' : '/');
    const netStat = sampleNet();
    const [gpus, containers, discoveredServices] = await Promise.all([
      collectGpu(),
      collectDocker(),
      isNas ? collectNasServices() : collectWorkstationServices(),
    ]);

    // Ensure watched services are always represented
    const svcMap = new Map(discoveredServices.map((s) => [s.name, s]));
    for (const w of watched) {
      if (!w || w.startsWith('docker:')) continue;
      if (!svcMap.has(w)) {
        svcMap.set(w, { name: w, label: w, state: 'stopped', kind: 'systemd' });
      }
    }

    // Probe requested TCP link targets
    const links = {};
    if (Array.isArray(probeTargets) && probeTargets.length) {
      await Promise.all(probeTargets.slice(0, 12).map(async (t) => {
        if (!t || !t.id || !t.host || !t.port) return;
        links[t.id] = await probeTcp(t.host, t.port, 2000);
      }));
    }

    return {
      ts: Date.now(),
      uptimeSec: Math.round(os.uptime()),
      load1: os.loadavg ? Math.round(os.loadavg()[0] * 100) / 100 : 0,
      cpuPct,
      mem,
      disk,
      net: netStat,
      gpus,
      services: [...svcMap.values()],
      containers,
      links,
    };
  }

  async function executeControl({ kind, target, op }) {
    if (!['restart', 'start', 'stop', 'upgrade'].includes(op)) return { ok: false, msg: '不支持的操作类型' };
    if (typeof target !== 'string' || !/^[A-Za-z0-9._@-]{1,64}$/.test(target)) return { ok: false, msg: '无效的目标名称' };

    if (op === 'upgrade') {
      // only compose containers, through the root-owned script that checks the project was registered by an admin
      if (kind !== 'docker' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target)) return { ok: false, msg: '只有 Docker 容器可以升级' };
      if (!fs.existsSync(UPGRADE_BIN)) return { ok: false, msg: '这台电脑没装升级脚本（remote/deploy/nas/docker-ps-sudoers.sh）' };
      const r = await runCmd('sudo', ['-n', UPGRADE_BIN, 'upgrade', target], 15000);
      return { ok: r.ok, msg: r.ok ? `容器 ${target} 已开始升级，完成后状态会显示在这一行` : (r.err || r.out || '升级失败') };
    }

    if (kind === 'egress' && isNas) {
      const script = path.join(nasRoot, 'egress.sh');
      const r = await runCmd('sh', [script, op], 12000);
      return { ok: r.ok, msg: r.ok ? `已执行 egress.sh ${op}` : (r.err || r.out || '执行失败') };
    }
    if (kind === 'docker') {
      const bin = await findDocker();
      if (!bin) return { ok: false, msg: '未找到 Docker 命令' };
      const r = bin.startsWith('sudo:')
        ? await runCmd('sudo', ['-n', bin.slice(5), op, target], 15000)
        : await runCmd(bin, [op, target], 15000);
      return { ok: r.ok, msg: r.ok ? `容器 ${target} 已${op === 'restart' ? '重启' : op === 'start' ? '启动' : '停止'}` : (r.err || '操作容器失败') };
    }
    if (kind === 'service' && process.platform === 'linux') {
      const r = await runCmd('sudo', ['-n', 'systemctl', op, `${target}.service`], 12000);
      if (r.ok) return { ok: true, msg: `服务 ${target} 已${op === 'restart' ? '重启' : op === 'start' ? '启动' : '停止'}` };
      const r2 = await runCmd('systemctl', ['--user', op, `${target}.service`], 12000);
      return { ok: r2.ok, msg: r2.ok ? `用户服务 ${target} 已操作` : (r.err || r2.err || '操作服务失败') };
    }
    return { ok: false, msg: '当前节点不支持该控制指令' };
  }

  return { collect, executeControl, probeTcp };
}

// Compute a compact signature of service & container states for event-driven immediate reporting
function stateSignature(report) {
  if (!report) return '';
  const s = (report.services || []).map((x) => `${x.name}:${x.state}`).sort().join(',');
  const c = (report.containers || []).map((x) => `${x.name}:${x.state}:${(x.upgrade && x.upgrade.state) || ''}`).sort().join(',');
  const l = Object.entries(report.links || {}).map(([k, v]) => `${k}:${v && v.ok ? 1 : 0}`).sort().join(',');
  return `${s}|${c}|${l}`;
}

module.exports = { createCollector, probeTcp, stateSignature, SYSTEMD_IGNORE };
