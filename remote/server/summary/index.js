// The daily work summary (日报): wiring and the web API. Settings are config.json "summary" (all optional):
//   enabled     false turns it off
//   codex       the Codex CLI (default ~/.local/bin/codex on Linux, "codex" elsewhere), or [command, ...args]
//   model       default "gpt-6-luna"
//   proxies     HTTP proxies tried in order, e.g. ["http://<PC>:10810", "http://127.0.0.1:1057"] (the PC's v2rayN,
//               then the AWS way out, deploy/nas/egress.sh); none = direct
//   categories  [{ match, cat }] folder rules for 科研 / 个人小项目 / 杂活 (see classify.js)
//   at "04:30", quietMin 30: when the morning report is written
//   backupMaxMB 5: artifacts (files made outside a tracked repository) up to this size are copied to the NAS
'use strict';
const os = require('os');
const path = require('path');
const { createReports } = require('./reports');
const { createGenerator } = require('./generate');
const { createScheduler } = require('./scheduler');
const { createClassifier } = require('./classify');
const { createEgress } = require('../egress');

function createSummary({ store, dir, cfg = {}, resumeCmd, artifacts = null, log = console.log, audit = () => {} }) {
  if (cfg.enabled === false) return null;
  const reports = createReports(dir);
  const linux = process.platform === 'linux';
  const codex = {
    bin: cfg.codex || (linux ? path.join(os.homedir(), '.local', 'bin', 'codex') : 'codex'),
    model: cfg.model || 'gpt-6-luna',
    // Synology: Entware's busybox ps (earlier in PATH) breaks codex; the system's tools first
    pathPrefix: cfg.pathPrefix != null ? cfg.pathPrefix : (linux ? '/usr/bin' : ''),
    timeoutMs: (+cfg.timeoutMin || 20) * 60e3,
  };
  const egress = Array.isArray(cfg.proxies) && cfg.proxies.length ? createEgress({ proxies: cfg.proxies, log }) : null;
  const gen = createGenerator({ store, reports, egress, classify: createClassifier(cfg.categories), codex, resumeCmd, log,
    artifacts, backupBytes: (cfg.backupMaxMB != null ? +cfg.backupMaxMB : 5) * 1e6 });
  const [hh, mm] = String(cfg.at || '04:30').split(':').map(Number);
  const scheduler = createScheduler({ reports, store, generate: gen.generate, log, at: [hh || 0, mm || 0],
    quietMs: (cfg.quietMin != null ? +cfg.quietMin : 30) * 60e3, tickMs: +process.env.AME_SUMMARY_TICK_MS || 60e3 });

  // the web API; true when the request was one of ours
  async function handle(req, res, url, ip, json) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/reports') {
      const d = reports.get('draft');
      json(res, 200, { items: reports.list(), status: scheduler.status(), draft: d ? { headline: d.headline, from: d.from, to: d.to } : null });
      return true;
    }
    if (req.method === 'GET' && p === '/api/report') {
      const r = reports.get(url.searchParams.get('date'));
      json(res, r ? 200 : 404, r || { error: 'not found' });
      return true;
    }
    if (req.method === 'POST' && p === '/api/report/draft') {
      const started = scheduler.draft();
      if (started) audit('report-draft', ip);
      json(res, 200, { ok: started, msg: started ? '' : '正在生成，请稍等' });
      return true;
    }
    return false;
  }

  return { handle, scheduler, reports, generate: gen.generate };
}

module.exports = { createSummary };
