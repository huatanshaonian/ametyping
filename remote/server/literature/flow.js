// 方法 as a flowchart: the deep card's model gives the method's steps and how they lead on ({ nodes, edges }, plain
// text), and this writes them as a Mermaid flowchart -- written here, not by the model, so that it always parses.
// Obsidian draws a ```mermaid block by itself; the 文献 windows draw it with /vendor/mermaid (lit-md.js).
//   node kinds: input (data, known conditions) [/…/], step [ … ], decision { … }, output (results) ([ … ])
'use strict';

const SHAPE = { input: ['[/', '/]'], step: ['[', ']'], decision: ['{', '}'], output: ['([', '])'] };
const MAX_NODES = 16, MAX_EDGES = 30;

// a label as Mermaid takes it inside quotes (its own entity codes for what would end or break the label)
const label = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  .replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/[`$\\]/g, '');

// flow: { nodes: [{ id, kind, text }], edges: [{ from, to, label }] } -> the ```mermaid block, or '' when there is too
// little to draw (fewer than three steps, or nothing connecting them)
function flowMermaid(flow) {
  const nodes = (flow && Array.isArray(flow.nodes) ? flow.nodes : []).filter((x) => x && String(x.text || '').trim()).slice(0, MAX_NODES);
  const ids = new Map();
  nodes.forEach((x, i) => { const k = String(x.id || '').trim(); if (k && !ids.has(k)) ids.set(k, 'n' + (i + 1)); });
  const edges = (flow && Array.isArray(flow.edges) ? flow.edges : []).filter((e) => e && ids.has(String(e.from).trim()) && ids.has(String(e.to).trim()) && String(e.from).trim() !== String(e.to).trim()).slice(0, MAX_EDGES);
  if (nodes.length < 3 || !edges.length) return '';
  const out = ['```mermaid', 'flowchart TD'];
  nodes.forEach((x) => {
    const id = ids.get(String(x.id || '').trim());
    if (!id || out.some((l) => l.startsWith(`  ${id}`))) return;
    const [a, b] = SHAPE[x.kind] || SHAPE.step;
    out.push(`  ${id}${a}"${label(x.text, 60)}"${b}`);
  });
  for (const e of edges) {
    const l = label(e.label, 24);
    out.push(`  ${ids.get(String(e.from).trim())} -->${l ? `|"${l}"|` : ''} ${ids.get(String(e.to).trim())}`);
  }
  out.push('```');
  return out.join('\n');
}

module.exports = { flowMermaid };
