// How text goes into the search index and how a query word comes out of it -- the same for every table
// (conversations and documents). Chinese (and Japanese / Korean) is indexed as overlapping two-character pieces
// (网格加密 -> 网格 格加 加密), so any query of two or more such characters is an index lookup (a longer one: those
// pieces as a phrase); other text by words (FTS5 unicode61: case-insensitive; a query word also matches the longer
// words it begins). A single Chinese character -- or no word at all -- is looked for with LIKE over the stored text.
'use strict';

const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g;
const CJK_END = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]$/;
const PREFIX_MAX = 40;                  // a query word standing for more indexed words than this stays a prefix query

// text as the index's tokens: each CJK run as overlapping pairs (one character alone stays), the rest as it is
function seg(s) {
  return String(s).replace(CJK_RUN, (run) => ' ' + (run.length < 2 ? run : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)).join(' ')) + ' ');
}

// a query word -> { sql, arg }: a condition on `table` (its FTS5 table, words listed in `vocab`, the plain text in the
// column `text`). The last word of a term is a prefix (unless it is CJK): expanded to the indexed words it begins,
// each looked up exactly -- a prefix query is slow to run many times.
function condMaker(db, table, vocab) {
  const MATCH = `${table} MATCH ?`;
  const vocabSql = db.prepare(`SELECT term FROM ${vocab} WHERE term >= ? AND term < ? LIMIT ${PREFIX_MAX + 1}`);
  const like = (t) => ({ sql: "text LIKE ? ESCAPE '\\'", arg: '%' + t.replace(/[\\%_]/g, (c) => '\\' + c) + '%' });
  const phrase = (ws) => '"' + ws.join(' ').replace(/"/g, '""') + '"';
  function cond(t) {
    if ((t.match(CJK_RUN) || []).some((r) => r.length < 2)) return like(t);
    const toks = seg(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!toks.length) return like(t);
    if (!/[\p{L}\p{N}]$/u.test(t) || CJK_END.test(t)) return { sql: MATCH, arg: phrase(toks) };
    const last = toks[toks.length - 1].toLowerCase(), head = toks.slice(0, -1);
    const words = vocabSql.all(last, last + '￿').map((r) => r.term);
    if (!words.length) return { sql: MATCH, arg: phrase(toks) };                       // (nothing: matches nothing)
    if (words.length > PREFIX_MAX) return { sql: MATCH, arg: phrase(toks) + ' *' };
    return { sql: MATCH, arg: '(' + words.map((w) => phrase([...head, w])).join(' OR ') + ')' };
  }
  cond.MATCH = MATCH;
  // every term at once: one MATCH when all are index lookups, else the conditions side by side
  cond.all = (terms) => {
    const cs = terms.map(cond);
    return cs.every((c) => c.sql === MATCH) ? { match: true, list: [{ sql: MATCH, arg: cs.map((c) => c.arg).join(' AND ') }], each: cs } : { match: false, list: cs, each: cs };
  };
  return cond;
}

module.exports = { seg, condMaker, CJK_RUN };
