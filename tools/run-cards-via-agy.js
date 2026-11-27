#!/usr/bin/env node
// Generate literature deep cards on a machine that has `agy` CLI installed (e.g. huatanshaonian PC),
// reading fulltext/profile/kb_struct from NAS over SSH and writing finished cards back to NAS.
// Usage: node tools/run-cards-via-agy.js [--offset 75] [--limit 80] [--model gemini-4-neon] [--effort medium]
'use strict';
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OFFSET = Math.max(0, parseInt(opt('--offset', '75'), 10) || 0);
const LIMIT = Math.max(1, parseInt(opt('--limit', '80'), 10) || 80);
const MODEL = opt('--model', 'gemini-4-neon');
const EFFORT = opt('--effort', 'medium');
const SSH_HOST = opt('--nas', 'nas');
const AGY_BIN = opt('--agy-bin', 'agy');

const { DEEP_SCHEMA, deepPrompt } = require(path.join(__dirname, '..', 'remote', 'server', 'literature', 'prompts', 'card'));
const CHUNK_SCHEMA = { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'] };
const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);

function nasNode(script, inputObj = null) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const cmd = `/usr/local/bin/node -e "eval(Buffer.from('${b64}','base64').toString())"`;
  const r = cp.spawnSync('ssh', ['-o', 'BatchMode=yes', SSH_HOST, cmd], {
    input: inputObj != null ? JSON.stringify(inputObj) : undefined,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`NAS node failed (${r.status}): ${String(r.stderr || r.stdout).slice(0, 400)}`);
  return JSON.parse(String(r.stdout || '').trim());
}

function callAgy(prompt, schema, eff = EFFORT) {
  const id = crypto.randomBytes(6).toString('hex');
  const sf = path.join(os.tmpdir(), `agy-card-${id}.json`);
  const pf = path.join(os.tmpdir(), `agy-prompt-${id}.txt`);
  try {
    fs.writeFileSync(sf, JSON.stringify(schema));
    fs.writeFileSync(pf, String(prompt || ''), 'utf8');
    const args = ['--output-format', 'json', '--json-schema', sf, '--disable-slash-commands', '--model', MODEL, '--effort', eff, '--print', 'Follow the instructions from stdin and return only the requested JSON.'];
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd = null;
      try {
        fd = fs.openSync(pf, 'r');
        const r = cp.spawnSync(AGY_BIN, args, {
          stdio: [fd, 'pipe', 'pipe'],
          encoding: 'utf8',
          timeout: 360000,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        });
        fs.closeSync(fd); fd = null;
        if (r.error) throw r.error;
        if (r.status !== 0) throw new Error(`agy failed (${r.status}): ${String(r.stderr || r.stdout).slice(0, 300)}`);
        const out = JSON.parse(String(r.stdout || '').trim());
        if (out.structured_output != null) return out.structured_output;
        return typeof out.response === 'string' ? JSON.parse(out.response) : out;
      } catch (e) {
        if (fd != null) { try { fs.closeSync(fd); } catch {} }
        lastErr = e;
      }
    }
    throw lastErr;
  } finally {
    try { fs.unlinkSync(sf); } catch {}
    try { fs.unlinkSync(pf); } catch {}
  }
}

const LIST_SCRIPT = `
const fs=require('fs'), path=require('path');
const SERVER='/volume2/docker/ame-remote/remote/server';
const cfg=JSON.parse(fs.readFileSync(path.join(SERVER,'config.json'),'utf8'));
const litCfg=cfg.literature||{};
const dataDir=path.resolve(SERVER,cfg.dataDir||'data');
const litDir=path.join(dataDir,'literature');
const {createMirror}=require(path.join(SERVER,'literature/zotero/mirror'));
const {createWebdav}=require(path.join(SERVER,'literature/zotero/webdav'));
const {createFulltext}=require(path.join(SERVER,'literature/fulltext'));
const {createKb}=require(path.join(SERVER,'literature/kb'));
const {createCards}=require(path.join(SERVER,'literature/cards'));
const mirror=createMirror({api:null,dir:litDir,log:()=>{}});
const webdav=createWebdav({dir:litCfg.webdavDir||''});
const fulltext=createFulltext({dir:litDir,mirror,webdav,bin:litCfg.pdftotext||'pdftotext',log:()=>{}});
const kb=createKb({dir:path.resolve(SERVER,litCfg.kbDir||path.join(litDir,'kb')),log:()=>{}});
const cards=createCards({kb,mirror,fulltext,profile:{get:()=>({}),openQuestions:()=>[],words:()=>[]},ask:async()=>{},api:{canWrite:()=>false},writeNotes:false});
const cols=['等离子体RCS','等离子体鞘套电磁散射','多保真、多模态','调研工作','每日文献','rcs模型','气动隐身'];
const all=[], seen=new Set();
for(const cn of cols){
  const c=mirror.collectionByName(cn); if(!c) continue;
  for(const it of mirror.inCollection(c.key).sort((a,b)=>(Number(b.year)||0)-(Number(a.year)||0)||b.added-a.added)){
    if(seen.has(it.key)||!fulltext.hasPdf(it.key)) continue;
    const cur=cards.find(it.key);
    if(cur && /deep|reviewed/.test(String(cur.meta.status||''))) continue;
    seen.add(it.key); all.push(it.key);
  }
}
const {offset,limit}=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify({total:all.length,keys:all.slice(offset,offset+limit)}));
`;

