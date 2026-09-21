const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');
const { point } = require('./observe.cjs');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const {trace,audit}=require('./trace.cjs');
const LOG = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/;
const OBJECTIVE = 'Find trees, collect 10 new logs, then return to the starting position.';
const logCount = bot => bot.inventory.items().filter(i => LOG.test(i.name)).reduce((n,i)=>n+i.count,0);
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createTask(bot, now = Date.now()) {
  return { home:point(bot.entity.position), target:10, baseline:logCount(bot), startedAt:now, lastProgressAt:now, bestCollected:0, bestHomeDistance:Infinity, visited:[], failed:{}, harvested:0 };
}
function progress(bot, task, now = Date.now()) {
  now = task.finishedAt ?? now;
  const collected = Math.max(0,logCount(bot)-task.baseline);
  const homeDistance = distance(bot.entity.position,task.home);
  if(collected>task.bestCollected || (collected>=task.target && homeDistance<task.bestHomeDistance-.5)) {
    task.lastProgressAt=now; task.bestCollected=Math.max(task.bestCollected,collected); task.bestHomeDistance=homeDistance;
  }
  const complete=collected>=task.target&&homeDistance<=2;
  return {home:task.home,target:task.target,collected,homeDistance:+homeDistance.toFixed(1),stage:complete?'complete':collected>=task.target?'returning':'gathering',complete,finished:task.finishedAt!=null,elapsedSeconds:Math.floor((now-task.startedAt)/1000),remainingSeconds:Math.max(0,Math.ceil((300000-now+task.startedAt)/1000))};
}
function stopReason(p, task, now = Date.now()) {
  if(p.complete)return 'Complete: collected 10 new logs and returned home';
  if(now-task.startedAt>=300000)return 'Stopped: five-minute limit reached';
  if(now-task.lastProgressAt>=90000)return 'Stopped: no inventory or return progress for 90 seconds';
  return null;
}
function configure(bot) {
  const moves = new Movements(bot);
  moves.canDig=true; moves.allow1by1towers=false; moves.allowParkour=false; moves.allowSprinting=false; moves.maxDropDown=2; moves.infiniteLiquidDropdownDistance=false; moves.scafoldingBlocks=[];
  // Navigation may clear foliage; only the selected harvest action can break logs.
  for(const block of bot.registry.blocksArray)if(!block.name.endsWith('_leaves'))moves.blocksCantBreak.add(block.id);
  for(const name of ['water','lava','fire','cactus','magma_block','powder_snow','campfire','sweet_berry_bush']) if(bot.registry.blocksByName[name]) moves.blocksToAvoid.add(bot.registry.blocksByName[name].id);
  bot.pathfinder.setMovements(moves); bot.pathfinder.thinkTimeout=1500; bot.pathfinder.searchRadius=32;
}
const v = p => new Vec3(p.x,p.y,p.z);
const harvestGoal = (bot,p) => new goals.GoalLookAtBlock(v(p),bot.world,{reach:4.0});
async function reachable(bot, goal, {signal, deadline=performance.now()+350}={}) {
  const searchId=require('node:crypto').randomUUID(),slices=[];
  const target=goal.pos?point(goal.pos):{x:goal.x,y:goal.y,z:goal.z};
  trace.event('path.search.start',{searchId,goal:goal.constructor.name,target,remainingBudgetMs:Math.max(0,deadline-performance.now())});
  let outcome='cancelled';
  try {
  signal?.throwIfAborted();
  if(performance.now()>=deadline){outcome='budget-exhausted';return false;}
  const search=bot.pathfinder.getPathFromTo(bot.pathfinder.movements,bot.entity.position,goal,
    {timeout:Math.min(350,deadline-performance.now()),tickTimeout:15});
  try {
    for(const {result} of search) {
      slices.push({status:result.status,time:result.time,cost:result.cost,visitedNodes:result.visitedNodes,generatedNodes:result.generatedNodes,pathLength:result.path?.length});
      signal?.throwIfAborted();
      if(result.status==='success'){outcome='success';return true;}
      if(result.status!=='partial'||performance.now()>=deadline){outcome=result.status==='partial'?'budget-exhausted':result.status;return false;}
      await yieldTurn(undefined,{signal});
    }
    outcome='search-ended';return false;
  } finally { search.return?.(); }
  } catch(error){outcome=signal?.aborted?'cancelled':'error';trace.event('path.search.error',{searchId,error});throw error;}
  finally {trace.event('path.search.end',{searchId,target,outcome,slices});}
}
async function candidates(bot, task, {signal}={}) {
  const report=audit('lumber');
  try {
  signal?.throwIfAborted();
  const available = p => !task.failed[`${p.x},${p.y},${p.z}`] || Date.now()-task.failed[`${p.x},${p.y},${p.z}`]>45000;
  let deadline=performance.now()+1200;
  const canReach = goal => reachable(bot,goal,{signal,deadline});
  const logs = bot.findBlocks({matching:b=>LOG.test(b.name),maxDistance:24,count:24}).filter(p=>available(p)||report.reject(point(p),'failure-cooldown'))
    .filter(p=>!(Math.floor(bot.entity.position.x)===p.x&&Math.floor(bot.entity.position.z)===p.z&&p.y<bot.entity.position.y)||report.reject(point(p),'log-under-player'))
    .sort((a,b)=>distance(a,bot.entity.position)-distance(b,bot.entity.position));
  const targets=[];
  for(const [index,p] of logs.entries()) {
    if(await canReach(harvestGoal(bot,p))){targets.push({position:point(p),name:bot.blockAt(p).name,distance:+distance(p,bot.entity.position).toFixed(1)});report.keep(point(p),'reachable-log');}
    else report.reject(point(p),'path-not-confirmed-see-search-event');
    if(targets.length===2||performance.now()>=deadline){for(const rest of logs.slice(index+1))report.reject(point(rest),targets.length===2?'candidate-limit':'search-budget');break;}
  }
  const drops=Object.values(bot.entities).filter(e=>{
    if(e.name!=='item'||!LOG.test(e.getDroppedItem?.()?.name||''))return false;
    if(distance(e.position,bot.entity.position)>=24)return report.reject(point(e.position),'drop-out-of-range');
    return available(e.position.floored())||report.reject(point(e.position),'drop-failure-cooldown');
  }).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position));
  deadline=performance.now()+400;
  let drop;
  for(const [index,e] of drops.entries()) {
    if(await canReach(new goals.GoalBlock(e.position.x,e.position.y,e.position.z))) {drop=e;report.keep(point(e.position),'reachable-drop');}
    else report.reject(point(e.position),'drop-path-not-confirmed');
    if(drop||performance.now()>=deadline){for(const rest of drops.slice(index+1))report.reject(point(rest.position),drop?'drop-candidate-limit':'drop-search-budget');break;}
  }
  let frontier=null;
  deadline=performance.now()+1400;
  const floors=bot.findBlocks({matching:b=>b.boundingBox==='block'&&!bot.pathfinder.movements.blocksToAvoid.has(b.type),maxDistance:16,count:512});
  for(const [index,p] of floors.entries()) {
    const feet=p.offset(0,1,0); const d=distance(feet,bot.entity.position);
    const reason=d<1.5?'too-close':d>16?'too-far':!available(feet)?'failure-cooldown':task.visited.some(old=>distance(old,feet)<1.5)?'already-visited':bot.blockAt(feet)?.boundingBox!=='empty'?'feet-blocked-or-unloaded':bot.blockAt(feet.offset(0,1,0))?.boundingBox!=='empty'?'head-blocked-or-unloaded':null;
    if(reason){report.reject(point(feet),reason);continue;}
    if(await canReach(new goals.GoalBlock(feet.x,feet.y,feet.z))) {frontier=point(feet);report.keep(frontier,'reachable-exploration');}
    else report.reject(point(feet),'exploration-path-not-confirmed');
    if(frontier||performance.now()>=deadline){for(const rest of floors.slice(index+1))report.reject(point(rest.offset(0,1,0)),frontier?'exploration-candidate-limit':'exploration-search-budget');break;}
  }
  return { logs:targets, droppedLog:drop?{id:drop.id,position:point(drop.position)}:null, exploreDestination:frontier };
  } finally {report.finish({scanLimits:{logs:24,logRadius:24,floors:512,floorRadius:16},floorPredicate:'solid and not blocksToAvoid'});}
}
function requireCandidates(seen, progress) {
  if(progress.collected<progress.target&&!seen.logs.length&&!seen.droppedLog&&!seen.exploreDestination)
    throw new Error('No safe Lumber target found within the search budget. Pause and check terrain or reposition the bot before retrying.');
}
function cancel(bot) { bot.pathfinder?.setGoal(null); bot.stopDigging(); bot.clearControlStates(); }
async function bounded(bot, signal, work) {
  signal.throwIfAborted();
  let rejectAbort;
  const onAbort=()=>{cancel(bot);rejectAbort(signal.reason||new Error('Cancelled'));};
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  signal.addEventListener('abort',onAbort,{once:true});
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return work();}),aborted]);}
  finally{signal.removeEventListener('abort',onAbort);}
}
async function executeTask(bot,task,choice,seen,signal) {
  let target;
  try {
    return await bounded(bot,signal,async()=>{
      if(choice==='wait'){await new Promise(r=>setTimeout(r,1000));signal.throwIfAborted();return 'waited';}
      if(choice==='return_home') {target=task.home;await bot.pathfinder.goto(new goals.GoalNear(target.x,target.y,target.z,1));return 'reached home';}
      if(choice==='explore') {target=seen.exploreDestination;if(!target)return 'unavailable: no reachable exploration destination';await bot.pathfinder.goto(new goals.GoalBlock(target.x,target.y,target.z));task.visited.push(target);return 'explored new ground';}
      if(choice==='pickup') {
        const drop=bot.entities[seen.droppedLog?.id];
        if(!drop||!LOG.test(drop.getDroppedItem?.()?.name||''))return 'unavailable: dropped log disappeared';
        target=drop.position;const before=logCount(bot);
        await bot.pathfinder.goto(new goals.GoalBlock(target.x,target.y,target.z));
        await new Promise(r=>setTimeout(r,600));signal.throwIfAborted();
        return logCount(bot)>before?'collected dropped logs':'visited drop location; no inventory gain';
      }
      target=seen.logs[choice==='harvest_alternative'?1:0]?.position;
      if(!target)return 'unavailable: no reachable log';
      await bot.pathfinder.goto(harvestGoal(bot,target));signal.throwIfAborted();
      const block=bot.blockAt(v(target));
      if(!block||!LOG.test(block.name)||!bot.canDigBlock(block))return 'target changed or cannot be mined';
      await bot.dig(block,true);signal.throwIfAborted();task.harvested++;
      await new Promise(r=>setTimeout(r,500));return `mined ${block.name}; inventory verifies collection`;
    });
  } catch(error) {
    trace.event('tool.internal-error',{choice,target,error,cancelled:signal.aborted});
    if(target) task.failed[`${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}`]=Date.now();
    if(signal.aborted)throw error;
    return `action failed: ${error.message}`;
  } finally {cancel(bot);}
}
module.exports={OBJECTIVE,LOG,logCount,createTask,progress,stopReason,configure,candidates,executeTask,bounded,cancel,reachable,requireCandidates};
