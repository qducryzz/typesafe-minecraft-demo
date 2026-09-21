const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Vec3}=require('vec3');
const {reachable,candidates,requireCandidates,executeTask,createTask}=require('../src/task.cjs');
const {decideFresh}=require('../src/fresh-decision.cjs');
const {trace}=require('../src/trace.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');

test('route search resumes partial results and yields to cancellation',async()=>{
  let closed=false;
  const bot={entity:{position:new Vec3(0,64,0)},pathfinder:{movements:{},getPathFromTo:function*(){
    try{yield {result:{status:'partial'}};yield {result:{status:'success'}};}finally{closed=true;}
  }}};
  assert.equal(await reachable(bot,{}),true);assert.equal(closed,true);
  const controller=new AbortController();closed=false;
  const pending=reachable(bot,{}, {signal:controller.signal});controller.abort();
  await assert.rejects(pending);assert.equal(closed,true);
});
test('route search does not treat timeout or noPath as reachable',async()=>{
  for(const status of ['timeout','noPath']) {
    const bot={entity:{position:new Vec3(0,64,0)},pathfinder:{movements:{},getPathFromTo:function*(){yield {result:{status}};}}};
    assert.equal(await reachable(bot,{}),false);
    assert.equal(await reachable(bot,{}, {deadline:0}),false);
  }
});
function fixture() {
  const leaf=new Vec3(2,63,0),hazard=new Vec3(3,63,0),log=new Vec3(4,64,0);
  const blocks=new Map([
    [leaf.toString(),{name:'birch_leaves',boundingBox:'block',type:1}],
    [hazard.toString(),{name:'magma_block',boundingBox:'block',type:2}],
    [log.toString(),{name:'oak_log',boundingBox:'block',type:3}]
  ]);
  const bot={entity:{position:new Vec3(0,64,0)},entities:{},inventory:{items:()=>[]},world:{},
    blockAt:p=>blocks.get(p.toString())||{name:'air',boundingBox:'empty',type:0},
    findBlocks:({matching})=>[leaf,hazard,log].filter(p=>matching(blocks.get(p.toString()))),
    pathfinder:{movements:{blocksToAvoid:new Set([2])},getPathFromTo:function*(){yield {result:{status:'partial'}};yield {result:{status:'success'}};}}
  };
  return {bot,task:createTask(bot),leaf};
}
test('Lumber preserves reachable logs and offers a nearby canopy foothold',async()=>{
  const {bot,task,leaf}=fixture();const seen=await candidates(bot,task);
  assert.equal(seen.logs[0].name,'oak_log');
  assert.deepEqual(seen.exploreDestination,{x:leaf.x,y:leaf.y+1,z:leaf.z});
});
test('exploration rejects obstructed and hazardous footholds',async()=>{
  const {bot,task}=fixture(),original=bot.blockAt;
  bot.blockAt=p=>p.y===65?{name:'stone',boundingBox:'block',type:4}:original(p);
  const seen=await candidates(bot,task);assert.equal(seen.exploreDestination,null);
});
test('no candidates stops before inference, but returning home remains allowed',async()=>{
  const empty={logs:[],droppedLog:null,exploreDestination:null};let called=false;
  await assert.rejects(decideFresh({observe:async()=>{requireCandidates(empty,{collected:0,target:10});},decide:()=>{called=true;},signal:new AbortController().signal}),/No safe Lumber target/);
  assert.equal(called,false);assert.doesNotThrow(()=>requireCandidates(empty,{collected:10,target:10}));
});
test('cancellation during asynchronous observation prevents inference',async()=>{
  const controller=new AbortController();let called=false;
  await assert.rejects(decideFresh({observe:async()=>{controller.abort();return {};},decide:()=>{called=true;},signal:controller.signal}));
  assert.equal(called,false);
});
test('pickup revalidates a vanished drop without walking',async()=>{
  const {bot,task}=fixture();let walked=false;
  bot.pathfinder.goto=async()=>{walked=true;};bot.pathfinder.setGoal=()=>{};bot.stopDigging=()=>{};bot.clearControlStates=()=>{};
  assert.match(await executeTask(bot,task,'pickup',{droppedLog:{id:9,position:{x:1,y:64,z:0}}},new AbortController().signal),/disappeared/);
  assert.equal(walked,false);
});
test('pickup reports actual inventory gain and follows the current drop position',async()=>{
  const {bot,task}=fixture();let count=0;
  bot.inventory.items=()=>count?[{name:'oak_log',count}]:[];
  bot.entities[9]={position:new Vec3(2.5,64,0.5),getDroppedItem:()=>({name:'oak_log'})};
  bot.pathfinder.goto=async goal=>{assert.equal(goal.x,2);count=1;};
  bot.pathfinder.setGoal=()=>{};bot.stopDigging=()=>{};bot.clearControlStates=()=>{};
  assert.match(await executeTask(bot,task,'pickup',{droppedLog:{id:9,position:{x:1,y:64,z:0}}},new AbortController().signal),/collected dropped logs/);
});
test('route diagnostics record partial slices and specific rejected footholds',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lumber-trace-'));
 const logger=trace.configure({directory});
 t.after(()=>{trace.configure();fs.rmSync(directory,{recursive:true,force:true});});
 const {bot,task}=fixture(),original=bot.blockAt;
 bot.blockAt=p=>p.y===65?{name:'stone',boundingBox:'block',type:4}:original(p);
 await trace.run({runId:'synthetic-test',observationId:'observation-test'},()=>candidates(bot,task));
 const rows=fs.readFileSync(logger.file,'utf8').trim().split('\n').map(JSON.parse);
 const result=rows.find(r=>r.event==='path.search.end');
 assert.equal(result.outcome,'success');assert.deepEqual(result.slices.map(s=>s.status),['partial','success']);
 assert.equal(result.runId,'synthetic-test');
 assert.ok(rows.find(r=>r.event==='candidates.filtered').entries.some(e=>e.reason==='head-blocked-or-unloaded'));
});
