const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {AsyncLocalStorage} = require('node:async_hooks');

function createTrace({directory,context=()=>({}),secrets=[]}={}) {
  const storage=new AsyncLocalStorage(), sessionId=randomUUID(), hidden=new Set(secrets.filter(Boolean));
  const createdAt=new Date().toISOString(),fileStem=`${Date.now()}-${sessionId}`;
  let sequence=0;
  if(directory)fs.mkdirSync(directory,{recursive:true});
  const file=directory?path.join(directory,`trace-${fileStem}.jsonl`):null;
  function redact(value,seen=new WeakSet()) {
    if(typeof value==='string') {
      for(const secret of hidden)value=value.split(secret).join('[REDACTED]');
      return value.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [REDACTED]');
    }
    if(!value||typeof value!=='object')return value;
    if(seen.has(value))return '[Circular]';
    seen.add(value);
    const original=value;
    if(value instanceof Error)value={name:value.name,message:value.message,stack:value.stack,code:value.code,status:value.status,cause:value.cause};
    const result=Array.isArray(value)?value.map(v=>redact(v,seen)):Object.fromEntries(Object.entries(value).map(([k,v])=>
      [k,
        /^(authorization|headers|key|api[_-]?key|typesafe_api_key|password|secret|access_token|refresh_token|cookie|set-cookie)$/i.test(k)?'[REDACTED]':redact(v,seen)]));
    seen.delete(original);return result;
  }
  const api={
    file,sessionId,fileStem,createdAt,enabled:!!file,
    context:()=>({...context(),...storage.getStore()}),
    sanitize:value=>redact(value),
    addSecret(secret){if(secret)hidden.add(secret);},
    run(fields,work){return storage.run({...storage.getStore(),...fields},work);},
    event(event,data={}) {
      if(!file)return;
      const record=redact({...context(),...storage.getStore(),...data,schemaVersion:2,sessionId,eventId:randomUUID(),sequence:++sequence,timestamp:new Date().toISOString(),event});
      // Flush each complete event before the corresponding external operation begins.
      fs.appendFileSync(file,JSON.stringify(record)+'\n',{flush:true});
      return record;
    },
    async span(event,data,work) {
      const spanId=randomUUID(),started=performance.now();
      return api.run({spanId,parentSpanId:storage.getStore()?.spanId||null},async()=>{
        api.event(event+'.start',data);
        try{const result=await work();api.event(event+'.end',{elapsedMs:Math.round(performance.now()-started),result});return result;}
        catch(error){api.event(event+'.error',{elapsedMs:Math.round(performance.now()-started),error});throw error;}
      });
    }
  };
  return api;
}
let active=createTrace();
const trace={
  configure(options){active=createTrace(options);return active;},
  get enabled(){return active.enabled;},
  get sessionId(){return active.sessionId;},get file(){return active.file;},get fileStem(){return active.fileStem;},get createdAt(){return active.createdAt;},
  context:()=>active.context(),
  event:(...args)=>active.event(...args),run:(...args)=>active.run(...args),span:(...args)=>active.span(...args),addSecret:(...args)=>active.addSecret(...args),sanitize:(...args)=>active.sanitize(...args)
};
function audit(stage){
  const entries=[];
  return {
    keep(target,reason='selected'){if(trace.enabled)entries.push({target,selected:true,reason});return true;},
    reject(target,reason){if(trace.enabled)entries.push({target,selected:false,reason});return false;},
    finish(extra={}){trace.event('candidates.filtered',{stage,entries,...extra});}
  };
}
module.exports={trace,createTrace,audit};
