const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {trace}=require('../src/trace.cjs');
const {createArchive}=require('../src/archive.cjs');
const {decideFresh}=require('../src/fresh-decision.cjs');
const {decide,actions}=require('../src/decisions.cjs');
const {readArchive}=require('../scripts/read-archive.cjs');
const origin={x:0,y:64,z:0};
const raw={model:'synthetic-test',answers:{movement:{type:'choice',choice:'wait',confidence:1,probabilities:Object.fromEntries(Object.keys(actions).map(k=>[k,k==='wait'?1:0]))}},usage:{input_tokens:0,output_tokens:0}};
const ok=async()=>({ok:true,status:200,json:async()=>raw});
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'linked-archive-'));
 trace.configure({directory:path.join(directory,'trace')});
 const archive=createArchive({directory:path.join(directory,'summary'),metadata:{test:true}});
 t.after(()=>{trace.configure();fs.rmSync(directory,{recursive:true,force:true});});
 const read=file=>fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 return {archive,directory,decisions:()=>read(archive.decisionFile),events:()=>read(trace.file)};
}
async function run(archive,{fetchImpl=ok,observe=()=>({position:origin}),position=()=>origin,signal=new AbortController().signal,wait=async()=>{},tool=async()=> 'waited',runId='run-one'}={}){
 return trace.run({runId,connectionId:'connection-one'},()=>archive.round(async round=>{
  const fresh=await decideFresh({signal,observe:()=>trace.span('observation',{},observe),position,wait,
   onCorrelation:ids=>round.correlate(ids),
   decide:(state,ids)=>decide(state,{key:'test-secret',requestId:ids.requestId,signal,fetchImpl}),
   onDiscard:record=>round.record({...record,recordType:'decision',status:'discarded'},'decision.discarded'),
   onServiceError:record=>round.record({...record,recordType:'api-error',status:record.retry?'retrying':'failed'},'request.retry')
  });
  round.correlate({...fresh.correlation,toolId:randomUUID()});
  const outcome=await trace.run(round.ids,()=>trace.span('tool',{choice:fresh.result.answer.choice},tool));
  return round.finish({id:1,recordType:'decision',status:'completed',...fresh.result,state:fresh.state,outcome});
 },{isCancelled:()=>signal.aborted}));
}
test('manifest pairs trace and summaries across directories with shared session IDs',async t=>{
 const {archive,events,decisions}=fixture(t);const record=await run(archive);
 const manifest=JSON.parse(fs.readFileSync(archive.manifestFile));
 assert.equal(manifest.sessionId,record.sessionId);assert.equal(manifest.files.trace,'../trace/'+path.basename(trace.file));
 assert.ok(path.basename(archive.decisionFile).includes(record.sessionId));
 assert.ok(events().every(row=>row.sessionId===record.sessionId));assert.equal(decisions()[0].recordId,record.recordId);
 archive.close(0);const closed=JSON.parse(fs.readFileSync(archive.manifestFile));assert.equal(closed.status,'closed');assert.equal(closed.decisionRecords,1);
});
test('summary links directly to its full request, observation, tool and terminal trace event',async t=>{
 const {archive,events}=fixture(t);const record=await run(archive);
 const rows=events(),request=rows.find(r=>r.event==='request.sent'),response=rows.find(r=>r.event==='response.received'),observation=rows.find(r=>r.event==='observation.start'),tool=rows.find(r=>r.event==='tool.start');
 for(const row of [request,response,observation,tool])assert.equal(row.decisionId,record.decisionId);
 assert.equal(request.requestId,record.requestId);assert.equal(response.requestId,record.requestId);assert.equal(request.observationId,record.observationId);
 assert.equal(observation.observationId,record.observationId);assert.equal(tool.toolId,record.toolId);
 assert.deepEqual(request.request,record.request);
 const terminal=rows.find(r=>r.eventId===record.traceEventId);assert.equal(terminal.recordId,record.recordId);assert.equal(terminal.sequence,record.traceSequence);assert.equal(terminal.record.recordId,record.recordId);
 const linked=await readArchive(archive.manifestFile,record.recordId);assert.ok(linked.events.some(e=>e.event==='request.sent'));assert.equal(linked.decisions.length,1);
});
test('HTTP retry keeps round ID but allocates separate request and observation IDs',async t=>{
 const {archive,events,decisions}=fixture(t);let calls=0;
 const result=await run(archive,{fetchImpl:async()=>++calls===1?{ok:false,status:503}:ok()});
 const summaries=decisions();assert.equal(summaries.length,2);assert.equal(summaries[0].recordType,'api-error');assert.equal(summaries[0].decisionId,result.decisionId);
 assert.notEqual(summaries[0].requestId,result.requestId);assert.notEqual(summaries[0].observationId,result.observationId);
 assert.equal(result.attempt,2);assert.equal(events().filter(e=>e.event==='decision.finished').length,1);
 const linked=await readArchive(archive.manifestFile,summaries[0].requestId);assert.equal(linked.decisions.length,2);
});
test('stale responses remain linked to their own request and the eventual accepted round',async t=>{
 const {archive,events,decisions}=fixture(t);let calls=0;
 const record=await run(archive,{fetchImpl:async()=>{calls++;return ok();},position:()=>calls===1?{...origin,y:65}:origin});
 const summaries=decisions();assert.equal(summaries[0].status,'discarded');assert.equal(summaries[0].decisionId,record.decisionId);
 assert.notEqual(summaries[0].requestId,record.requestId);assert.equal(events().filter(e=>e.event==='decision.finished').length,1);
});
test('failure before inference has a linked observation and no fabricated request',async t=>{
 const {archive,events,decisions}=fixture(t);
 await assert.rejects(run(archive,{observe:()=>{throw new Error('No candidates');}}),/No candidates/);
 const record=decisions()[0];assert.equal(record.status,'failed');assert.equal(record.requestId,null);assert.ok(record.observationId);
 assert.equal(events().some(e=>e.event==='request.sent'),false);assert.equal(events().filter(e=>e.event==='decision.finished').length,1);
});
test('non-retryable API and validation errors retain request joins without a model decision',async t=>{
 const {archive,events,decisions}=fixture(t);
 for(const fetchImpl of [async()=>({ok:false,status:401}),async()=>({ok:true,status:200,json:async()=>({bad:true})})])await assert.rejects(run(archive,{fetchImpl}));
 for(const record of decisions()){
  assert.equal(record.recordType,'round');assert.equal(record.status,'failed');assert.ok(record.requestId);assert.equal(record.answer,undefined);
  assert.ok(events().some(e=>e.event==='request.error'&&e.requestId===record.requestId));
 }
});
test('cancellation during inference and tools each writes one correlated terminal record',async t=>{
 const {archive,events,decisions}=fixture(t);
 const inferenceController=new AbortController();
 await assert.rejects(run(archive,{signal:inferenceController.signal,fetchImpl:async()=>{inferenceController.abort();inferenceController.signal.throwIfAborted();}}));
 const toolController=new AbortController();
 await assert.rejects(run(archive,{signal:toolController.signal,tool:async()=>{toolController.abort();toolController.signal.throwIfAborted();}}));
 const records=decisions();assert.equal(records.length,2);assert.ok(records.every(r=>r.status==='cancelled'&&r.requestId));assert.equal(records[0].toolId,null);assert.ok(records[1].toolId);
 assert.equal(events().filter(e=>e.event==='decision.finished').length,2);
});
test('reused display IDs and multiple task runs never share decision identities',async t=>{
 const {archive}=fixture(t);
 const a=await run(archive),resume=await run(archive),fresh=await run(archive,{runId:'run-two'});
 assert.equal(a.id,resume.id);assert.equal(a.runId,resume.runId);assert.notEqual(a.decisionId,resume.decisionId);assert.notEqual(a.recordId,resume.recordId);assert.notEqual(a.runId,fresh.runId);
});
test('in-flight starts are queryable before a decision summary exists',async t=>{
 const {archive}=fixture(t);let release,requestId;
 const pending=run(archive,{fetchImpl:()=>{requestId=trace.context().requestId;return new Promise(r=>{release=()=>r({ok:true,status:200,json:async()=>raw});});}});
 while(!release)await new Promise(r=>setImmediate(r));
 const linked=await readArchive(archive.manifestFile,requestId);assert.equal(linked.decisions.length,0);assert.ok(linked.events.some(e=>e.event==='request.sent'));
 release();await pending;
});
test('archive summaries use the same redaction as trace and legacy input is rejected',async t=>{
 const {archive,directory,decisions}=fixture(t);trace.addSecret('test-secret');
 trace.run({runId:'run'},()=>archive.write({outcome:'test-secret',password:'anything',error:new Error('test-secret')}));
 assert.ok(!JSON.stringify(decisions()).includes('test-secret'));assert.equal(decisions()[0].password,'[REDACTED]');
 const legacy=path.join(directory,'legacy.json');fs.writeFileSync(legacy,'{}');await assert.rejects(readArchive(legacy,'1'),/schemaVersion 2/);
});
