// Semantic search and Reciprocal Rank Fusion (RRF) with keyword search results.
'use strict';

const DEFAULT_RRF_K = 60;

function makeSnippet(text, maxLen = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…';
}

// Fuse keyword-ranked sessions and vector-ranked sessions via RRF:
// score(session) = sum( 1 / (k + rank_i) )
function fuseSessions(kwSessions, vecSessions, { k = DEFAULT_RRF_K, maxSessions = 30, hitsPerSession = 3 } = {}) {
  const map = new Map();                 // "machine|id" -> merged entry

  kwSessions.forEach((s, idx) => {
    const key = s.machine + '|' + s.id;
    const rank = idx + 1;
    map.set(key, {
      ...s,
      hits: [...(s.hits || [])],
      kwRank: rank,
      vecRank: null,
      vecScore: null,
      rrf: 1 / (k + rank),
      matchBy: 'keyword',
    });
  });

  vecSessions.forEach((s, idx) => {
    const key = s.machine + '|' + s.id;
    const rank = idx + 1;
    const add = 1 / (k + rank);
    const cur = map.get(key);
    if (cur) {
      cur.vecRank = rank;
      cur.vecScore = s.vecScore;
      cur.rrf += add;
      cur.matchBy = 'both';
      cur.last = Math.max(cur.last || 0, s.last || 0);
      for (const h of s.hits || []) {
        if (cur.hits.length >= hitsPerSession) break;
        if (!cur.hits.some((x) => x.t === h.t && x.snippet === h.snippet)) {
          cur.hits.push(h);
        }
      }
    } else {
      map.set(key, {
        ...s,
        hits: (s.hits || []).slice(0, hitsPerSession),
        kwRank: null,
        vecRank: rank,
        rrf: add,
        matchBy: 'semantic',
      });
    }
  });

  return [...map.values()]
    .sort((a, b) => (b.rrf - a.rrf) || ((b.last || 0) - (a.last || 0)))
    .slice(0, maxSessions);
}

function createEmbedSearch({ client, store }) {
  // Vector search over conversation chunks, aggregated into session results.
  async function querySessions(q, { topChunks = 50, maxSessions = 30, hitsPerSession = 3 } = {}) {
    const text = String(q || '').trim();
    if (!text) return { ok: true, sessions: [], ms: 0 };
    const t0 = Date.now();
    try {
      const { vector } = await client.embedQuery(text);
      const chunks = store.searchVectors(vector, topChunks);
      const bySession = new Map();       // "machine|session" -> { machine, session, last, vecScore, hits }

      for (const ch of chunks) {
        for (const r of ch.refs || []) {
          const key = r.machine + '|' + r.session;
          let entry = bySession.get(key);
          if (!entry) {
            entry = {
              machine: r.machine,
              session: r.session,
              last: r.t || 0,
              vecScore: ch.score,
              hits: [],
            };
            bySession.set(key, entry);
          }
          if (ch.score > entry.vecScore) entry.vecScore = ch.score;
          if ((r.t || 0) > entry.last) entry.last = r.t || 0;
          if (entry.hits.length < hitsPerSession) {
            const snip = makeSnippet(ch.text);
            if (!entry.hits.some((h) => h.t === r.t && h.snippet === snip)) {
              entry.hits.push({ t: r.t, role: r.role, text: ch.text, snippet: snip, score: ch.score });
            }
          }
        }
      }

      const sessions = [...bySession.values()]
        .sort((a, b) => (b.vecScore - a.vecScore) || (b.last - a.last))
        .slice(0, maxSessions);

      return { ok: true, sessions, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, reason: e.message || String(e), sessions: [], ms: Date.now() - t0 };
    }
  }

  // Stage 2: find most semantically relevant memories for a query.
  async function queryMemories(q, { topK = 8, kinds = ['memory'] } = {}) {
    const text = String(q || '').trim();
    if (!text) return { ok: true, items: [], ms: 0 };
    const t0 = Date.now();
    try {
      const { vector } = await client.embedQuery(text);
      const items = store.searchMemories(vector, { topK, kinds });
      return { ok: true, items, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, reason: e.message || String(e), items: [], ms: Date.now() - t0 };
    }
  }

  return {
    querySessions,
    queryMemories,
    fuseSessions,
  };
}

module.exports = {
  createEmbedSearch,
  fuseSessions,
  makeSnippet,
  DEFAULT_RRF_K,
};
