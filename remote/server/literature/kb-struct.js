// Derived structured knowledge base: <dir>/kb_struct.sqlite (Node built-in node:sqlite, zero external deps).
// Stores per-paper structured evidence, atomic claims, cross-paper contradictions, and benchmark reproductions.
// Purely derived and safe to delete/rebuild at any time.
'use strict';
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1';

function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    if (/SQLite/i.test(String((w && w.message) || w))) return;
    return emit.call(process, w, ...rest);
  };
  try { return require('node:sqlite'); }
  catch { return null; }
  finally { setTimeout(() => { process.emitWarning = emit; }, 0); }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS paper_evidence (
    zotero_key TEXT NOT NULL,
    schema_id TEXT NOT NULL,
    pdf_md5 TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    verified_ratio REAL NOT NULL,
    human_verified INTEGER DEFAULT 0,
    model TEXT NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (zotero_key, schema_id)
  );

  CREATE TABLE IF NOT EXISTS paper_claims (
    id TEXT PRIMARY KEY,
    zotero_key TEXT NOT NULL,
    schema_id TEXT NOT NULL,
    condition TEXT NOT NULL,
    conclusion TEXT NOT NULL,
    metric TEXT DEFAULT '',
    page INTEGER NOT NULL,
    quote TEXT NOT NULL,
    verified INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS paper_claims_paper ON paper_claims (zotero_key, schema_id);

  CREATE TABLE IF NOT EXISTS claim_contradictions (
    id TEXT PRIMARY KEY,
    schema_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    claim_ids_json TEXT NOT NULL,
    verdict TEXT NOT NULL,
    summary TEXT NOT NULL,
    param_diff_json TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    updated INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS benchmarks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    zotero_keys_json TEXT NOT NULL,
    script_path TEXT NOT NULL,
    npz_path TEXT NOT NULL,
    status TEXT NOT NULL,
    error_summary TEXT NOT NULL,
    updated INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS research_teams (
    id TEXT PRIMARY KEY,
    institution TEXT NOT NULL,
    lab TEXT DEFAULT '',
    pi TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    updated INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS paper_teams (
    zotero_key TEXT NOT NULL,
    team_id TEXT NOT NULL,
    role TEXT DEFAULT 'author',
    updated INTEGER NOT NULL,
    PRIMARY KEY (zotero_key, team_id)
  );
  CREATE INDEX IF NOT EXISTS paper_teams_team ON paper_teams (team_id);
`;

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v != null ? v : fallback;
  } catch {
    return fallback;
  }
}

function mapEvidenceRow(r) {
  if (!r) return null;
  return {
    zoteroKey: r.zotero_key,
    schemaId: r.schema_id,
    pdfMd5: r.pdf_md5,
    fields: parseJson(r.fields_json, {}),
    verifiedRatio: Number(r.verified_ratio),
    humanVerified: Number(r.human_verified) ? 1 : 0,
    model: r.model,
    updated: Number(r.updated),
  };
}

function mapClaimRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    zoteroKey: r.zotero_key,
    schemaId: r.schema_id,
    condition: r.condition,
    conclusion: r.conclusion,
    metric: r.metric || '',
    page: Number(r.page),
    quote: r.quote,
    verified: Number(r.verified) ? 1 : 0,
    updated: Number(r.updated),
  };
}

function mapContradictionRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    schemaId: r.schema_id,
    topic: r.topic,
    claimIds: parseJson(r.claim_ids_json, []),
    verdict: r.verdict,
    summary: r.summary,
    paramDiff: parseJson(r.param_diff_json, {}),
    status: r.status || 'pending',
    updated: Number(r.updated),
  };
}

function mapBenchmarkRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    zoteroKeys: parseJson(r.zotero_keys_json, []),
    scriptPath: r.script_path,
    npzPath: r.npz_path,
    status: r.status,
    errorSummary: r.error_summary,
    updated: Number(r.updated),
  };
}

function openKbStruct({ dir, log = () => {} }) {
  const sqlite = loadSqlite();
  if (!sqlite) {
    log('结构化知识库：当前 Node 不支持 node:sqlite');
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'kb_struct.sqlite');

  let db;
  let rebuilt = false;

  const init = () => {
    db = new sqlite.DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  };

  try {
    init();
  } catch (e) {
    log('结构化知识库打不开（' + e.message + '），移走并重建');
    try { db && db.close(); } catch {}
    for (const sfx of ['', '-wal', '-shm']) {
      const src = file + sfx;
      const dst = src + '.bad';
      try { fs.rmSync(dst, { force: true }); } catch {}
      try { fs.renameSync(src, dst); } catch {}
    }
    try {
      init();
      rebuilt = true;
    } catch (e2) {
      log('结构化知识库建不起来：' + e2.message);
      return null;
    }
  }

  const q = {
    getEv: db.prepare('SELECT * FROM paper_evidence WHERE zotero_key = ? AND schema_id = ?'),
    saveEv: db.prepare(`
      INSERT OR REPLACE INTO paper_evidence
        (zotero_key, schema_id, pdf_md5, fields_json, verified_ratio, human_verified, model, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    verifyEv: db.prepare(`
      UPDATE paper_evidence
      SET fields_json = ?, verified_ratio = ?, human_verified = 1, updated = ?
      WHERE zotero_key = ? AND schema_id = ?
    `),
    delClaims: db.prepare('DELETE FROM paper_claims WHERE zotero_key = ? AND schema_id = ?'),
    putClaim: db.prepare(`
      INSERT OR REPLACE INTO paper_claims
        (id, zotero_key, schema_id, condition, conclusion, metric, page, quote, verified, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    saveContra: db.prepare(`
      INSERT OR REPLACE INTO claim_contradictions
        (id, schema_id, topic, claim_ids_json, verdict, summary, param_diff_json, status, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updContraStatus: db.prepare('UPDATE claim_contradictions SET status = ?, updated = ? WHERE id = ?'),
    saveBench: db.prepare(`
      INSERT OR REPLACE INTO benchmarks
        (id, title, zotero_keys_json, script_path, npz_path, status, error_summary, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
  };

  function getEvidence(zoteroKey, schemaId) {
    const row = q.getEv.get(String(zoteroKey), String(schemaId));
    return mapEvidenceRow(row);
  }

  function saveEvidence({ zoteroKey, schemaId, pdfMd5 = '', fields = {}, verifiedRatio = 0, humanVerified = 0, model = '' }) {
    const now = Date.now();
    q.saveEv.run(
      String(zoteroKey),
      String(schemaId),
      String(pdfMd5 || ''),
      JSON.stringify(fields || {}),
      Number.isFinite(Number(verifiedRatio)) ? Number(verifiedRatio) : 0,
      humanVerified ? 1 : 0,
      String(model || ''),
      now
    );
    return getEvidence(zoteroKey, schemaId);
  }

  function verifyEvidence({ zoteroKey, schemaId, fields }) {
    const existing = getEvidence(zoteroKey, schemaId);
    if (!existing) return null;
    const nextFields = fields && typeof fields === 'object' ? fields : existing.fields;
    let nextRatio = existing.verifiedRatio;
    const vals = Object.values(nextFields);
    if (vals.length > 0 && vals.every((c) => c && typeof c === 'object' && 'verified' in c)) {
      const nonEmpty = vals.filter((c) => c.value != null && String(c.value).trim() !== '');
      nextRatio = nonEmpty.length === 0 ? 1 : nonEmpty.filter((c) => Number(c.verified) === 1).length / nonEmpty.length;
    }
    q.verifyEv.run(
      JSON.stringify(nextFields),
      nextRatio,
      Date.now(),
      String(zoteroKey),
      String(schemaId)
    );
    return getEvidence(zoteroKey, schemaId);
  }

  function listEvidence(schemaId, { onlyVerified = false } = {}) {
    const clauses = [];
    const params = [];
    if (schemaId) {
      clauses.push('schema_id = ?');
      params.push(String(schemaId));
    }
    if (onlyVerified) {
      clauses.push('(human_verified = 1 OR verified_ratio >= 1)');
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = db.prepare(`SELECT * FROM paper_evidence${where} ORDER BY updated DESC, zotero_key ASC`).all(...params);
    return rows.map(mapEvidenceRow);
  }

  function queryEvidence({ schemaId, filters = {}, onlyVerified = false } = {}) {
    const rows = listEvidence(schemaId, { onlyVerified });
    const entries = Object.entries(filters || {})
      .map(([k, v]) => [k, v == null ? '' : String(v).trim().toLowerCase()])
      .filter(([, v]) => v.length > 0);
    if (!entries.length) return rows;
    return rows.filter((row) => {
      const fields = row.fields || {};
      return entries.every(([k, needle]) => {
        const cell = fields[k];
        if (cell == null) return false;
        const val = typeof cell === 'object' ? cell.value : cell;
        if (val == null) return false;
        return String(val).toLowerCase().includes(needle);
      });
    });
  }

  function replaceClaims(zoteroKey, schemaId, claims = []) {
    const zk = String(zoteroKey);
    const sid = String(schemaId);
    const list = Array.isArray(claims) ? claims : [];
    const now = Date.now();
    db.exec('BEGIN');
    try {
      q.delClaims.run(zk, sid);
      const seen = new Set();
      list.forEach((c, idx) => {
        let id = c && c.id ? String(c.id) : `${zk}:${sid}:${idx + 1}`;
        while (seen.has(id)) id = `${id}_${idx + 1}`;
        seen.add(id);
        q.putClaim.run(
          id,
          zk,
          sid,
          String((c && c.condition) || ''),
          String((c && c.conclusion) || ''),
          String((c && c.metric) || ''),
          Number.isFinite(Number(c && c.page)) ? Math.trunc(Number(c.page)) : 0,
          String((c && c.quote) || ''),
          c && c.verified ? 1 : 0,
          now
        );
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function listClaims({ schemaId = null, zoteroKey = null, onlyVerified = false } = {}) {
    const clauses = [];
    const params = [];
    if (schemaId) {
      clauses.push('schema_id = ?');
      params.push(String(schemaId));
    }
    if (zoteroKey) {
      clauses.push('zotero_key = ?');
      params.push(String(zoteroKey));
    }
    if (onlyVerified) {
      clauses.push('verified = 1');
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = db.prepare(`SELECT * FROM paper_claims${where} ORDER BY zotero_key ASC, page ASC, id ASC`).all(...params);
    return rows.map(mapClaimRow);
  }

  function saveContradiction({ id, schemaId, topic, claimIds = [], verdict, summary, paramDiff = {}, status = 'pending' }) {
    const now = Date.now();
    q.saveContra.run(
      String(id),
      String(schemaId),
      String(topic || ''),
      JSON.stringify(Array.isArray(claimIds) ? claimIds : []),
      String(verdict || ''),
      String(summary || ''),
      JSON.stringify(paramDiff || {}),
      String(status || 'pending'),
      now
    );
    const row = db.prepare('SELECT * FROM claim_contradictions WHERE id = ?').get(String(id));
    return mapContradictionRow(row);
  }

  function listContradictions({ schemaId = null, status = null } = {}) {
    const clauses = [];
    const params = [];
    if (schemaId) {
      clauses.push('schema_id = ?');
      params.push(String(schemaId));
    }
    if (status) {
      clauses.push('status = ?');
      params.push(String(status));
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return db.prepare(`SELECT * FROM claim_contradictions${where} ORDER BY updated DESC, id ASC`).all(...params).map(mapContradictionRow);
  }

  function updateContradictionStatus(id, status) {
    q.updContraStatus.run(String(status), Date.now(), String(id));
    const row = db.prepare('SELECT * FROM claim_contradictions WHERE id = ?').get(String(id));
    return mapContradictionRow(row);
  }

  function saveBenchmark({ id, title, zoteroKeys = [], scriptPath = '', npzPath = '', status = 'failed', errorSummary = '' }) {
    const now = Date.now();
    q.saveBench.run(
      String(id),
      String(title || ''),
      JSON.stringify(Array.isArray(zoteroKeys) ? zoteroKeys : []),
      String(scriptPath || ''),
      String(npzPath || ''),
      String(status || 'failed'),
      String(errorSummary || ''),
      now
    );
    const row = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(String(id));
    return mapBenchmarkRow(row);
  }

  function listBenchmarks({ status = null } = {}) {
    const where = status ? ' WHERE status = ?' : '';
    const params = status ? [String(status)] : [];
    return db.prepare(`SELECT * FROM benchmarks${where} ORDER BY updated DESC, id ASC`).all(...params).map(mapBenchmarkRow);
  }

  function mapTeamRow(r) {
    if (!r) return null;
    return {
      id: r.id,
      institution: r.institution,
      lab: r.lab || '',
      pi: r.pi || '',
      bio: r.bio || '',
      tags: parseJson(r.tags_json, []),
      paperCount: r.paper_count != null ? Number(r.paper_count) : undefined,
      updated: Number(r.updated),
    };
  }

  function upsertTeam({ id, institution, lab = '', pi = '', bio = '', tags = [] }) {
    const now = Date.now();
    const prev = db.prepare('SELECT * FROM research_teams WHERE id = ?').get(String(id));
    const mergedTags = [...new Set([...(prev ? parseJson(prev.tags_json, []) : []), ...(Array.isArray(tags) ? tags : [])])].slice(0, 8);
    const nextLab = String(lab || (prev && prev.lab) || '').trim();
    const nextPi = String(pi || (prev && prev.pi) || '').trim();
    const nextBio = String(bio || (prev && prev.bio) || '').trim();
    db.prepare(`INSERT OR REPLACE INTO research_teams (id, institution, lab, pi, bio, tags_json, updated) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(String(id), String(institution || '').trim(), nextLab, nextPi, nextBio, JSON.stringify(mergedTags), now);
    return mapTeamRow(db.prepare('SELECT * FROM research_teams WHERE id = ?').get(String(id)));
  }

  function linkPaperTeam({ zoteroKey, teamId, role = 'author' }) {
    db.prepare('INSERT OR REPLACE INTO paper_teams (zotero_key, team_id, role, updated) VALUES (?, ?, ?, ?)')
      .run(String(zoteroKey), String(teamId), String(role || 'author'), Date.now());
  }

  function getTeam(id) {
    const r = db.prepare(`SELECT t.*, (SELECT count(*) FROM paper_teams pt WHERE pt.team_id = t.id) AS paper_count FROM research_teams t WHERE t.id = ?`).get(String(id));
    return mapTeamRow(r);
  }

  function listTeams() {
    return db.prepare(`SELECT t.*, (SELECT count(*) FROM paper_teams pt WHERE pt.team_id = t.id) AS paper_count FROM research_teams t ORDER BY paper_count DESC, t.updated DESC`).all().map(mapTeamRow);
  }

  function teamsOfPaper(zoteroKey) {
    return db.prepare(`SELECT t.* FROM research_teams t JOIN paper_teams pt ON pt.team_id = t.id WHERE pt.zotero_key = ? ORDER BY pt.role = 'primary' DESC, t.institution ASC`).all(String(zoteroKey)).map(mapTeamRow);
  }

  function papersOfTeam(teamId) {
    return db.prepare('SELECT zotero_key FROM paper_teams WHERE team_id = ? ORDER BY updated DESC').all(String(teamId)).map((r) => r.zotero_key);
  }

  function teamGraph() {
    const nodes = listTeams();
    const links = db.prepare('SELECT zotero_key, team_id FROM paper_teams').all();
    const byPaper = new Map();
    for (const l of links) {
      if (!byPaper.has(l.zotero_key)) byPaper.set(l.zotero_key, []);
      byPaper.get(l.zotero_key).push(l.team_id);
    }
    const edgeMap = new Map();
    for (const [k, tids] of byPaper) {
      const uniq = [...new Set(tids)].sort();
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const ek = uniq[i] + '\0' + uniq[j];
          if (!edgeMap.has(ek)) edgeMap.set(ek, { from: uniq[i], to: uniq[j], weight: 0, kind: 'coauthor', keys: [] });
          const e = edgeMap.get(ek);
          e.weight++;
          e.keys.push(k);
        }
      }
    }
    // Add same-institution and shared-tag lightweight edges (dashed in UI) between top teams
    const top = nodes.slice(0, 45);
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const a = top[i], b = top[j];
        const ek = a.id < b.id ? a.id + '\0' + b.id : b.id + '\0' + a.id;
        if (edgeMap.has(ek)) continue;
        if (a.institution && a.institution === b.institution) {
          edgeMap.set(ek, { from: a.id, to: b.id, weight: 1, kind: 'inst', keys: [] });
        } else {
          const sa = new Set((a.tags || []).map((x) => x.toLowerCase()));
          const shared = (b.tags || []).filter((x) => sa.has(x.toLowerCase()));
          if (shared.length >= 1) {
            edgeMap.set(ek, { from: a.id, to: b.id, weight: shared.length, kind: 'method', label: shared[0], keys: [] });
          }
        }
      }
    }
    return { nodes, edges: [...edgeMap.values()].sort((a, b) => (b.kind === 'coauthor') - (a.kind === 'coauthor') || b.weight - a.weight) };
  }

  function stats() {
    const evidence = Number(db.prepare('SELECT count(*) AS n FROM paper_evidence').get().n);
    const claims = Number(db.prepare('SELECT count(*) AS n FROM paper_claims').get().n);
    const verifiedClaims = Number(db.prepare('SELECT count(*) AS n FROM paper_claims WHERE verified = 1').get().n);
    const contradictions = Number(db.prepare('SELECT count(*) AS n FROM claim_contradictions').get().n);
    const benchmarks = Number(db.prepare('SELECT count(*) AS n FROM benchmarks').get().n);
    const teams = Number(db.prepare('SELECT count(*) AS n FROM research_teams').get().n);
    return {
      file,
      evidence,
      claims,
      verifiedClaims,
      contradictions,
      benchmarks,
      teams,
    };
  }

  function close() {
    try { db.close(); } catch {}
  }

  return {
    file,
    rebuilt,
    getEvidence,
    saveEvidence,
    verifyEvidence,
    listEvidence,
    queryEvidence,
    replaceClaims,
    listClaims,
    saveContradiction,
    listContradictions,
    updateContradictionStatus,
    saveBenchmark,
    listBenchmarks,
    upsertTeam,
    linkPaperTeam,
    getTeam,
    listTeams,
    teamsOfPaper,
    papersOfTeam,
    teamGraph,
    stats,
    close,
  };
}

module.exports = { openKbStruct, SCHEMA_VERSION };
