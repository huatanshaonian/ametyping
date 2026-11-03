'use strict';
const { createResearchStore } = require('./database');
const { resolveDeepseek, runDeepseek } = require('../ai/deepseek-api');
const { SCHEMA, promptFor, validateResult, VERSION } = require('./extract');
const fs = require('fs'), path = require('path');
const {createPilots}=require('./pilots');

function createResearch({ vault, config = {}, getProject = () => null, control = false, fresh = () => false,
  audit = () => {}, log = () => {}, call = runDeepseek, resolve = null }) {
  const store = createResearchStore(vault), db = vault.db;
  const pilots=createPilots(path.dirname(vault.file));
  const settingsFile = path.join(path.dirname(vault.file),'research-api.json');
  const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile,'utf8')); } catch(e) { if(e.code==='ENOENT')return {};throw Error('NAS DeepSeek 专用配置无法读取'); } };
  const credentials = resolve || (() => resolveDeepseek({...config,...readSettings()}));
  function saveSettings(input) {
    const next = {...readSettings()};
    for(const k of ['model','base'])if(typeof input[k]==='string'&&input[k].trim())next[k]=input[k].trim();
    if(typeof input.key==='string'&&input.key.trim()){
      if(input.key.length>8000||/[\r\n]/.test(input.key))throw Error('API 密钥格式无效');
      next.key=input.key.trim();
    }
    if(next.model&&!/^[A-Za-z0-9._-]{1,120}$/.test(next.model))throw Error('模型名称无效');
    resolveDeepseek({...config,...next}); // validate before replacing the config
    fs.writeFileSync(settingsFile+'.tmp',JSON.stringify(next,null,2),{mode:0o600});
    fs.chmodSync(settingsFile+'.tmp',0o600);fs.renameSync(settingsFile+'.tmp',settingsFile);
    return publicConfig();
  }
  let active = false, closed = false, abort = null;
  // Interrupted requests have uncertain billing. Never silently repeat them after a server restart.
  db.prepare("UPDATE research_jobs SET state='interrupted',error='服务中断；核对后手动重试',updated=? WHERE state='running'").run(Date.now());
  const publicConfig = () => {
    try { const c = credentials(); return { provider: 'deepseek', model: c.model, configured: !!c.key, base: c.base }; }
    catch (e) { return { provider: 'deepseek', configured: false, error: e.message }; }
  };
  function checkProject(project) {
    if (typeof project !== 'string' || !project || project.length > 100 || !getProject(project)) throw Error('请选择已登记的项目');
    return project;
  }
  async function tick() {
    if (active || closed) return;
    const job = db.prepare("SELECT * FROM research_jobs WHERE state='queued' ORDER BY created,id LIMIT 1").get();
    if (!job) return;
    active = true; abort = new AbortController(); const usage = JSON.parse(job.usage);
    try {
      if(job.version!==VERSION)throw Error('抽取器版本已更新，请重新排队生成新任务');
      db.prepare("UPDATE research_jobs SET state='running',updated=? WHERE id=?").run(Date.now(),job.id);
      const segment = JSON.parse(job.input), source = store.doc(job.document);
      let result, lastError;
      // At most two calls. Retry malformed/unsupported evidence once; auth/config errors are not retried.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (closed) throw Error('抽取已停止');
        db.prepare('UPDATE research_jobs SET attempts=attempts+1,updated=? WHERE id=?').run(Date.now(),job.id);
        try {
          const c = credentials();
          const response = await call({ ...c, model: job.model, prompt: promptFor(segment,source) +
            (lastError ? '\n上次输出校验失败：'+lastError+'。请修正，逐字引用输入，无法支持的内容删去。' : ''),
            schema: SCHEMA, maxTokens: config.maxTokens || 6000, timeoutMs: config.timeoutMs || 120000,
            signal: abort.signal, onUsage: u => {
              usage.push({...u,model:job.model,base:c.base,attempt:job.attempts+attempt+1,at:Date.now()});
              if(!closed)db.prepare('UPDATE research_jobs SET usage=?,updated=? WHERE id=?').run(JSON.stringify(usage),Date.now(),job.id);
            } });
          db.prepare('INSERT INTO research_attempts(job,attempt,model,request_id,response,created) VALUES(?,?,?,?,?,?)')
            .run(job.id,job.attempts+attempt+1,response.model||job.model,response.requestId||'',JSON.stringify(response.data),Date.now());
          result = validateResult(response.data,segment); break;
        } catch (e) {
          lastError = e.message;
          if(!closed)db.prepare('UPDATE research_attempts SET validation_error=? WHERE job=? AND attempt=?')
            .run(String(e.message).slice(0,500),job.id,job.attempts+attempt+1);
          if (closed || (e.status && !e.retryable) || /尚未配置|API 地址|配置|HTTPS/.test(e.message) || attempt === 1) throw e;
        }
      }
      if (closed) return;
      store.finish(job,result,usage);
      log('研究抽取完成：'+job.id.slice(0,12)+'，工作 '+result.work_items.length+' 项');
    } catch (e) {
      if (!closed) db.prepare("UPDATE research_jobs SET state='failed',error=?,usage=?,updated=? WHERE id=?")
        .run(String(e.message).slice(0,500),JSON.stringify(usage),Date.now(),job.id);
    } finally { active = false; abort = null; }
  }
  const timer = setInterval(() => { tick().catch(e=>log('研究队列：'+e.message)); },1000); timer.unref();
  function enqueue(project, document, options = {}) {
    checkProject(project); const cfg = credentials();
    if (!cfg.key) throw Error('NAS 尚未配置 DeepSeek API');
    return store.enqueue(project,document,cfg.model,options);
  }
  function retry(project,id) {
    const job = db.prepare('SELECT state FROM research_jobs WHERE project=? AND id=?').get(project,id);
    if (!job || !['failed','interrupted'].includes(job.state)) throw Error('仅失败或中断的任务可以重试');
    db.prepare("UPDATE research_jobs SET state='queued',error='',updated=? WHERE id=?").run(Date.now(),id);
  }
  async function handle(req,res,url,sess,json,readBody) {
    if (!/^\/api\/research(?:\/|$)/.test(url.pathname)) return false;
    res.setHeader('Cache-Control','no-store');
    try {
      if (req.method === 'GET') {
        if(url.pathname==='/api/research/pilots'){json(res,200,{ok:true,...pilots.list()});return true;}
        if(url.pathname==='/api/research/pilot'){json(res,200,{ok:true,item:pilots.read(url.searchParams.get('id'))});return true;}
        if(url.pathname==='/api/research/pilot/evidence'){
          json(res,200,{ok:true,item:pilots.evidence(url.searchParams.get('id'),url.searchParams.get('event'),url.searchParams.get('offset')||0)});return true;
        }
        const project = checkProject(url.searchParams.get('project'));
        if (url.pathname === '/api/research') json(res,200,{ok:true,provider:publicConfig(),...store.list(project)});
        else if (url.pathname === '/api/research/search') json(res,200,{ok:true,items:store.search(project,url.searchParams.get('q'))});
        else if (url.pathname === '/api/research/evidence') json(res,200,{ok:true,item:store.evidenceFor(project,url.searchParams.get('id'))});
        else if (url.pathname === '/api/research/raw') {
          const d=store.documentFor(project,url.searchParams.get('id'));
          if(!d.size)throw Error('旧试点资料缺少原始长度，请重新导入');
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':d.size,'Content-Disposition':'attachment; filename="research-original.jsonl"','X-Archive-SHA256':d.digest});
          let left=d.size;
          for(const bytes of vault.data(d.machine,d.key,d.generation)){
            if(!left||res.destroyed)break;const b=bytes.subarray(0,left);left-=b.length;
            if(!res.write(b))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
          }
          if(left)throw Error('原始存档前缀缺失');res.end();
        }
        else if (url.pathname === '/api/research/sources') {
          // Filter candidate sources by registered workspace, using machine + path boundaries rather than folder names.
          const p = getProject(project), norm = x => String(x||'').replace(/\\/g,'/').replace(/\/$/,'');
          const inside = (a,b) => { a=norm(a); b=norm(b); if (/^[A-Za-z]:/.test(a)) { a=a.toLowerCase(); b=b.toLowerCase(); } return a===b || a.startsWith(b+'/'); };
          const sources = vault.db.prepare(`SELECT s.* FROM sources s WHERE complete=1 AND kind='native'
            AND rowid=(SELECT rowid FROM sources t WHERE t.machine=s.machine AND t.key=s.key ORDER BY created DESC,rowid DESC LIMIT 1)
            ORDER BY updated DESC`).all().filter(s => (s.provider==='opencode'||/\.jsonl$/i.test(s.path)) &&
              (p.workspaces||[]).some(w=>w.machine===s.machine&&inside(s.cwd,w.path)));
          json(res,200,{ok:true,items:sources.slice(0,500),total:sources.length});
        } else json(res,404,{ok:false,msg:'找不到研究接口'});
        return true;
      }
      if (req.method !== 'POST') { json(res,405,{ok:false}); return true; }
      if (!control) throw Error('服务器处于只读模式');
      if (!fresh(sess)) { json(res,200,{ok:false,need:'totp',msg:'需要再输一次验证码'}); return true; }
      const body = JSON.parse(await readBody(req,128*1024)), project = checkProject(body.project); let item;
      if (url.pathname === '/api/research/config') item=saveSettings(body);
      else if (url.pathname === '/api/research/import') {
        if (!Array.isArray(body.refs) || !body.refs.length || body.refs.length > 10) throw Error('每批请选择 1～10 个原生会话');
        item = body.refs.map(ref=>store.importSource(project,ref));
      } else if (url.pathname === '/api/research/enqueue') item = enqueue(project,body.document,{maxJobs:body.maxJobs || 3});
      else if (url.pathname === '/api/research/retry') retry(project,body.id);
      else throw Error('未知的研究操作');
      audit('research-change',url.pathname,project);
      json(res,200,{ok:true,item});
    } catch (e) { if(res.headersSent)res.destroy();else json(res,200,{ok:false,msg:e.message}); }
    return true;
  }
  return { store, tick, enqueue, retry, handle, publicConfig, saveSettings, idle:()=>!active,
    close() { closed=true; clearInterval(timer); if(abort)abort.abort(); } };
}
module.exports = { createResearch };