const PREPARE_SCRIPT = `
const fs=require('fs'), path=require('path');
const SERVER='/volume2/docker/ame-remote/remote/server';
const cfg=JSON.parse(fs.readFileSync(path.join(SERVER,'config.json'),'utf8'));
const litCfg=cfg.literature||{};
const dataDir=path.resolve(SERVER,cfg.dataDir||'data');
const litDir=path.join(dataDir,'literature');
const {createMirror}=require(path.join(SERVER,'literature/zotero/mirror'));
const {createWebdav}=require(path.join(SERVER,'literature/zotero/webdav'));
const {createFulltext,fitPages}=require(path.join(SERVER,'literature/fulltext'));
const {createKb}=require(path.join(SERVER,'literature/kb'));
const {createProfile}=require(path.join(SERVER,'literature/profile'));
const {createCards,annotationLines}=require(path.join(SERVER,'literature/cards'));
const {deepPrompt}=require(path.join(SERVER,'literature/prompts/card'));
const {openKbStruct}=require(path.join(SERVER,'literature/kb-struct'));
const embedMod=require(path.join(SERVER,'embed'));
(async()=>{
  const {key}=JSON.parse(fs.readFileSync(0,'utf8'));
  const mirror=createMirror({api:null,dir:litDir,log:()=>{}});
  const webdav=createWebdav({dir:litCfg.webdavDir||''});
  const fulltext=createFulltext({dir:litDir,mirror,webdav,bin:litCfg.pdftotext||'pdftotext',log:()=>{}});
  const kb=createKb({dir:path.resolve(SERVER,litCfg.kbDir||path.join(litDir,'kb')),log:()=>{}});
  const profile=createProfile({dir:litDir,mirror,ask:async()=>({}),log:()=>{}});
  const kbStruct=openKbStruct({dir:litDir,log:()=>{}});
  const embed=cfg.embed?embedMod.open({dataDir,cfg:cfg.embed,log:()=>{}}):null;
  const item=mirror.item(key);
  const ft=await fulltext.forItem(key);
  if(!item||!ft.pages||!ft.pages.length){ process.stdout.write(JSON.stringify({ok:false,reason:'no-text'})); if(embed&&embed.close)embed.close(); kbStruct.close(); return; }
  const pages=fitPages(ft.pages,85000,ft.labels);
  const isLong=ft.chars>85000;
  let chunks=[];
  if(isLong){
    let cur=[], curChars=0, fromPage=ft.pages[0].page;
    for(const pg of ft.pages){
      const t=String(pg.text||'');
      if(cur.length && curChars+t.length>38000){
        chunks.push({from:fromPage,to:cur[cur.length-1].page,text:cur.map(x=>'[p.'+x.page+']\\n'+x.text).join('\\n\\n')});
        cur=[]; curChars=0; fromPage=pg.page;
      }
      cur.push(pg); curChars+=t.length;
    }
    if(cur.length) chunks.push({from:fromPage,to:cur[cur.length-1].page,text:cur.map(x=>'[p.'+x.page+']\\n'+x.text).join('\\n\\n')});
  }
  const others=kb.list('papers').filter(r=>r.meta.zotero!==key).map(r=>({citekey:path.basename(r.path,'.md'),title:r.meta.title||''})).slice(0,120);
  const similarEv=[];
  if(kbStruct&&embed&&typeof embed.similarLitItems==='function'){
    try{
      const near=(await embed.similarLitItems(key,{topK:6}))||[];
      for(const x of near){
        if(!x||x.key===key||similarEv.length>=5) continue;
        const ev=kbStruct.getEvidence(x.key,'plasma_rcs_v1')||kbStruct.getEvidence(x.key,'aero_stealth_v1');
        const it2=mirror.item(x.key); if(!ev||!it2) continue;
        const vf={};
        for(const [fk,fv] of Object.entries(ev.fields||{})) if(fv&&fv.value&&fv.verified) vf[fk]={value:fv.value,page:fv.page||0};
        if(Object.keys(vf).length) similarEv.push({zoteroKey:x.key,citekey:it2.citekey,title:it2.title,year:it2.year,fields:vf});
      }
    }catch{}
  }
  if(isLong){
    process.stdout.write(JSON.stringify({ok:true,isLong:true,chars:ft.chars,pageCount:ft.pages.length,chunks,item,notes:annotationLines(mirror,key),others,similarEv,profile:profile.get()||{}}));
  } else {
    const prompt=deepPrompt(profile.get()||{},item,pages,annotationLines(mirror,key),'',others,{n:ft.pages.length},[],similarEv);
    process.stdout.write(JSON.stringify({ok:true,isLong:false,chars:ft.chars,pageCount:ft.pages.length,prompt}));
  }
  if(embed&&embed.close)embed.close();
  kbStruct.close();
})().catch(e=>{console.error(e);process.exit(1);});
`;

