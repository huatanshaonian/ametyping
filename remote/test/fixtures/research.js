'use strict';
const cases = [
  { name:'same-code-two-goals', rows:[
    {type:'user',message:{content:'两台电脑都是 main 提交 abc123，没有改代码。Windows 扫频探索频率适用范围，dell97 做网格收敛验证；这是两项独立研究工作。'}},
    {type:'assistant',message:{content:[{type:'text',text:'Windows 扫频已经完成，结果在 results/sweep.csv。dell97 的网格收敛还在运行，尚无结论。'}]}},
  ], expected:{minWork:2,forbidAllComplete:true} },
  { name:'planned-only',rows:[
    {type:'user',message:{content:'计划明天用 main 的现有程序验证网格收敛。今天还没有启动计算，没有结果，不要记成已验证。'}},
    {type:'assistant',message:{content:[{type:'text',text:'已记录计划，等明天运行后再分析。'}]}},
  ],expected:{plannedOnly:true} },
  { name:'failure-and-rerun',rows:[
    {type:'user',message:{content:'验证同一 main 提交 abc123 的球面算例。初次运行内存不足，缩小 batch 后重跑。'}},
    {type:'assistant',message:{content:[{type:'tool_use',id:'call1',name:'exec_command',input:{cmd:'python verify.py --batch 64'}}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'call1',is_error:true,content:'CUDA out of memory; exit code 1'}]}},
    {type:'assistant',message:{content:[{type:'tool_use',id:'call2',name:'exec_command',input:{cmd:'python verify.py --batch 8'}}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'call2',content:'completed; max_relative_error=0.0031; output=results/sphere.csv; exit code 0'}]}},
    {type:'assistant',message:{content:[{type:'text',text:'缩小 batch 的重跑已完成，最大相对误差 0.0031。这里只验证了本次球面算例，不能推广到所有几何。'}]}},
  ],expected:{failureAndRerun:true,metric:'0.0031'} },
  { name:'hypothesis-not-measurement',rows:[
    {type:'user',message:{content:'探索 RCS 缺口是否由非局域行波引起。'}},
    {type:'assistant',message:{content:[{type:'text',text:'非局域行波只是候选解释，目前缺少极化检验，尚未证实；需要后续计算。'}]}},
  ],expected:{hypothesis:true} },
];
function assess(name,result) {
  const x=cases.find(c=>c.name===name);if(!x)return[];const e=x.expected,w=result.work_items,issues=[];
  if(e.minWork&&w.length<e.minWork)issues.push('不同计算目标被合并或遗漏');
  if(e.forbidAllComplete&&w.length&&w.every(x=>x.state==='reported_complete'))issues.push('运行中工作被当作完成');
  if(e.plannedOnly&&(!w.length||w.some(x=>x.state!=='planned'||x.runs.some(r=>r.state!=='planned')||x.findings.some(f=>f.basis==='measurement'))))issues.push('计划被误标为执行或测量');
  if(e.failureAndRerun){const runs=w.flatMap(x=>x.runs);if(!runs.some(r=>r.state==='reported_failed')||!runs.some(r=>r.state==='reported_complete'))issues.push('失败与重跑未分别保留');}
  if(e.metric&&!w.flatMap(x=>x.runs).flatMap(r=>r.metrics).some(m=>m.value_text===e.metric))issues.push('有效运行指标遗漏');
  if(e.hypothesis&&!w.flatMap(x=>x.findings).some(f=>f.basis==='hypothesis'))issues.push('候选解释未保留为假设');
  return issues;
}
module.exports={cases,assess};
