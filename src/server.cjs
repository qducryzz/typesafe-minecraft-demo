const path = require('node:path');
const {trace}=require('./trace.cjs');
const {createArchive}=require('./archive.cjs');
const {randomUUID}=require('node:crypto');
let activeRunId=null,currentConnectionId=null,archive;
const navigationContexts=new WeakMap();
const archiveDirectory=process.env.ARCHIVE_DIR||path.join(__dirname,'../runtime');
trace.configure({directory:process.env.TRACE_DIR||archiveDirectory,secrets:[process.env.TYPESAFE_API_KEY],context:()=>({runId:activeRunId,connectionId:currentConnectionId})});
trace.event('process.start',{nodeVersion:process.version});
process.on('uncaughtExceptionMonitor',(error,origin)=>trace.event('process.fatal',{error,origin}));
process.on('exit',code=>{trace.event('process.exit',{code});archive?.close(code);});
archive=createArchive({directory:archiveDirectory,metadata:{botUsername:'TypeSafeExplorer',nodeVersion:process.version,controlMode:'direct'}});
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const lumber = require('./task.cjs');
const {afterPreviousRun}=require('./restart.cjs');
const {resetFlag,shouldStartFresh}=require('./flag-reset.cjs');
const {scenarios,scenarioFor,apiFor}=require('./scenarios.cjs');
const {actionsFor}=require('./decisions.cjs');
let scenario=scenarioFor('lumber');
let taskApi=apiFor(scenario.id);
let camera='third';
const {cameraPacket,avatarPacket}=require('./camera.cjs');
const {viewerBundle}=require('./viewer-bundle.cjs');
const direct=require('./direct-control.cjs');
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView');
const { decide } = require('./decisions.cjs');
const {decideFresh}=require('./fresh-decision.cjs');
const { observe, point } = require('./observe.cjs');
const { setTimeout: delay } = require('node:timers/promises');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/view/socket.io', cors: { origin: true }, maxHttpBufferSize: 1e8 });
const port = Number(process.env.PORT || 8080);
const bind = process.env.BIND || '0.0.0.0';
let mcHost = process.env.MC_HOST || '127.0.0.1';
const mcPortDefault = Number(process.env.MC_PORT || 25565);
const mcVersion = process.env.MC_VERSION || '1.21.4';
const viewers = new Set();
let bot, ready = false, running = false, generation = 0, controller, activeLoop = null, restarting = false;
let goal = taskApi.OBJECTIVE, task = null;
let history = [], latest = null, count = 0, status = 'Waiting for Minecraft';
const clients = new Set();
let connecting = false, connectedPort = mcPortDefault;
let typesafeKey = String(process.env.TYPESAFE_API_KEY || '').trim();
let connectGeneration = 0, connectTimer = null;
function snapshot() { return { archive:{sessionId:archive.sessionId,files:archive.files},controlMode:'direct', scenarios, scenario:scenario.id, actionLabels:Object.fromEntries(Object.keys(actionsFor({scenario:scenario.id,controlMode:'direct'})).map(k=>[k,k.replaceAll('_',' ')])), camera, restarting, busy:running||!!activeLoop, ready, running, status, goal, count, latest, gameHost:mcHost, gamePort:connectedPort, gameVersion:mcVersion, task:ready&&task?taskApi.progress(bot,task):null, position: ready ? point(bot.entity.position) : null, keyConfigured: !!typesafeKey }; }
function broadcast() { const data = `data: ${JSON.stringify(snapshot())}\n\n`; for (const res of clients) res.write(data); }
function pause(reason = 'Paused') { trace.event(reason==='Paused'?'task.pause':'task.stop',{reason,count,position:bot?.entity?.position?point(bot.entity.position):null}); running = false; generation++; controller?.abort(); if(bot)lumber.cancel(bot); if(task && reason!=='Paused')task.finishedAt??=Date.now(); status = reason; broadcast(); }
function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = String(req.headers.host || '').split(':')[0];
    if (['127.0.0.1', 'localhost'].includes(o.hostname)) return true;
    if (host && o.hostname === host) return true;
    if (o.hostname.endsWith('.grok.me') || o.hostname.endsWith('.grok.com')) return true;
  } catch {}
  return false;
}
app.use((req,res,next)=>{
  const httpRequestId=randomUUID();
  trace.run({httpRequestId},()=>{
    if(req.method==='POST') {
      trace.event('control.request',{action:req.path.split('/')[2]});
      const json=res.json.bind(res);res.json=body=>{if(body?.error)trace.event('control.rejected',{httpStatus:res.statusCode,reason:body.error});return json(body);};
      res.on('finish',()=>trace.event('control.result',{httpRequestId,action:req.path.split('/')[2],httpStatus:res.statusCode}));
    }
    next();
  });
});
app.use(express.json({ limit:'4kb' }));
app.get('/api/state', (req,res) => res.json(snapshot()));
app.get('/api/events', (req,res) => { res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'}); res.flushHeaders(); clients.add(res); res.write(`data: ${JSON.stringify(snapshot())}\n\n`); req.on('close',()=>clients.delete(res)); });
app.post('/api/:action', (req,res) => {
  if (!allowedOrigin(req)) return res.sendStatus(403);
  if(['restart','build-test'].includes(req.params.action)){
    const buildTest=req.params.action==='build-test';
    if(buildTest&&(scenario.id!=='flag'||process.env.FLAG_DEMO_RESET!=='1'))return res.status(409).json({error:'Build test requires Canadian Flag and the isolated reset adapter.'});
    if(!ready||!typesafeKey)return res.status(409).json({error:'Minecraft and a TypeSafe key must be ready.'});
    if(restarting||(running&&!task))return res.status(409).json({error:'A reset is already in progress.'});
    if(bot.game.gameMode!=='survival')return res.status(409).json({error:'This task requires Survival mode.'});
    const previous=activeLoop;
    restarting=true;pause('Stopping current task to restart');
    running=true;const token=++generation;
    trackRun(afterPreviousRun(previous,()=>running&&generation===token&&ready,()=>startRun(token,true,buildTest)));
    broadcast();return res.json(snapshot());
  }
  if(req.params.action==='camera') {
    if(!['third','overview'].includes(req.body.mode))return res.status(400).json({error:'Unknown camera mode'});
    if(req.body.mode==='overview'&&(!ready||scenario.id!=='flag'))return res.status(409).json({error:'Connect Minecraft and select Canadian Flag first.'});
    camera=req.body.mode;for(const socket of viewers)socket.data.updateCamera?.();broadcast();return res.json(snapshot());
  }
  if(req.params.action==='scenario') {
    if(running||activeLoop)return res.status(409).json({error:'Pause the current task before switching scenarios.'});
    try{scenario=scenarioFor(req.body.scenario);}catch(error){return res.status(400).json({error:error.message});}
    trace.event('scenario.selected',{scenario:scenario.id});activeRunId=null;
    taskApi=apiFor(scenario.id);goal=scenario.objective;task=null;latest=null;history=[];count=0;if(camera==='overview')camera='third';
    if(bot?.pathfinder?.movements)bot.pathfinder.movements.canDig=scenario.id==='lumber';
    for(const socket of viewers)socket.data.updateCamera?.();status='Scenario selected. Press Start task.';broadcast();return res.json(snapshot());
  }
  if (req.params.action === 'goal') {
    const next=String(req.body?.goal||'').trim();
    if(next.length<4)return res.status(400).json({error:'Enter a task objective.'});
    if(running)return res.status(409).json({error:'Pause the task before changing the objective.'});
    goal=next;status='Objective updated. Press Start task.';broadcast();return res.json(snapshot());
  }
  if (req.params.action === 'pause') { pause(); return res.json(snapshot()); }
  if (req.params.action === 'key') {
    const key = String(req.body?.key || '').trim();
    if (key.length < 8) return res.status(400).json({ error:'Paste a TypeSafe API key, then save.' });
    typesafeKey = key;trace.addSecret(key);trace.event('credential.configured');
    if (ready && !running) status = 'Key saved. Press Start task.';
    broadcast();
    return res.json(snapshot());
  }
  if (req.params.action === 'connect') {
    const gamePort = Number(req.body.port);
    const host = String(req.body.host || mcHost).trim();
    if (!host) return res.status(400).json({error:'Enter the Minecraft host.'});
    if (!Number.isInteger(gamePort) || gamePort < 1024 || gamePort > 65535) return res.status(400).json({error:'Enter a Minecraft port (1024-65535).'});
    if (running || activeLoop) pause('Switching Minecraft world');
    connect(gamePort, host); return res.json(snapshot());
  }
  if (req.params.action !== 'start') return res.sendStatus(404);
  if (!ready || !typesafeKey) return res.status(409).json({ error:'Minecraft and a TypeSafe key must be ready.' });
  if (running || activeLoop) return res.status(409).json({ error:'A run is already active or stopping.' });
  if(bot.game.gameMode !== 'survival')return res.status(409).json({error:'This task requires Survival mode so mined logs drop as items.'});
  const nextGoal=String(req.body?.goal||'').trim();
  if(nextGoal) goal=nextGoal;
  const fresh=shouldStartFresh(task,task?taskApi.progress(bot,task):null,scenario.budgetMs);
  running = true; status = fresh&&scenario.id==='flag'?'Resetting flag and wool supply areas':'Observing';
  const myGeneration = ++generation;
  trackRun(startRun(myGeneration,fresh));
  broadcast(); res.json(snapshot());
});
const animatedViewerBundle=viewerBundle();
const viewerPublic=path.join(path.dirname(require.resolve('prismarine-viewer')),'public');
app.get('/view/index.js',(req,res)=>res.type('js').send(animatedViewerBundle));
app.get('/worker.js',(req,res)=>res.sendFile(path.join(viewerPublic,'worker.js')));
app.use('/textures', express.static(path.join(viewerPublic,'textures')));
app.use('/blocksStates', express.static(path.join(viewerPublic,'blocksStates')));
app.use('/view', express.static(viewerPublic));
app.use(express.static(path.join(__dirname, '../public')));
app.use((error,req,res,next)=>{
  // Parser errors can contain submitted credentials; never record their body or message.
  trace.event('http.error',{name:error.name,type:error.type,httpStatus:error.status||500});
  if(res.headersSent)return next(error);
  res.status(error.status||500).json({error:'Request failed'});
});

function attachViewer(socket) {
  if (!ready || socket.data.attached) return;
  socket.data.attached = true;
  const player = bot;
  socket.emit('version', player.version);
  const world = new WorldView(player.world, 4, player.entity.position, socket);
  world.listenToBot(player);
  world.init(player.entity.position).then(()=>console.log('worldView init ok', player.entity.position)).catch(error=>trace.event('viewer.error',{phase:'init',error}));
  let swing=false;
  const swung=()=>{swing=true;};
  const animation=()=>{socket.emit('avatar-state',{pos:player.entity.position,pitch:player.entity.pitch,heldItem:player.heldItem?.name||null,digging:!!player.targetDigBlock,swing});swing=false;};
  player.on('diggingCompleted',swung);
  const animationTimer=setInterval(animation,50);
  const move = () => {
    socket.emit('entity',avatarPacket(player,camera));
    socket.emit('position',cameraPacket(player,camera,task||(scenario.id==='flag'?taskApi.createTask(player):null)));
    world.updatePosition(player.entity.position).catch(error=>trace.event('viewer.error',{phase:'update',error}));
  };
  socket.data.updateCamera=move;
  player.on('move', move); move();
  socket.on('disconnect', () => { clearInterval(animationTimer);player.removeListener('diggingCompleted',swung);player.removeListener('move',move); world.removeListenersFromBot(player); });
}
io.on('connection', socket => { viewers.add(socket); attachViewer(socket); socket.on('disconnect',()=>viewers.delete(socket)); });

function trackRun(operation){
  const tracked=operation.finally(()=>{if(activeLoop===tracked){activeLoop=null;restarting=false;}broadcast();});
  activeLoop=tracked;
}
async function startRun(token,fresh,buildTest=false){
  if(fresh||!activeRunId)activeRunId=randomUUID();
  return trace.run({runId:activeRunId,connectionId:currentConnectionId,scenario:scenario.id,controlMode:'direct'},async()=>{
  trace.event(fresh?'task.start':'task.resume',{generation:token,buildTest,goal});
  try{
    if(fresh){
      history=[];latest=null;count=0;task=null;if(camera==='overview')camera='third';
      if(buildTest) goal='BUILD TEST - materials supplied; mining skipped. Build and inspect the Canadian flag.';
      status=scenario.id==='flag'?'Resetting flag and wool supply areas':'Starting a fresh task';broadcast();
      if(scenario.id==='flag'){
        const prepared=taskApi.createTask(bot);
        await trace.span('setup.reset',{buildTest},()=>resetFlag(bot,prepared,{port:connectedPort,host:mcHost,buildTest}));
      }
      if(!running||generation!==token||!ready)return;
      task=taskApi.createTask(bot);
      task.setupMode=buildTest?'build-test-supplied-materials':'normal';
      for(const socket of viewers)socket.data.updateCamera?.();
    }
    if(!running||generation!==token||!ready)return;
    restarting=false;
    bot.pathfinder.movements.canDig=scenario.id==='lumber';
    await loop(token);
  }catch(error){trace.event('task.error',{phase:'setup',error});if(generation===token)pause('Stopped: '+error.message);}
  });
}
async function loop(token) {
  try {
    while (running && generation === token && count < 6000) {
      const progress = taskApi.progress(bot,task);
      const stop = taskApi.stopReason(progress,task);
      if(stop){if(progress.complete&&scenario.id==='flag'){camera='overview';for(const socket of viewers)socket.data.updateCamera?.();}pause(stop);break;}
      if(bot.health<8)throw new Error('Stopped: health is low');
      const keepGoing=await archive.round(async round=>{
        const player=bot,roundTask=task,roundApi=taskApi;
        let draft=null;
        const currentPosition=()=>player?.entity?.position?point(player.entity.position):null;
        try {
          status='TypeSafe is deciding';broadcast();
          controller=new AbortController();
          const limit=6000;
          const fresh=await decideFresh({
            signal:controller.signal,
            isActive:()=>running&&generation===token&&ready&&bot===player&&count<limit,
            onCorrelation:ids=>round.correlate(ids),
            observe:()=>trace.span('observation',{},async()=>{
              const state=observe(player,goal,history);
              state.scenario=scenario.id;state.controlMode='direct';
              state.task={...roundApi.progress(player,roundTask),setupMode:roundTask.setupMode||'normal'};
              state.direct=direct.observeDirect(player,roundTask);
              status='TypeSafe is deciding';broadcast();
              trace.event('observation.ready',{state,routeMode:'no-pathfinding'});
              return state;
            }),
            decide:(state,correlation)=>decide(state,{requestId:correlation.requestId,key:typesafeKey,model:process.env.TYPESAFE_MODEL||'jev-latest',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])}),
            position:currentPosition,
            onServiceError:record=>{
              round.record({...record,recordType:'api-error',status:record.retry?'retrying':'failed'},'request.retry');
              const failure=record.errorType==='timeout'?'TypeSafe request timed out':'TypeSafe HTTP '+record.httpStatus;
              status=record.retry?failure+'; retrying in '+record.delayMs/1000+'s':failure+'; retries exhausted';broadcast();
            },
            onDiscard:record=>{
              latest=round.record({...record,id:++count,recordType:'decision',status:'discarded',progress:roundApi.progress(player,roundTask)},'decision.discarded');
              status='Skipped stale decision; observing again';broadcast();
            }
          });
          if(!fresh)return false;
          const {state,result,freshness,correlation}=fresh;
          round.correlate({...correlation,toolId:randomUUID()});
          trace.event('decision.accepted',{...round.ids,choice:result.answer.choice,freshness});
          count++;
          draft={id:count,timestamp:new Date().toISOString(),state,...result,freshness,outcome:'Executing'};
          latest={sessionId:archive.sessionId,...round.ids,...draft};
          status='Executing '+result.answer.choice;broadcast();
          const actionSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,Math.min(scenario.actionMs,scenario.budgetMs-Date.now()+roundTask.startedAt)))]);
          const outcome=await trace.run(round.ids,()=>trace.span('tool',{choice:result.answer.choice,position:state.position},async()=>{
            const context=trace.context();navigationContexts.set(player,context);
            try{return await direct.execute(player,roundTask,result.answer.choice,state.direct,actionSignal);}
            finally{if(navigationContexts.get(player)===context)navigationContexts.delete(player);}
          }));
          const end=currentPosition();
          draft.outcome=outcome;draft.endPosition=end;
          draft.distanceMoved=end?+Math.hypot(end.x-state.position.x,end.z-state.position.z).toFixed(2):null;
          draft.progress=roundApi.progress(player,roundTask);
          latest=round.finish({...draft,recordType:'decision',status:'completed'});
          history.push({action:result.answer.choice,outcome,distanceMoved:draft.distanceMoved,position:end});history=history.slice(-12);
          broadcast();return true;
        }catch(error){
          if(draft){
            const cancelled=generation!==token;
            draft.outcome=cancelled?'Cancelled':'Stopped: '+error.message;draft.endPosition=currentPosition();
            try{draft.progress=roundApi.progress(player,roundTask);}catch(snapshotError){draft.progress=null;trace.event('decision.snapshot.error',{...round.ids,error:snapshotError});}
            latest=round.finish({...draft,recordType:'decision',status:cancelled?'cancelled':'failed',error});
          }
          throw error;
        }
      },{isCancelled:()=>generation!==token||!running});
      if(!keepGoing)break;
      await delay(100);
    }
    if(generation===token)pause('Stopped: '+6000+'-decision limit reached');
  }catch(error){
    trace.event('task.error',{phase:'loop',error,cancelled:generation!==token});
    if(generation===token)pause('Stopped: '+error.message);else broadcast();
  }
}

