// The NAS participates too, without a second service or inbound port. Uses the same protocol as remote agents.
'use strict';
const fs=require('fs');
const {createNativeArchive}=require('../../agent/native-archive');
const {createMemorySync}=require('../../agent/memory-sync');
function attachLocal({service,machine,control=true,archive=true,memory=true,confirmedDir='',home,log=console.error}){
  const ws={readyState:1,vaultAllowed:archive,memoryAllowed:control&&memory,memoryCapture:memory};
  const send=d=>service.message(machine.name,d,ws);
  const collector=createNativeArchive({send,home,enabled:archive,log});
  const sync=createMemorySync({name:machine.name,send,home,confirmedDir,enabled:memory,canWrite:()=>control&&memory,
    folder:async p=>{const dir=fs.realpathSync(p);if(!fs.statSync(dir).isDirectory())throw Error('项目路径不是目录');return dir;}});
  ws.send=raw=>{const d=JSON.parse(raw);if(d.t==='vault-result')collector.handle(d);else if(d.t==='memory-bundle')sync.handle(d).catch(e=>log(e.message));};
  machine.online=true;machine.sockets=machine.sockets||new Set();machine.sockets.add(ws);
  collector.ready();sync.handle({t:'memory-bundle',...service.memory.bundle(machine.name)}).catch(e=>log(e.message));
  const timer=setInterval(()=>{collector.tick();sync.tick().catch(e=>log(e.message));},500);timer.unref();
  return {stop(){clearInterval(timer);collector.reset();machine.sockets.delete(ws);}};
}
module.exports={attachLocal};
