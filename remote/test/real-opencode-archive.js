// Actual installed OpenCode, isolated XDG paths and standalone servers. No model requests.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),assert=require('assert/strict');
const {convert}=require('../server/vault/opencode');
const {createOpenCodeExport}=require('../agent/opencode-export');
const {command}=require('../../app/opencode');
const cmd=command();if(!cmd)throw Error('OpenCode is required for this explicit integration check');
const T=fs.mkdtempSync(path.join(os.tmpdir(),'ame-real-oc-archive-')),home=path.join(T,'home'),project=path.join(T,'project');
fs.mkdirSync(home);fs.mkdirSync(project);
const vars={HOME:home,USERPROFILE:home,XDG_DATA_HOME:path.join(T,'data'),XDG_CONFIG_HOME:path.join(T,'config'),XDG_CACHE_HOME:path.join(T,'cache'),XDG_STATE_HOME:path.join(T,'state'),OPENCODE_AME_HOME:path.join(T,'mirror')};
Object.assign(process.env,vars);
const run=args=>cp.execFileSync(cmd.exe,[...cmd.args,'--standalone',...args],{env:process.env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
(async()=>{
  try{
    for(const provider of ['claude','codex']){
      const source={provider,created:Date.now(),machine:'fixture',session:'fixture-'+provider,key:'a'.repeat(64),generation:'fixture',digest:'b'.repeat(64)};
      const lines=provider==='claude'?[{type:'user',message:{role:'user',content:'你好 🌈'}},{type:'assistant',message:{role:'assistant',model:'fixture-model',content:[{type:'text',text:'历史回复'}]}},{type:'user',message:{role:'user',content:[{type:'tool_result',content:'full historical tool output'}]}}]
        :[{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'你好 🌈'}]}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'历史回复'}]}},{type:'response_item',payload:{type:'function_call_output',output:'full historical tool output'}}];
      const exportData=Buffer.concat([...convert(source,[Buffer.from(lines.map(x=>JSON.stringify(x)).join('\n'))],project)]),file=path.join(T,provider+'.json');fs.writeFileSync(file,exportData);
      const expected=JSON.parse(exportData);
      run(['session','import',file,'--directory',project]);
      const actual=JSON.parse(run(['session','export',expected.info.id]));
      assert.equal(actual.messages.length,3);assert.ok(JSON.stringify(actual).includes('full historical tool output'));assert.ok(JSON.stringify(actual).includes('你好 🌈'));
      console.log('PASS '+provider+' history imports into real OpenCode and exports without losing text/tool evidence');
    }
    const errors=[];
    await createOpenCodeExport({home,resolveCommand:()=>({...cmd,args:[...cmd.args,'--standalone']}),log:e=>errors.push(e)}).tick();
    assert.deepEqual(errors,[]);
    const files=fs.readdirSync(path.join(vars.OPENCODE_AME_HOME,'archive')).filter(x=>x.endsWith('.json'));
    assert.equal(files.length,2);console.log('PASS real local SQLite discovery and official export produce complete native archives');
    console.log('3 passed, 0 failed');
  }finally{fs.rmSync(T,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
