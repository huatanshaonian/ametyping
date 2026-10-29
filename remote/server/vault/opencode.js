// Portable handoff view. Native bytes remain authoritative; unknown records become labelled historical notes.
// No tool call from a foreign runtime is turned into a pending executable operation.
'use strict';
const crypto=require('crypto');
const {StringDecoder}=require('string_decoder');
function* lines(chunks){
  const decoder=new StringDecoder('utf8');let rest='';
  for(const b of chunks){rest+=decoder.write(b);let start=0,n;while((n=rest.indexOf('\n',start))>=0){yield rest.slice(start,n);start=n+1;}rest=rest.slice(start);}
  rest+=decoder.end();if(rest)yield rest;
}
function* convert(source,chunks,directory){
  if(source.provider==='opencode')throw Error('OpenCode 原生导出请直接下载 JSON 后导入；事件日志不能当作完整会话导入');
  const now=Date.now(),sid='ses_'+crypto.randomBytes(16).toString('hex');
  const info={id:sid,projectID:'global',title:'接续 '+source.provider+' '+source.session,location:{directory},
    time:{created:source.created,updated:now},cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}},
    metadata:{ametyping:{machine:source.machine,session:source.session,key:source.key,generation:source.generation,digest:source.digest,
      conversion:'history-handoff-v1',limitations:['Foreign tool records are historical text, not executable calls.','Workspace files and external attachments must be restored separately.','Native provider runtime state is not transferred.']}}};
  yield Buffer.from('{"info":'+JSON.stringify(info)+',"messages":[');
  let count=0,model={providerID:source.provider==='codex'?'openai':'anthropic',id:'unknown'};
  const message=(type,text,at)=>{
    const base={id:'msg_'+crypto.randomBytes(16).toString('hex'),type,time:{created:at}};
    if(type==='assistant')return {...base,agent:'build',model,content:[{type:'text',text}],time:{created:at,completed:at}};
    return {...base,text,...(type==='synthetic'?{description:'原工具历史记录'}:{})};
  };
  for(const line of lines(chunks)){
    if(!line.trim())continue;
    let o;try{o=JSON.parse(line);}catch{ o=null; }
    let type='synthetic',text=line,at=Date.parse(o&&o.timestamp)||source.created;
    if(source.provider==='claude'&&o&&o.message){
      if(o.message.model)model={providerID:'anthropic',id:o.message.model};
      const c=o.message.content;
      if(typeof c==='string'&&['user','assistant'].includes(o.message.role)){type=o.message.role;text=c;}
      else if(Array.isArray(c)&&c.every(x=>x.type==='text')){type=['user','assistant'].includes(o.message.role)?o.message.role:'synthetic';text=c.map(x=>x.text).join('\n');}
      else text='原 Claude 记录（含工具调用、结果或附件描述；仅作为历史）：\n'+line;
    }else if(source.provider==='codex'&&o){
      const p=o.payload||{};
      if(o.type==='turn_context'&&p.model)model={providerID:'openai',id:p.model};
      if(o.type==='response_item'&&p.type==='message'&&['user','assistant'].includes(p.role)&&Array.isArray(p.content)&&p.content.every(x=>['input_text','output_text'].includes(x.type))){type=p.role;text=p.content.map(x=>x.text).join('\n');}
      else text='原 Codex 记录（仅作为历史）：\n'+line;
    }
    if(count++)yield Buffer.from(',');yield Buffer.from(JSON.stringify(message(type,text,at)));
  }
  yield Buffer.from(']}');
}
module.exports={convert,lines};
