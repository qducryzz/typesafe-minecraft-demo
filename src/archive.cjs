const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {trace}=require('./trace.cjs');
const CORRELATION_FIELDS=['runId','connectionId','decisionId','observationId','requestId','toolId','attempt'];

// Trace is written first, retaining the complete summary if the second write is
// interrupted. recordId and traceEventId provide exact joins, never timestamps.
function createArchive({directory,logger=trace,metadata={}}){
  if(!logger.file)throw new Error('Configure trace before opening an archive');
  fs.mkdirSync(directory,{recursive:true});
  const sessionId=logger.sessionId;
  const decisionFile=path.join(directory,`decisions-${logger.fileStem}.jsonl`);
  const manifestFile=path.join(directory,`archive-${logger.fileStem}.json`);
  const relative=file=>path.relative(directory,file).split(path.sep).join('/');
  const files={trace:relative(logger.file),decisions:relative(decisionFile),manifest:relative(manifestFile)};
  const manifest=logger.sanitize({schemaVersion:2,sessionId,createdAt:logger.createdAt,status:'open',files,metadata});
  const save=()=>{
    const temporary=manifestFile+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n',{flush:true});
    fs.renameSync(temporary,manifestFile);
  };
  fs.writeFileSync(decisionFile,'',{flag:'wx'});
  save();logger.event('archive.opened',{files});
  let sequence=0;
  function write(record,event='decision.recorded'){
    const context=logger.context();
    const summary=logger.sanitize({...Object.fromEntries(CORRELATION_FIELDS.map(key=>[key,context[key]??null])),...record,
      schemaVersion:2,sessionId,recordId:randomUUID(),decisionSequence:++sequence,timestamp:record.timestamp||new Date().toISOString()});
    const entry=logger.event(event,{...Object.fromEntries(CORRELATION_FIELDS.map(key=>[key,summary[key]])),recordId:summary.recordId,decisionSequence:summary.decisionSequence,record:summary});
    const linked={...summary,traceEventId:entry.eventId,traceSequence:entry.sequence};
    fs.appendFileSync(decisionFile,JSON.stringify(linked)+'\n',{flush:true});
    return linked;
  }
  async function round(work,{isCancelled=()=>false}={}){
    const ids={decisionId:randomUUID(),observationId:null,requestId:null,toolId:null,attempt:null};
    return logger.run(ids,async()=>{
      logger.event('decision.started');
      let terminal=null;
      const round={
        ids,
        correlate(fields){Object.assign(ids,fields);},
        record(record,event){return write({...ids,...record},event);},
        finish(record){
          if(terminal)throw new Error('A decision round can only finish once');
          terminal=write({...ids,...record,terminal:true},'decision.finished');return terminal;
        }
      };
      try{
        const result=await work(round);
        if(!terminal)round.finish({recordType:'round',status:isCancelled()?'cancelled':'stopped',outcome:'No action executed'});
        return result;
      }catch(error){
        if(!terminal)round.finish({recordType:'round',status:isCancelled()?'cancelled':'failed',error,outcome:error.message});
        throw error;
      }
    });
  }
  return {sessionId,files,manifestFile,decisionFile,write,round,
    close(code){manifest.status='closed';manifest.closedAt=new Date().toISOString();manifest.exitCode=code;manifest.decisionRecords=sequence;save();}
  };
}
module.exports={createArchive};
