'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openKbStruct } = require('../server/literature/kb-struct');
const { createStream } = require('../server/literature/stream');

test('stream builds Twitter-style feed, extracts teams, and computes collaboration graph', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-stream-'));
  const kbStruct = openKbStruct({ dir });
  try {
    kbStruct.saveEvidence({
      zoteroKey: 'P1',
      schemaId: 'plasma_rcs_v1',
      pdfMd5: 'm1',
      fields: {
        em_method: { value: 'ADE-FDTD', page: 2, quote: 'ADE-FDTD', verified: true },
        key_result: { value: '10 GHz reflection -1.02 dB', page: 4, quote: '-1.02 dB', verified: true },
      },
      verifiedRatio: 1,
      model: 'test',
    });

    const mirror = {
      items: () => [{ key: 'P1', citekey: 'luebbers1991', title: 'Luebbers Plasma FDTD', creators: ['R. Luebbers'], year: 1991, venue: 'IEEE TAP', added: 1000 }],
      item: (k) => (k === 'P1' ? { key: 'P1', citekey: 'luebbers1991', title: 'Luebbers Plasma FDTD', creators: ['R. Luebbers'], year: 1991, venue: 'IEEE TAP', abstract: 'Drude plasma slab', added: 1000 } : null),
    };
    const cards = {
      all: () => [{ key: 'P1', status: 'deep', oneLine: '提出频变 Drude ADE-FDTD 方法，宽带误差 < 0.1 dB', cover: 'figures/luebbers1991/p4-1.png', figs: 2, starred: true }],
    };
    const fulltext = {
      forItem: async () => ({ pages: [{ page: 1, text: 'Pennsylvania State University & NASA Langley Research Center' }] }),
    };
    const ask = async () => ({
      teams: [
        { institution: 'Pennsylvania State University', lab: 'EM Lab', pi: 'R. Luebbers', bio: '专注色散介质 FDTD 算法', tags: ['ADE-FDTD', 'Plasma'] },
        { institution: 'NASA Langley Research Center', lab: 'Electromagnetics', pi: '', bio: '高超声速再入通信与散射实验', tags: ['RAM-C'] },
      ],
    });

    const stream = createStream({ kbStruct, mirror, cards, fulltext, ask });
    const ext = await stream.extractTeamsForPaper('P1');
    assert.equal(ext.ok, true);
    assert.equal(ext.teams.length, 2);

    const feed = stream.listStream();
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].cover, 'figures/luebbers1991/p4-1.png');
    assert.equal(feed.items[0].teams.length, 2);
    assert.ok(feed.items[0].tags.includes('ADE-FDTD'));

    const graph = stream.teamGraph();
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].weight, 1);

    const detail = stream.teamDetail(ext.teams[0].id);
    assert.equal(detail.collaborators.length, 1);
    assert.equal(detail.papers.length, 1);
  } finally {
    kbStruct.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
