// A first guess at what kind of work a session was, handed to the model as a hint (the model decides from the content):
//   research  科研   personal  个人小项目   chore  杂活（配环境、装软件、一次性小问题）
// Rules come from config.json "summary": { "categories": [{ "match": "feko_data", "cat": "research" }, ...] }
// (case-insensitive substring of the session's folder, / and \ alike). Without a rule: a session in a home folder,
// temp or downloads, or a very short one, is probably a chore.
'use strict';

const CATS = ['research', 'personal', 'chore'];
const NAMES = { research: '科研', personal: '个人小项目', chore: '杂活' };
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

function createClassifier(rules = []) {
  const list = (Array.isArray(rules) ? rules : [])
    .filter((r) => r && typeof r.match === 'string' && r.match && CATS.includes(r.cat))
    .map((r) => ({ match: norm(r.match), cat: r.cat }));

  // d: a digest (summary/digest.js) -> { cat: 'research'|'personal'|'chore'|null, why }
  return function hint(d) {
    const cwd = norm(d.cwd);
    for (const r of list) if (cwd.includes(r.match)) return { cat: r.cat, why: `目录规则「${r.match}」` };
    const home = /^([a-z]:\/users\/[^/]+|\/home\/[^/]+|\/root|\/var\/services\/homes\/[^/]+|\/volume\d+\/homes\/[^/]+)$/.test(cwd);
    if (home) return { cat: 'chore', why: '在主目录里（不是某个项目）' };
    if (/\/(temp|tmp|downloads|下载)(\/|$)/.test(cwd)) return { cat: 'chore', why: '在临时 / 下载目录' };
    if (d.userMsgs <= 2 && d.activeMin <= 10 && !d.files.length) return { cat: 'chore', why: '很短，没有改文件' };
    return { cat: null, why: '' };
  };
}

module.exports = { createClassifier, CATS, NAMES };
