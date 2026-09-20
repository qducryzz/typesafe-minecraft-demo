const $ = id => document.getElementById(id);
let labels = {};
function renderBars(next){
  if(!next||!Object.keys(next).length)return;
  labels=next;$('bars').replaceChildren();
  for(const [key,label] of Object.entries(labels)) {
    const row=document.createElement('div');row.className='bar-row';row.id=`bar-${key}`;
    const caption=document.createElement('div');caption.className='bar-caption';
    const name=document.createElement('span');name.textContent=label;
    const value=document.createElement('span');value.id=`value-${key}`;value.textContent='0%';
    const track=document.createElement('div');track.className='bar-track';
    const fill=document.createElement('div');fill.className='bar-fill';fill.id=`fill-${key}`;fill.style.width='0%';
    caption.append(name,value);track.append(fill);row.append(caption,track);$('bars').append(row);
  }
}
let lastScenario=null;
let lastReady=false;
function fillBars(answer){
  const probs=answer?.probabilities||{};
  for(const key of Object.keys(labels)) {
    const el=$(`value-${key}`), fill=$(`fill-${key}`), row=$(`bar-${key}`);
    if(!el||!fill||!row)continue;
    const p=Number(probs[key]||0);
    el.textContent=`${Math.round(p*100)}%`;
    fill.style.width=`${Math.max(0,Math.min(100,p*100))}%`;
    row.classList.toggle('selected',!!answer&&key===answer.choice);
  }
}
function render(s) {
  if(lastScenario!==s.scenario){
    lastScenario=s.scenario;
    $('scenario').replaceChildren(...s.scenarios.map(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.name+(item.available?'':' (coming next)');option.disabled=!item.available;return option;}));
    $('scenario').value=s.scenario;
  }
  const offered=s.latest?.request?.questions?.movement?.criteria||{};
  const offeredLabels=Object.keys(offered).length
    ?Object.fromEntries(Object.keys(offered).map(key=>[key,s.actionLabels[key]||key.replaceAll('_',' ')]))
    :(s.actionLabels||{});
  if(JSON.stringify(Object.keys(labels))!==JSON.stringify(Object.keys(offeredLabels)))renderBars(offeredLabels);
  $('scenario').disabled=s.busy;
  $('scenario').value=s.scenario;
  $('scenario-info').textContent=s.scenarios.find(item=>item.id===s.scenario).description;
  if(document.activeElement!==$('goal')) $('goal').value=s.goal;
  $('goal').readOnly=!!s.running;
  $('apply-goal').disabled=!!s.running;
  $('camera').disabled=!s.ready;$('camera').value=s.camera;
  $('camera').querySelector('[value="overview"]').disabled=s.scenario!=='flag'||!s.ready;
  const cameraLabel={third:'THIRD-PERSON FOLLOW',player:'FIRST-PERSON VIEW',overview:'OVERHEAD CAMERA'}[s.camera];
  document.querySelector('.world-label').textContent='MINECRAFT JAVA / '+cameraLabel;
  $('view').title='Live Minecraft '+cameraLabel.toLowerCase();
  $('milestones').textContent=s.scenario==='flag'
    ?(s.task?.stage==='gathering'?'Mine the wool supply areas, collect every drop, then build.':s.task?.sections?Object.entries(s.task.sections).map(([name,p])=>name.replaceAll('_',' ')+': '+p.placed+'/'+p.total).join(' | '):'')
    :(s.task?`Stage: ${s.task.stage}`:'');
  $('task-meter').max=s.task?.target||(s.scenario==='flag'?338:10);
  if(s.scenario==='flag')$('task-progress').textContent=s.task?    (s.task.stage==='gathering'?'Gathering: '+s.task.inventory.red_wool+'/'+s.task.required.red_wool+' red, '+s.task.inventory.white_wool+'/'+s.task.required.white_wool+' white':s.task.collected+' / '+s.task.target+' flag blocks verified')+' | '+s.task.remainingSeconds+'s left':'Mine 234 red + 104 white wool, then build the flag.';
  if(document.activeElement!==$('mc-host'))$('mc-host').value=s.gameHost||'';
  if(document.activeElement!==$('mc-port')&&s.gamePort)$('mc-port').value=String(s.gamePort);
  $('connection-help').textContent=`${s.gameHost||'?'}:${s.gamePort||'?'} · Java ${s.gameVersion||'1.21.4'} · offline · ${s.ready?'live':(s.status||'connecting')}`;
  $('connect').disabled=!!s.running||!!s.restarting;
  $('connect').textContent=s.ready?'Reconnect':'Connect';
  $('key-status').textContent=s.keyConfigured?(s.ready?'Key saved. Press Start task.':'Key saved. Waiting for Minecraft.'):'Paste your TypeSafe key, then Save.';
  $('save-key').textContent=s.keyConfigured?'Update':'Save';
  if(s.keyConfigured)$('api-key').placeholder='•••• saved';
  $('start').disabled=!s.ready || !s.keyConfigured || s.busy;
  $('pause').disabled=!s.running;
  $('restart').disabled=!s.ready||!s.keyConfigured||s.restarting||(s.busy&&!s.task);
  $('restart').textContent=s.restarting?'Restarting...':'Restart task';
  $('build-test').hidden=s.scenario!=='flag';$('build-test').disabled=$('restart').disabled;
  $('copy-input').disabled=!s.latest?.request;
  $('copy-output').disabled=!s.latest?.raw;
  $('status').textContent=s.status;
  if(s.scenario!=='flag')$('task-progress').textContent=s.task?`${s.task.collected} / ${s.task.target} logs | ${s.task.homeDistance} blocks from home | ${s.task.remainingSeconds}s left`: 'Collect 10 logs, then return home. Five-minute limit.';
  $('task-meter').value=s.scenario==='flag'&&s.task?.stage==='gathering'?s.task.inventory.red_wool+s.task.inventory.white_wool:s.task?.collected||0;
  $('start').textContent=s.running?'Task running':s.task&&!s.task.finished&&!s.task.complete&&s.task.remainingSeconds>0?'Resume task':'Start task';
  $('count').textContent=s.count;
  $('hud-goal').textContent=s.goal;
  $('empty').style.display=s.ready?'none':'flex';
  const connecting=String(s.status||'').toLowerCase().includes('connecting');
  const failed=!s.ready && !connecting;
  $('empty-title').textContent=s.ready?'':(failed?'Not connected': 'Connecting to the Java world');
  $('empty-copy').textContent=s.ready?'':(failed?(s.status||'Could not join the Java world. Check host/port, then Connect.'):'TypeSafeExplorer is joining the 1.21.4 backend. Steve and the live Prismarine view will appear here.');
  lastReady=s.ready;
  if(s.position) $('position').textContent=`${s.position.x.toFixed(1)} / ${s.position.y.toFixed(1)} / ${s.position.z.toFixed(1)}`;
  fillBars(s.latest?.answer);
  if(!s.latest){$('action').textContent='Ready';$('raw').textContent='No response yet.';$('input-raw').textContent='No request yet.';$('observation').textContent='Waiting for observations.';$('latency').textContent='--';$('confidence').textContent='--';return;}
  const {answer,latencyMs,state,raw,outcome,request}=s.latest;
  $('input-raw').textContent=request?JSON.stringify(request,null,2):'No captured request for this earlier decision.';
  $('action').textContent=(answer&& (labels[answer.choice]||answer.choice))||'—';
  $('latency').textContent=latencyMs??'--';
  $('confidence').textContent=answer&&Number.isFinite(answer.confidence)?`${Math.round(answer.confidence*100)}%`:'--';
  if(raw?.model)$('model').textContent=raw.model;
  $('raw').textContent=raw?JSON.stringify(raw,null,2):'No response yet.';
  const obsState=state||{};
  if(obsState.scenario==='flag'&&obsState.task){
    $('observation').textContent=`stage: ${obsState.task.stage}\nred wool: ${obsState.task.inventory.red_wool}\nwhite wool: ${obsState.task.inventory.white_wool}\nresult: ${outcome||''}`;
  } else if(obsState.candidates){
    $('observation').textContent=`stage: ${obsState.task?.stage||'—'}\nreachable logs: ${obsState.candidates.logs?.length??0}\ndropped log: ${obsState.candidates.droppedLog?'yes':'none'}\nexploration route: ${obsState.candidates.exploreDestination?'available':'none'}\nresult: ${outcome||''}`;
  } else {
    $('observation').textContent=outcome?String(outcome):'Waiting for observations.';
  }
  $('observation').style.whiteSpace='pre-line';
}
const events=new EventSource('/api/events');
events.onmessage=e=>render(JSON.parse(e.data));
events.onerror=()=>{$('status').textContent='Dashboard disconnected. Reconnecting...';$('start').disabled=true;};
async function command(action,payload={}){try{const response=await fetch(`/api/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const body=await response.json();if(!response.ok)throw new Error(body.error);render(body);}catch(error){$('status').textContent=error.message;}}
$('scenario').onchange=()=>command('scenario',{scenario:$('scenario').value});
$('camera').onchange=()=>command('camera',{mode:$('camera').value});
$('restart').onclick=()=>command('restart');
$('build-test').onclick=()=>command('build-test');
$('start').onclick=()=>command('start',{goal:$('goal').value.trim()});
$('pause').onclick=()=>command('pause');
$('apply-goal').onclick=()=>command('goal',{goal:$('goal').value.trim()});
$('connect').onclick=()=>command('connect',{host:$('mc-host').value.trim(),port:Number($('mc-port').value)});
$('save-key').onclick=async()=>{const key=$('api-key').value.trim();await command('key',{key});if(key)$('api-key').value='';};
$('api-key').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('save-key').click();}});
$('goal').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();$('apply-goal').click();}});
let recorder, stream;
$('record').onclick=async()=>{
  if(recorder?.state==='recording'){recorder.stop();return;}
  try{
    stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:30},audio:false,preferCurrentTab:true});
    const chunks=[];
    const mimeType=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
    recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:8000000});
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.onstop=()=>{stream.getTracks().forEach(t=>t.stop());const url=URL.createObjectURL(new Blob(chunks,{type:mimeType}));const a=document.createElement('a');a.href=url;a.download=`typesafe-minecraft-${Date.now()}.webm`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);$('record').textContent='Record tab';$('record-status').textContent='Recording saved as WebM.';};
    stream.getVideoTracks()[0].onended=()=>{if(recorder.state==='recording')recorder.stop();};
    recorder.start(1000);$('record').textContent='Stop recording';$('record-status').textContent='Recording the surface you selected. Stop to save.';
  }catch(error){stream?.getTracks().forEach(t=>t.stop());$('record-status').textContent=`Recording not started: ${error.message}`;}
};

for(const [buttonId,sourceId] of [['copy-input','input-raw'],['copy-output','raw']]){
  const button=$(buttonId);
  button.onclick=async event=>{
    event.preventDefault();event.stopPropagation();
    const text=$(sourceId).textContent;
    try{await navigator.clipboard.writeText(text);button.textContent='Copied!';button.title='JSON copied to clipboard';}
    catch(error){button.textContent='Copy failed';button.title='Clipboard access was denied. Expand the JSON and select it to copy manually.';}
    clearTimeout(button.copyTimer);button.copyTimer=setTimeout(()=>{button.textContent='Copy';},1800);
  };
}
