'use strict';
const {openVault}=require('./database');
const {createMemory}=require('./memory');
const {convert}=require('./opencode');
const {createReview}=require('./review');
const drain=res=>new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
function createVaultService({dir,machines,control,fresh,audit,log=console.error,ask=null,model=()=>null}){
  const vault=openVault(dir),memory=createMemory(vault);
  const review=createReview({vault,memory,ask,model,machines:()=>[...machines.keys()]});
  const version=()=>vault.db.prepare("SELECT value FROM vault_meta WHERE key='memory_version'").get()?.value||'';
  let publishedVersion=version();
  const respond=(ws,rid,r)=>{try{ws.send(JSON.stringify({t:'vault-result',rid,...r}));}catch{}};
  function publish(name){
    const m=machines.get(name);if(!m)return;
    // One capable connection owns memory deployment; a read-only duplicate never receives a write bundle.
    const ws=[...(m.sockets||[])].reverse().find(s=>s.readyState===1&&s.memoryAllowed);
    if(ws)try{ws.send(JSON.stringify({t:'memory-bundle',...memory.bundle(name)}));}catch{log('记忆下发连接中断，重连后同步：'+name);}
  }
  const publishAll=()=>{for(const name of machines.keys())publish(name);publishedVersion=version();};
  // Also notice migrations performed through the same memory module by an administrator on the NAS.
  const timer=setInterval(()=>{try{if(version()!==publishedVersion)publishAll();}catch(e){log('记忆版本检查失败：'+e.message);}},5000);timer.unref();
  function message(machine,d,ws){
    if(d.t==='hello'){
      ws.vaultAllowed=d.vaultVersion===1;ws.memoryCapture=d.memoryVersion===1;ws.memoryAllowed=d.memoryVersion===1&&d.memoryAllowed===true&&control;
      if(ws.memoryAllowed)publish(machine);
      return false;
    }
    if(d.t==='vault-request'){
      if(!ws.vaultAllowed)return true;
      try{
        if(typeof d.rid!=='string'||d.rid.length>80)return true;
        const owner=[...(machines.get(machine)?.sockets||[])].reverse().find(s=>s.readyState===1&&s.vaultAllowed);
        if(owner&&owner!==ws)throw Error('同名机器已有另一个采集实例，当前实例等待');
        const fn=d.action==='begin'?vault.begin:d.action==='chunk'?vault.append:d.action==='finish'?vault.finish:null;
        if(!fn)throw Error('未知的存档操作');
        respond(ws,d.rid,{ok:true,...fn(machine,d)});
      }catch(e){respond(ws,d.rid,{ok:false,msg:e.message,retryReset:/整文件校验失败/.test(e.message)});}
      return true;
    }
    if(d.t==='memory-observe'){
      if(ws.memoryCapture)try{memory.observe(machine,d);}catch(e){log('记忆采集失败：'+machine+' '+e.message);}
      return true;
    }
    if(d.t==='memory-applied'){
      if(ws.memoryAllowed)memory.deployed(machine,d);
      return true;
    }
    return false;
  }
  async function handle(req,res,url,sess,json,send,readBody){
    const p=url.pathname;
    if(!/^\/api\/knowledge(?:\/|$)/.test(p))return false;
    res.setHeader('Cache-Control','no-store');
    try{
      if(req.method==='GET'){
        if(p==='/api/knowledge'){
          json(res,200,{ok:true,stats:vault.stats(),memories:memory.list(),observed:memory.observed(),projects:memory.projects(),deployments:memory.deployments(),
            machines:[...machines.values()].map(m=>({name:m.name,online:m.online,archive:[...(m.sockets||[])].some(s=>s.vaultAllowed),memory:[...(m.sockets||[])].some(s=>s.memoryAllowed)}))});
        }else if(p==='/api/knowledge/sources')json(res,200,{ok:true,items:vault.list(Object.fromEntries(url.searchParams))});
        else if(p==='/api/knowledge/versions')json(res,200,{ok:true,items:vault.db.prepare('SELECT * FROM sources WHERE machine=? AND key=? ORDER BY created DESC,rowid DESC LIMIT 500').all(url.searchParams.get('machine'),url.searchParams.get('key'))});
        else if(p==='/api/knowledge/observed')json(res,200,{ok:true,item:memory.readObserved(url.searchParams.get('machine'),url.searchParams.get('path'))});
        else if(p==='/api/knowledge/history')json(res,200,{ok:true,items:memory.history(url.searchParams.get('id'))});
        else if(p==='/api/knowledge/reviews')json(res,200,{ok:true,items:review.list()});
        else if(p==='/api/knowledge/review')json(res,200,{ok:true,item:review.read(url.searchParams.get('id'))});
        else if(p==='/api/knowledge/preview')json(res,200,{ok:true,...memory.bundle(url.searchParams.get('machine')||'')});
        else if(p==='/api/knowledge/raw'||p==='/api/knowledge/opencode'){
          const m=url.searchParams.get('machine'),key=url.searchParams.get('key'),gen=url.searchParams.get('generation');
          const s=gen?vault.source(m,key,gen):vault.latest(m,key);
          if(!s)throw Error('找不到原始存档');
          if(p.endsWith('/opencode')){
            if(!s.complete)throw Error('请等待原始存档整文件校验完成');
            if(s.kind!=='native')throw Error('此文件是工具输出或事件附件，请下载原文件，不能单独转换为会话');
            const directory=url.searchParams.get('directory')||s.cwd;
            if(!directory||!(/^[A-Za-z]:[\\/]/.test(directory)||directory.startsWith('/')))throw Error('需要目标电脑上的绝对项目目录');
            if(s.provider==='opencode')throw Error('此会话已是 OpenCode：下载原生 JSON 后使用 session import 导入');
            res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="opencode-session.json"','Cache-Control':'no-store'});
            for(const b of convert(s,vault.data(m,key,s.generation),directory)){if(res.destroyed)break;if(!res.write(b))await drain(res);}
            res.end();return true;
          }
          // Fix the generation before streaming; each SQLite iterator is consumed before yielding for backpressure.
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="'+(s.provider==='opencode'&&s.kind==='native'?'opencode-session.json':'session-native.jsonl')+'"','Cache-Control':'no-store','X-Archive-SHA256':s.digest,'X-Archive-Complete':String(!!s.complete)});
          let start=0;
          while(start<s.bytes&&!res.destroyed){
            const row=vault.db.prepare('SELECT start,data FROM chunks WHERE machine=? AND key=? AND generation=? AND start=?').get(m,key,s.generation,start);
            if(!row)throw Error('存档数据块缺失');
            const b=Buffer.from(row.data);start+=b.length;if(!res.write(b))await drain(res);
          }res.end();
        }else json(res,404,{ok:false,msg:'找不到接口'});
        return true;
      }
      if(req.method!=='POST'){json(res,405,{ok:false});return true;}
      if(!control){json(res,200,{ok:false,msg:'服务器处于只读模式'});return true;}
      if(!fresh(sess)){json(res,200,{ok:false,need:'totp',msg:'需要再输一次验证码'});return true;}
      const d=JSON.parse(await readBody(req,2*1024*1024));let result;
      if(p==='/api/knowledge/save')result=memory.save(d);
      else if(p==='/api/knowledge/align')result=review.alignment(d.refs);
      else if(p==='/api/knowledge/review/start')result=review.start(d);
      else if(p==='/api/knowledge/review/manual')result=review.manual(d);
      else if(p==='/api/knowledge/review/apply')result=review.apply(d);
      else if(p==='/api/knowledge/review/discard')review.discard(d.id);
      else if(p==='/api/knowledge/promote')result=memory.promoted(d);
      else if(p==='/api/knowledge/project')memory.project(d);
      else if(p==='/api/knowledge/sync'){
        if(!machines.get(d.machine)?.online)throw Error('目标电脑离线，已发布的记忆会在重连时同步');
        publish(d.machine);
      }else throw Error('未知的管理操作');
      if(['/api/knowledge/save','/api/knowledge/promote','/api/knowledge/project','/api/knowledge/review/apply'].includes(p))publishAll();
      audit('knowledge-change',p,String(d.id||d.machine||'').slice(0,200));
      json(res,200,{ok:true,item:result});
    }catch(e){if(!res.headersSent)json(res,200,{ok:false,msg:e.message});else res.destroy();}
    return true;
  }
  return {vault,memory,review,message,handle,publish,publishAll,close:()=>{review.close();clearInterval(timer);vault.close();}};
}
module.exports={createVaultService};
