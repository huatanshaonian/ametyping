// Official exports; read-only SQL is used only to discover old and child session IDs.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {spawn}=require('child_process');
const {command}=require('../../app/opencode');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function createOpenCodeExport({home=os.homedir(),log=()=>{},resolveCommand=command}={}){
  const root=path.join(process.env.OPENCODE_AME_HOME||path.join(home,'.ametyping','opencode'),'archive');
  let at=0,busy=false;
  const seen=new Map();
  function run(cmd,args,file){return new Promise((resolve,reject)=>{
    const prefix=args[0]==='debug'?cmd.args.filter(x=>x!=='--standalone'):cmd.args;
    const p=spawn(cmd.exe,[...prefix,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='';const stream=file?fs.createWriteStream(file,{mode:0o600}):null;
    const timer=setTimeout(()=>p.kill(),60000);timer.unref();
    if(stream){p.stdout.pipe(stream);stream.on('error',e=>{clearTimeout(timer);p.kill();reject(e);});}
    else p.stdout.on('data',b=>{out+=b;if(out.length>4e6)p.kill();});
    p.stderr.on('data',b=>{err=(err+b).slice(-1000);});
    p.once('error',reject);p.once('close',code=>{clearTimeout(timer);const done=()=>code===0?resolve(out):reject(Error(err||'OpenCode 导出失败'));
      if(stream&&!stream.writableFinished)stream.once('finish',done);else done();});
  });}
  async function tick(){
    if(busy||Date.now()-at<60000)return;busy=true;at=Date.now();
    try{
      const cmd=resolveCommand();if(!cmd)return;
      const dbpath=(await run(cmd,['debug','paths','db'])).trim();if(!fs.existsSync(dbpath))return;
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(dbpath,{readOnly:true});let sessions;
      try{sessions=db.prepare('SELECT id,time_updated FROM session_v2 ORDER BY time_updated DESC').all();}finally{db.close();}
      fs.mkdirSync(root,{recursive:true,mode:0o700});
      for(const s of sessions){
        if(!/^ses_[A-Za-z0-9]{6,100}$/.test(s.id))continue;
        let activity=0;try{activity=fs.statSync(path.join(root,'..','events',s.id+'.jsonl')).mtimeMs;}catch{}
        const stamp=s.time_updated+':'+activity;
        const dest=path.join(root,s.id+'.json');if(seen.get(s.id)===stamp&&fs.existsSync(dest))continue;
        const tmp=dest+'.'+crypto.randomUUID()+'.tmp';
        try{
          await run(cmd,['session','export',s.id],tmp);
          const body=fs.readFileSync(tmp),o=JSON.parse(body.toString('utf8'));
          if(!o.info||o.info.id!==s.id||!Array.isArray(o.messages))throw Error('OpenCode 导出结构不正确');
          let same=false;try{same=hash(body)===hash(fs.readFileSync(dest));}catch{}
          if(!same)fs.renameSync(tmp,dest);seen.set(s.id,stamp);
        }catch(e){log('OpenCode 会话导出待重试：'+s.id+' '+e.message);}finally{try{fs.unlinkSync(tmp);}catch{}}
      }
    }catch(e){log('OpenCode 完整导出待重试：'+e.message);}finally{busy=false;}
  }
  return {tick};
}
module.exports={createOpenCodeExport};
