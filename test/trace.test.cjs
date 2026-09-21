const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTrace,trace}=require('../src/trace.cjs');
const {decide,actions}=require('../src/decisions.cjs');
const {availableActions}=require('../src/direct-actions.cjs');
const {decideFresh}=require('../src/fresh-decision.cjs');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const net=require('node:net');
function fixture(t,shared=false){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minecraft-trace-'));
 const logger=shared?trace.configure({directory}):createTrace({directory});
 t.after(()=>{if(shared)trace.configure();fs.rmSync(directory,{recursive:true,force:true});});
 return {logger,directory,read:()=>fs.readFileSync(logger.file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};
}
test('trace keeps concurrent runs separate and writes starts before unfinished work',async t=>{
 const {logger,read}=fixture(t);let release;
 const pending=logger.run({runId:'a'},()=>logger.span('tool',{choice:'wait'},()=>new Promise(r=>{release=r;})));
 await logger.run({runId:'b'},async()=>{await Promise.resolve();logger.event('task.pause');});
 assert.deepEqual(read().map(r=>[r.runId,r.event]),[['a','tool.start'],['b','task.pause']]);
 release('done');await pending;
 const rows=read();assert.equal(rows[2].runId,'a');assert.equal(rows[0].spanId,rows[2].spanId);
 assert.deepEqual(rows.map(r=>r.sequence),[1,2,3]);
});
test('trace redacts credentials recursively, including error messages and stacks',t=>{
 const {logger,read}=fixture(t);logger.addSecret('private-test-key');
 logger.event('error',{error:new Error('failed private-test-key'),headers:{Authorization:'secret'},nested:{api_key:'secret',message:'Bearer top-secret'},request:{model:'jev-latest'}});
 const row=read()[0],raw=JSON.stringify(row);
 assert.ok(!raw.includes('private-test-key'));assert.ok(!raw.includes('top-secret'));assert.ok(!raw.includes('"secret"'));
 assert.equal(row.error.name,'Error');assert.equal(row.request.model,'jev-latest');
});
test('failed and cancelled spans retain their original errors',async t=>{
 const {logger,read}=fixture(t),error=new Error('cancelled');error.name='AbortError';
 await assert.rejects(logger.span('tool',{},async()=>{throw error;}),e=>e===error);
 assert.equal(read()[1].event,'tool.error');assert.equal(read()[1].error.name,'AbortError');
});
test('API request is on disk before transport; invalid responses and network errors are traced',async t=>{
 const {read}=fixture(t,true);
 await assert.rejects(decide({},{key:'private-test-key',fetchImpl:async()=>{
   assert.equal(read().at(-1).event,'request.sent');throw new Error('network private-test-key');
 }}),/network/);
 assert.equal(read().at(-1).event,'request.error');
 await assert.rejects(decide({},{key:'private-test-key',fetchImpl:async()=>({ok:true,status:200,json:async()=>({invalid:true})})}),/invalid movement/);
 assert.ok(read().some(r=>r.event==='response.received'));assert.equal(read().at(-1).event,'request.error');
 assert.ok(!JSON.stringify(read()).includes('private-test-key'));
});
test('HTTP failures and malformed JSON are traced without recording auth headers',async t=>{
 const {read}=fixture(t,true);
 await assert.rejects(decide({},{key:'private-test-key',fetchImpl:async()=>({ok:false,status:401})}),/401/);
 assert.equal(read().at(-1).error.status,401);
 await assert.rejects(decide({},{key:'private-test-key',fetchImpl:async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('bad JSON');}})}),/bad JSON/);
 assert.equal(read().at(-1).error.name,'SyntaxError');
 assert.ok(!JSON.stringify(read()).includes('Authorization'));
});
test('direct action exclusions are logged without changing offered choices',t=>{
 const {read}=fixture(t,true);
 const result=availableActions({task:{stage:'gathering'},direct:{movementSafe:{forward:false},canMine:false,miningTargets:[],placementTargets:[],drops:[]}});
 assert.equal(result.forward,undefined);assert.equal(result.mine,undefined);assert.ok(result.wait);
 const report=read().at(-1);assert.equal(report.event,'candidates.filtered');
 assert.ok(report.entries.some(e=>e.target==='forward'&&!e.selected));
 assert.deepEqual(report.offered,Object.keys(result));
});
test('observation errors are traced even when inference never starts',async t=>{
 const {read}=fixture(t,true);let called=false;
 await assert.rejects(decideFresh({observe:()=>trace.span('observation',{},async()=>{throw new Error('No safe target');}),decide:()=>{called=true;},signal:new AbortController().signal}),/No safe target/);
 assert.equal(called,false);assert.equal(read().at(-1).event,'observation.error');
});
test('HTTP controls, malformed input, refused connection and graceful shutdown produce trace events',async t=>{
 const {directory}=fixture(t);
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const child=spawn(process.execPath,['-e',"require('./src/server.cjs');process.on('message',()=>process.emit('SIGTERM','SIGTERM'));"],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',TRACE_DIR:directory,TYPESAFE_API_KEY:'',MC_AUTOCONNECT:'0'},windowsHide:true,stdio:['pipe','pipe','pipe','ipc']});
 t.after(()=>child.kill());
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Test server exited');})]);
 const read=()=>fs.readdirSync(directory).filter(f=>f.startsWith('trace-')).flatMap(f=>fs.readFileSync(path.join(directory,f),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
 const post=(action,body)=>fetch(`http://127.0.0.1:${port}/api/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body});
 await post('key',JSON.stringify({key:'private-test-key'}));
 assert.equal((await post('key','{"key":"another-secret",')).status,400);
 await post('pause','{}');
 await post('start','{}');
 const unused=net.createServer();unused.listen(0,'127.0.0.1');await once(unused,'listening');const gamePort=unused.address().port;await new Promise(r=>unused.close(r));
 await post('connect',JSON.stringify({host:'127.0.0.1',port:gamePort}));
 let rows=read();assert.ok(rows.some(r=>r.event==='connection.start'));assert.ok(rows.some(r=>r.event==='task.pause'));
 assert.ok(rows.some(r=>r.event==='http.error'));assert.ok(rows.some(r=>r.event==='control.result'&&r.httpStatus===409));
 assert.ok(!JSON.stringify(rows).includes('private-test-key'));assert.ok(!JSON.stringify(rows).includes('another-secret'));
 const deadline=Date.now()+3000;
 while(!read().some(r=>r.event==='connection.error')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.ok(read().some(r=>r.event==='connection.error'));
 const exited=once(child,'exit');child.send('shutdown');await exited;
 rows=read();assert.ok(rows.some(r=>r.event==='process.shutdown'));assert.ok(rows.some(r=>r.event==='process.exit'));
});
test('fatal errors are logged and still terminate the process',async t=>{
 const {directory}=fixture(t);
 const child=spawn(process.execPath,['-e',`const {trace}=require('./src/trace.cjs');trace.configure({directory:process.env.TRACE_DIR});process.on('uncaughtExceptionMonitor',(error,origin)=>trace.event('process.fatal',{error,origin}));Promise.reject(new Error('synthetic fatal'));`],{cwd:path.resolve(__dirname,'..'),env:{...process.env,TRACE_DIR:directory},windowsHide:true,stdio:'ignore'});
 const [code]=await once(child,'exit');assert.notEqual(code,0);
 const files=fs.readdirSync(directory);const rows=files.flatMap(f=>fs.readFileSync(path.join(directory,f),'utf8').trim().split('\n').map(JSON.parse));
 assert.ok(rows.some(r=>r.event==='process.fatal'&&r.origin==='unhandledRejection'));
});