server.on('error',error=>{trace.event('server.error',{error});throw error;});
server.listen(port, bind, () => {
  trace.event('server.listening',{port,bind});
  console.log(`Demo: http://${bind}:${port} -> ${mcHost}:${mcPortDefault} (${mcVersion})`);
  if (process.env.MC_AUTOCONNECT !== '0') connect(mcPortDefault);
});
function connect(gamePort = mcPortDefault, host = mcHost) {
  const token = ++connectGeneration;
  const connectionId=randomUUID();currentConnectionId=connectionId;
  trace.event('connection.start',{connectionId,host,port:gamePort,version:mcVersion});
  const previous = bot;
  connecting = true;
  ready = false;
  mcHost = host;
  connectedPort=gamePort;task=null;
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  status = `Connecting to Minecraft ${mcHost}:${gamePort}`;
  broadcast();
  if (previous) {
    bot = null;
    trace.event('connection.replaced');
    try { previous.quit(); } catch(error) {trace.event('connection.error',{phase:'quit-previous',error});}
    for (const socket of [...viewers]) {
      socket.data.attached = false;
      socket.disconnect(true);
    }
  }
  let player;
  try {player = mineflayer.createBot({ host:mcHost,port:gamePort,username:'TypeSafeExplorer',auth:'offline',version:mcVersion,hideErrors:true });}
  catch(error){trace.event('connection.error',{connectionId,phase:'create',error});throw error;}
  bot = player;
  for(const event of ['path_update','path_reset','path_stop','goal_reached'])player.on(event,result=>{
    trace.event('navigation.'+event,{runId:null,decisionId:null,observationId:null,requestId:null,toolId:null,...navigationContexts.get(player),connectionId,result:event==='path_update'?{status:result.status,cost:result.cost,time:result.time,visitedNodes:result.visitedNodes,generatedNodes:result.generatedNodes,path:result.path?.map(p=>({x:p.x,y:p.y,z:p.z,toBreak:p.toBreak,toPlace:p.toPlace}))}:String(result||'')});
  });
  connectTimer = setTimeout(() => {
    if (connectGeneration !== token || bot !== player) return;
    connecting = false;
    ready = false;
    bot = null;
    trace.event('connection.timeout',{connectionId,timeoutMs:25000});
    status = `Could not reach ${mcHost}:${gamePort} in 25s. Confirm the Java server is up on that port.`;
    broadcast();
    try { player.end('connect-timeout'); } catch(error) {trace.event('connection.error',{connectionId,phase:'end-timeout',error});}
  }, 25000);
  player.loadPlugin(pathfinder);
  player.once('spawn',async () => {
    try {
      if (connectGeneration !== token || bot !== player) return;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      trace.event('connection.spawn',{connectionId});
      await player.waitForChunksToLoad();
      trace.event('connection.chunks-loaded',{connectionId,position:point(player.entity.position)});
      if (bot !== player) return;
      lumber.configure(player);player.pathfinder.movements.canDig=scenario.id==='lumber'; connecting = false; ready = true; trace.event('connection.ready',{connectionId,position:point(player.entity.position)}); const cols=player.world.getColumns?player.world.getColumns():[]; console.log('spawn chunks', Array.isArray(cols)?cols.length:Object.keys(cols||{}).length, 'pos', player.entity.position); status = 'Ready. Press Start task.'; for (const socket of viewers) attachViewer(socket); broadcast();
    }
    catch(error) { trace.event('connection.error',{connectionId,phase:'spawn',error}); pause(error.message); }
  });
  player.on('error', error => { trace.event('connection.error',{connectionId,error}); if(bot !== player)return; if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } connecting = false; status = `Minecraft: ${error.code || error.message}`; broadcast(); });
  player.on('kicked', (reason) => { trace.event('connection.kicked',{connectionId,reason}); if(bot === player)pause('Minecraft disconnected the player: '+String(reason).slice(0,180)); });
  player.on('death',()=>{trace.event('player.death',{connectionId});if(bot === player)pause('Player died');});
  player.on('end',reason=>{
    trace.event('connection.end',{connectionId,reason});
    if (bot !== player) return;
    connecting = false;
    ready = false;
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (!String(status).startsWith('Could not reach') && !String(status).startsWith('Minecraft:')) {
      pause(`Disconnected from ${mcHost}:${connectedPort}.`);
    } else {
      broadcast();
    }
    for(const socket of viewers) socket.disconnect(true);
  });
}
status = `Connecting to Minecraft ${mcHost}:${mcPortDefault}`;
function shutdown(signal) { trace.event('process.shutdown',{signal}); pause('Shutting down'); bot?.quit(); io.close(); server.close(); setTimeout(()=>process.exit(0),500).unref(); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
