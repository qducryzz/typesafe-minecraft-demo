(()=>{
 const el=id=>document.getElementById(id),dialog=el('rcon-dialog');
 let state=null,working=false,poll=null,outputSignature='',initialized=false;
 function render(next){
  state=next;el('rcon-status').textContent=next.status;
  if(!initialized){el('rcon-host').value=next.host;el('rcon-port').value=next.port;initialized=true;}
  if(document.activeElement!==el('rcon-host')&&!el('rcon-host').value)el('rcon-host').value=next.host;
  if(document.activeElement!==el('rcon-port')&&!el('rcon-port').value)el('rcon-port').value=next.port;
  el('rcon-password-help').textContent=next.passwordConfigured?'后端已保存此连接的密码；留空可复用，输入新密码可更新。':'密码仅在后端会话中保留，不保存到浏览器。';
  el('rcon-connect').disabled=working||next.busy;
  el('rcon-connect').textContent=next.connected?'重新连接':'连接';
  el('rcon-disconnect').disabled=!next.connected&&!next.busy;
  el('rcon-send').disabled=working||next.busy||!next.connected||next.taskBusy;
  el('rcon-command-help').textContent=next.taskBusy?'机器人任务运行中：快捷查询可用，自定义命令需先暂停任务。':'自定义命令可能改变世界；Ctrl+Enter 执行。';
  if(!el('rcon-queries').children.length)for(const [key,preset] of Object.entries(next.presets)){
    const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=preset.label;
    button.onclick=()=>action('command',{preset:key});el('rcon-queries').append(button);
  }
  for(const button of el('rcon-queries').children)button.disabled=working||next.busy||!next.connected;
  const signature=JSON.stringify(next.history);
  if(signature!==outputSignature){
    outputSignature=signature;
    if(next.history.length){
      el('rcon-output').replaceChildren(...next.history.map(record=>{
        const entry=document.createElement('div');entry.className='rcon-entry '+record.status;
        const title=document.createElement('strong');title.textContent=`${new Date(record.timestamp).toLocaleTimeString()}  > ${record.command}`;
        const output=document.createElement('p');output.textContent=record.status==='pending'?'等待响应…':(record.output||'（服务器返回空响应）');
        const meta=document.createElement('p');meta.className='note';meta.textContent=record.status==='error'?'执行未确认，未自动重试':record.elapsedMs!=null?`${record.elapsedMs} ms · 服务器响应`:'';
        entry.append(title,output,meta);return entry;
      }));el('rcon-output').scrollTop=el('rcon-output').scrollHeight;
    }
  }
 }
 async function refresh(){
  try{const response=await fetch('/api/rcon/state',{cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body.error);render(body);}
  catch(error){el('rcon-error').textContent=error.message;}
 }
 async function action(name,payload={}){
  if(working&&name!=='disconnect')return;
  working=true;el('rcon-error').textContent='';if(state)render(state);
  try{const response=await fetch('/api/rcon/'+name,{method:'POST',headers:{'Content-Type':'application/json','X-Rcon-Console':'1'},body:JSON.stringify(payload)});const body=await response.json();if(body.state)render(body.state);if(!response.ok)throw new Error(body.error);render(body);}
  catch(error){el('rcon-error').textContent=error.message;}
  finally{working=false;await refresh();}
 }
 el('open-rcon').onclick=()=>{dialog.showModal();refresh();clearInterval(poll);poll=setInterval(refresh,2500);};
 el('rcon-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{clearInterval(poll);el('rcon-password').value='';});
 el('rcon-connect-form').onsubmit=event=>{event.preventDefault();const password=el('rcon-password').value;el('rcon-password').value='';action('connect',{host:el('rcon-host').value.trim(),port:Number(el('rcon-port').value),password});};
 el('rcon-disconnect').onclick=()=>action('disconnect');
 el('rcon-command-form').onsubmit=event=>{event.preventDefault();if(!el('rcon-send').disabled)action('command',{command:el('rcon-command').value});};
 el('rcon-command').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();el('rcon-command-form').requestSubmit();}});
})();