const SAVE_SCRIPT = `
const fs=require('fs'), path=require('path');
const SERVER='/volume2/docker/ame-remote/remote/server';
const cfg=JSON.parse(fs.readFileSync(path.join(SERVER,'config.json'),'utf8'));
const litCfg=cfg.literature||{};
const dataDir=path.resolve(SERVER,cfg.dataDir||'data');
const litDir=path.join(dataDir,'literature');
const {createMirror}=require(path.join(SERVER,'literature/zotero/mirror'));
const {createWebdav}=require(path.join(SERVER,'literature/zotero/webdav'));
const {createFulltext}=require(path.join(SERVER,'literature/fulltext'));
const {createKb}=require(path.join(SERVER,'literature/kb'));
const {createProfile}=require(path.join(SERVER,'literature/profile'));
const {createCards}=require(path.join(SERVER,'literature/cards'));
(async()=>{
  const {key,answer}=JSON.parse(fs.readFileSync(0,'utf8'));
  const mirror=createMirror({api:null,dir:litDir,log:()=>{}});
  const webdav=createWebdav({dir:litCfg.webdavDir||''});
  const fulltext=createFulltext({dir:litDir,mirror,webdav,bin:litCfg.pdftotext||'pdftotext',log:()=>{}});
  const kb=createKb({dir:path.resolve(SERVER,litCfg.kbDir||path.join(litDir,'kb')),log:()=>{}});
  const profile=createProfile({dir:litDir,mirror,ask:async()=>({}),log:()=>{}});
  const cards=createCards({kb,mirror,fulltext,profile,ask:async()=>answer,askDeep:async()=>answer,api:{canWrite:()=>false},writeNotes:false});
  const r=await cards.makeDeep(key);
  process.stdout.write(JSON.stringify({ok:true,path:r.path}));
})().catch(e=>{console.error(e);process.exit(1);});
`;

async function main() {
  const { total, keys } = nasNode(LIST_SCRIPT, { offset: OFFSET, limit: LIMIT });
  log(`AGY CARDS BATCH: model=${MODEL} effort=${EFFORT} offset=${OFFSET} selected=${keys.length} (total remaining=${total})`);
  let ok = 0, fail = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    try {
      const prep = nasNode(PREPARE_SCRIPT, { key: k });
      if (!prep.ok) {
        fail++;
        log(`  [${i + 1}/${keys.length}] SKIP ${k}: ${prep.reason}`);
        continue;
      }
      let finalPrompt = prep.prompt;
      if (prep.isLong) {
        log(`  [${i + 1}/${keys.length}] LONG REPORT ${k} (${prep.pageCount}p, ${Math.round(prep.chars / 1000)}k chars) -> digesting ${prep.chunks.length} chunks...`);
        const digestParts = [];
        for (let ci = 0; ci < prep.chunks.length; ci++) {
          const ch = prep.chunks[ci];
          const cpPrompt = `这是长报告「${prep.item.title}」的第 ${ch.from}～${ch.to} 页（共 ${prep.pageCount} 页，第 ${ci + 1}/${prep.chunks.length} 段）。请用中文整理详细分段阅读笔记（保留关键公式、参数、数值、图表结论与页码 [p.N]，不要提问）：\n\n${ch.text}`;
          const cr = callAgy(cpPrompt, CHUNK_SCHEMA, 'low');
          digestParts.push({ from: ch.from, to: ch.to, notes: String((cr && cr.notes) || '') });
        }
        finalPrompt = deepPrompt(prep.profile, prep.item, [], prep.notes, '', prep.others, { n: prep.pageCount, digest: digestParts }, [], prep.similarEv);
      }
      const answer = callAgy(finalPrompt, DEEP_SCHEMA, EFFORT);
      const saved = nasNode(SAVE_SCRIPT, { key: k, answer });
      ok++;
      log(`  [${i + 1}/${keys.length}] OK ${k} (${prep.pageCount}p${prep.isLong ? ', digested' : ''}) -> ${saved.path}`);
    } catch (e) {
      fail++;
      log(`  [${i + 1}/${keys.length}] ERR ${k}: ${e.message}`);
    }
  }
  log(`ALL AGY CARDS DONE: ok=${ok} fail=${fail}`);
}

main().catch((e) => { log('FATAL: ' + (e.stack || e.message)); process.exit(1); });
