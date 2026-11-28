// Global deep-link router for Windose desktop:
// Unifies initial location.hash handling, runtime hashchange navigation, and Service Worker push links,
// preserving 100% backward compatibility with all legacy #hash formats (docs/overhaul/04-ia-integration-plan.md §4.2).
import * as dashboard from './apps/dashboard.js';
import * as explorer from './apps/explorer.js';
import * as projects from './apps/projects.js';
import * as infra from './apps/infra.js';
import * as aiHub from './apps/ai-hub.js';
import * as reports from './apps/reports.js';
import * as todo from './apps/todo.js';
import * as calendar from './apps/calendar.js';
import * as google from './apps/google.js';
import * as mail from './apps/mail.js';
import * as mailAlerts from './apps/mail-alerts.js';
import * as literature from './apps/literature.js';
import * as knowledge from './apps/knowledge.js';
import * as control from './apps/control.js';

let getCurrent = () => null;
let selectMachine = () => {};
let started = false;

function clearHash() {
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function cleanObj(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

export function handleHash(rawHash = location.hash) {
  const raw = String(rawHash || '').trim();
  if (!raw || raw === '#') return false;
  const body = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!body) return false;

  // #report=<date | week-YYYY-MM-DD | draft> or #report?date=... or #reports
  if (body === 'reports' || body === 'report') {
    clearHash();
    reports.open();
    return true;
  }
  if (body.startsWith('report=')) {
    const val = decodeURIComponent(body.slice(7).split('&')[0]);
    clearHash();
    reports.open(val || undefined);
    return true;
  }
  if (body.startsWith('report?')) {
    const sp = new URLSearchParams(body.slice(7));
    clearHash();
    reports.open(sp.get('date') || undefined);
    return true;
  }

  // #mail-alerts
  if (body === 'mail-alerts') {
    clearHash();
    mailAlerts.show();
    return true;
  }

  // #mail=<key> or #mail
  if (body === 'mail') {
    clearHash();
    mail.open();
    return true;
  }
  if (body.startsWith('mail=')) {
    const key = decodeURIComponent(body.slice(5));
    clearHash();
    mail.open(key || undefined);
    return true;
  }
  if (body.startsWith('mail?')) {
    const sp = new URLSearchParams(body.slice(5));
    clearHash();
    mail.open(sp.get('key') || undefined);
    return true;
  }

  // #s=<machine>|<sessionId> & #dashboard
  if (body === 'dashboard') {
    clearHash();
    dashboard.open(getCurrent());
    return true;
  }
  if (body.startsWith('s=')) {
    const v = decodeURIComponent(body.slice(2));
    const i = v.indexOf('|');
    clearHash();
    if (i > 0) dashboard.openSession(v.slice(0, i), v.slice(i + 1));
    else dashboard.open(getCurrent());
    return true;
  }

  // #proj=<id>&tab=<t>&node=<n>&seq=<s> or #proj?id=... or #projects
  if (body === 'projects' || body === 'proj') {
    clearHash();
    projects.open();
    return true;
  }
  if (body.startsWith('proj=')) {
    const rest = body.slice(5);
    const amp = rest.indexOf('&');
    const id = decodeURIComponent(amp >= 0 ? rest.slice(0, amp) : rest);
    const sp = amp >= 0 ? new URLSearchParams(rest.slice(amp + 1)) : null;
    const opts = sp ? cleanObj({
      tab: sp.get('tab'),
      node: sp.get('node'),
      seq: sp.get('seq'),
    }) : {};
    clearHash();
    projects.open(id || null, Object.keys(opts).length ? opts : undefined);
    return true;
  }
  if (body.startsWith('proj?')) {
    const sp = new URLSearchParams(body.slice(5));
    const id = sp.get('id') || sp.get('proj') || null;
    const opts = cleanObj({
      tab: sp.get('tab'),
      node: sp.get('node'),
      seq: sp.get('seq'),
    });
    clearHash();
    projects.open(id, Object.keys(opts).length ? opts : undefined);
    return true;
  }

  // #magpie -> AI & Quota Hub Tab 1 (quota)
  if (body === 'magpie') {
    clearHash();
    aiHub.open({ tab: 'quota' });
    return true;
  }

  // #ai / #ai?tab=<quota|models|skills|mcp|clients>&sec=<...>&sub=<...>
  if (body === 'ai' || body.startsWith('ai?') || body.startsWith('ai=')) {
    let opts = { tab: 'quota' };
    if (body.startsWith('ai=')) {
      const rest = body.slice(3);
      const amp = rest.indexOf('&');
      const tab = decodeURIComponent(amp >= 0 ? rest.slice(0, amp) : rest);
      const sp = amp >= 0 ? new URLSearchParams(rest.slice(amp + 1)) : null;
      opts = cleanObj({
        tab: tab || 'quota',
        sec: sp && sp.get('sec'),
        sub: sp && sp.get('sub'),
      });
    } else if (body.startsWith('ai?')) {
      const sp = new URLSearchParams(body.slice(3));
      opts = cleanObj({
        tab: sp.get('tab') || 'quota',
        sec: sp.get('sec'),
        sub: sp.get('sub'),
      });
    }
    clearHash();
    aiHub.open(opts);
    return true;
  }

  // #skills / #skills=<skills|roles|pools|machines|fleet>
  const mSk = /^skills(?:=([a-z0-9_-]+)|\?(.+))?$/i.exec(body);
  if (mSk) {
    const sub = (mSk[1] || (mSk[2] ? new URLSearchParams(mSk[2]).get('tab') : '') || 'skills').toLowerCase();
    clearHash();
    if (sub === 'machines') infra.open({ tab: 'compute' });
    else if (sub === 'fleet') infra.open({ tab: 'fleet' });
    else if (sub === 'pools') aiHub.open({ tab: 'models' });
    else if (sub === 'roles') aiHub.open({ tab: 'skills', sub: 'roles' });
    else aiHub.open({ tab: 'skills', sub: 'skills' });
    return true;
  }

  // #infra / #infra?tab=<topo|compute|fleet|agents>&node=<id>&machine=<m>&project=<p>
  if (body === 'infra' || body.startsWith('infra?') || body.startsWith('infra=')) {
    let opts = {};
    if (body.startsWith('infra=')) {
      const val = decodeURIComponent(body.slice(6).split('&')[0]);
      if (['topo', 'compute', 'fleet', 'agents'].includes(val)) opts = { tab: val };
      else if (val) opts = { tab: 'topo', node: val };
    } else if (body.startsWith('infra?')) {
      const sp = new URLSearchParams(body.slice(6));
      opts = cleanObj({
        tab: sp.get('tab'),
        node: sp.get('node'),
        machine: sp.get('machine'),
        project: sp.get('project'),
      });
    }
    clearHash();
    infra.open(opts);
    return true;
  }

  // #lit / #lit?tab=<tab>&citekey=<k>&page=<n>&doi=<d>
  if (body === 'lit' || body.startsWith('lit?') || body.startsWith('lit=')) {
    clearHash();
    if (body === 'lit') {
      literature.open('feed');
    } else if (body.startsWith('lit=')) {
      literature.open(decodeURIComponent(body.slice(4)) || 'feed');
    } else {
      const sp = new URLSearchParams(body.slice(4));
      const tab = sp.get('tab') || '';
      const citekey = sp.get('citekey') || '';
      const pageRaw = sp.get('page') || '';
      const doi = sp.get('doi') || '';
      if (!citekey && !pageRaw && !doi) {
        literature.open(tab || 'feed');
      } else {
        const page = pageRaw ? (Number(pageRaw) || pageRaw) : undefined;
        literature.open(cleanObj({ tab: tab || undefined, citekey, page, doi }));
      }
    }
    return true;
  }

  // #knowledge / #knowledge?tab=<t>&scope=<s>&owner=<id>
  if (body === 'knowledge' || body.startsWith('knowledge?') || body.startsWith('knowledge=')) {
    clearHash();
    if (body === 'knowledge') {
      knowledge.open();
    } else if (body.startsWith('knowledge=')) {
      knowledge.open(decodeURIComponent(body.slice(10)) || undefined);
    } else {
      const sp = new URLSearchParams(body.slice(10));
      const tab = sp.get('tab') || '';
      const scope = sp.get('scope') || '';
      const owner = sp.get('owner') || '';
      if (!scope && !owner) {
        knowledge.open(tab || undefined);
      } else {
        knowledge.open(cleanObj({ tab: tab || 'memory', scope, owner }));
      }
    }
    return true;
  }

  // #calendar / #calendar=<YYYY-MM-DD> / #calendar?date=<YYYY-MM-DD>
  if (body === 'calendar' || body.startsWith('calendar=') || body.startsWith('calendar?')) {
    const date = body.startsWith('calendar=')
      ? decodeURIComponent(body.slice(9).split('&')[0])
      : body.startsWith('calendar?')
        ? (new URLSearchParams(body.slice(9)).get('date') || '')
        : '';
    clearHash();
    calendar.open(date || undefined);
    return true;
  }

  // #todo / #todo?plan=<id> / #todo=<id>
  if (body === 'todo' || body.startsWith('todo?') || body.startsWith('todo=')) {
    const plan = body.startsWith('todo=')
      ? decodeURIComponent(body.slice(5).split('&')[0])
      : body.startsWith('todo?')
        ? (new URLSearchParams(body.slice(5)).get('plan') || '')
        : '';
    clearHash();
    todo.open(plan || undefined);
    return true;
  }

  // #explorer=<machine>|<path> or #explorer?machine=...&path=...
  if (body === 'explorer' || body.startsWith('explorer=') || body.startsWith('explorer?')) {
    let machine = '';
    let targetPath = '';
    if (body.startsWith('explorer=')) {
      const v = decodeURIComponent(body.slice(9));
      const i = v.indexOf('|');
      if (i >= 0) { machine = v.slice(0, i); targetPath = v.slice(i + 1); }
      else machine = v;
    } else if (body.startsWith('explorer?')) {
      const sp = new URLSearchParams(body.slice(9));
      machine = sp.get('machine') || '';
      targetPath = sp.get('path') || '';
    }
    clearHash();
    const targetMachine = machine || getCurrent();
    if (targetMachine) {
      selectMachine(targetMachine);
      if (targetPath) explorer.openPath(targetMachine, targetPath);
      else explorer.open(targetMachine);
    }
    return true;
  }

  // #google=ok|fail (OAuth callback)
  const mG = /^google=(ok|fail)$/.exec(body);
  if (mG) {
    clearHash();
    google.open(mG[1] === 'ok' ? '已连接 Google。' : '没能连接 Google，请再试一次。');
    return true;
  }

  // #control / #control=<id>
  if (body === 'control' || body.startsWith('control=') || body.startsWith('control?')) {
    const id = body.startsWith('control=')
      ? decodeURIComponent(body.slice(8).split('&')[0])
      : body.startsWith('control?')
        ? (new URLSearchParams(body.slice(8)).get('id') || '')
        : '';
    clearHash();
    control.open(id || undefined);
    return true;
  }

  return false;
}

export function navigate(hash) {
  if (!hash) return false;
  const h = hash.startsWith('#') ? hash : '#' + hash;
  return handleHash(h);
}

export function init(opts = {}) {
  if (typeof opts.current === 'function') getCurrent = opts.current;
  if (typeof opts.selectMachine === 'function') selectMachine = opts.selectMachine;
  if (!started) {
    started = true;
    addEventListener('hashchange', () => handleHash(location.hash));
  }
  return handleHash(location.hash);
}
