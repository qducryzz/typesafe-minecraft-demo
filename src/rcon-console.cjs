const {randomUUID}=require('node:crypto');
const {RconClient}=require('./rcon-client.cjs');
const {trace}=require('./trace.cjs');
const {resolveBotIdentity}=require('./bot-identity.cjs');
function presetsFor(botUsername){
  if(!/^TypeSafeBot[A-Z0-9]{5}$/.test(botUsername))throw new Error('Invalid generated bot username');
  return {players:{label:'在线玩家',command:'list'},position:{label:'机器人坐标',command:`data get entity ${botUsername} Pos`},inventory:{label:'机器人背包',command:`data get entity ${botUsername} Inventory`},time:{label:'世界时间',command:'time query daytime'},seed:{label:'世界种子',command:'seed'}};
}
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function createRconConsole({botUsername=resolveBotIdentity().username,defaultHost=()=> '127.0.0.1',env=process.env,isTaskBusy=()=>false,onChange=()=>{},Client=RconClient}={}){
  const presets=presetsFor(botUsername);
  let host=env.RCON_HOST||defaultHost(),port=Number(env.RCON_PORT||25575),password=env.RCON_PASSWORD||'';
  let configuredHost=host,configuredPort=port,client=null,busy=false,status='未连接',connected=false,history=[];
  trace.addSecret(password);
  const state=()=>({botUsername,host,port,connected,busy,status,passwordConfigured:!!password,taskBusy:!!isTaskBusy(),presets,history});
  function notify(){onChange();}
  async function connect(input={}){
    if(busy)throw fail('RCON 正在处理操作，请稍候。',409);
    const nextHost=String(input.host||env.RCON_HOST||defaultHost()).trim(),nextPort=Number(input.port??port);
    if(!nextHost||nextHost.length>253||/[\s/\\:@?#]/.test(nextHost))throw fail('请输入有效的 RCON 主机名或 IPv4 地址。');
    if(!Number.isInteger(nextPort)||nextPort<1||nextPort>65535)throw fail('RCON 端口必须为 1–65535。');
    const provided=typeof input.password==='string'?input.password:'';
    const nextPassword=provided||(nextHost===configuredHost&&nextPort===configuredPort?password:'');
    if(!nextPassword)throw fail('请输入该 RCON 服务器的密码。');
    if(nextPassword.includes('\0')||Buffer.byteLength(nextPassword)>1024)throw fail('RCON 密码格式无效。');
    client?.disconnect();host=nextHost;port=nextPort;password=nextPassword;configuredHost=host;configuredPort=port;
    trace.addSecret(password);busy=true;connected=false;status='正在验证 RCON 密码…';notify();
    const current=new Client({host,port,password});client=current;
    current.on('end',()=>{if(client!==current)return;connected=false;if(!busy)status='RCON 连接已关闭';trace.event('rcon.disconnected',{host,port});notify();});
    try{await trace.span('rcon.connect',{host,port},()=>current.connect());if(client!==current)throw fail('连接已取消。',409);connected=true;status='已连接 · 仅手动命令';}
    catch(error){current.disconnect();status='连接失败：'+trace.sanitize(error.message);throw fail(status,502);}
    finally{busy=false;notify();}
    return state();
  }
  function disconnect(){
    const current=client;client=null;connected=false;status='已断开';current?.disconnect();trace.event('rcon.disconnected',{host,port,manual:true});notify();return state();
  }
  async function execute(input={}){
    if(busy)throw fail('上一条 RCON 操作尚未完成。',409);
    if(!connected||!client)throw fail('请先连接 RCON。',409);
    const preset=input.preset&&Object.hasOwn(presets,input.preset)?presets[input.preset]:null;
    if(input.preset&&!preset)throw fail('未知的快捷查询。');
    const command=preset?preset.command:String(input.command||'').trim().replace(/^\//,'');
    if(!command||/[\r\n\0]/.test(command)||Buffer.byteLength(command)>1024)throw fail('请输入一条命令，不超过 1024 字节。');
    if(!preset&&isTaskBusy())throw fail('执行自定义命令前，请先暂停机器人任务。快捷查询仍可使用。',409);
    const id=randomUUID(),started=Date.now(),current=client;
    busy=true;status='正在执行…';notify();
    const record={id,timestamp:new Date().toISOString(),command:trace.sanitize(command),kind:preset?'query':'manual',status:'pending'};
    history=[...history,record].slice(-50);
    try{
      const output=await trace.run({rconCommandId:id},()=>trace.span('rcon.command',{host,port,command},()=>current.send(command)));
      record.output=trace.sanitize(output);record.status='response';status=connected?'已收到服务器响应':'连接已关闭';
    }catch(error){record.output=trace.sanitize(error.message);record.status='error';status='执行未确认，请查看返回结果';throw fail(record.output,502);}
    finally{record.elapsedMs=Date.now()-started;busy=false;notify();}
    return state();
  }
  return {state,connect,disconnect,execute};
}
function installRconRoutes(app,console){
  app.use('/api/rcon',(req,res,next)=>{
    const host=req.headers.host||'',address=req.socket.remoteAddress||'';
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address))return res.status(403).json({error:'RCON 控制台仅允许本机访问。'});
    if(req.headers.origin&&req.headers.origin!==`http://${host}`)return res.status(403).json({error:'RCON 不接受跨站请求。'});
    if(req.method==='POST'&&(req.headers['x-rcon-console']!=='1'||!req.is('application/json')))return res.status(403).json({error:'无效的 RCON 控制请求。'});
    res.set('Cache-Control','no-store');next();
  });
  app.get('/api/rcon/state',(req,res)=>res.json(console.state()));
  for(const [name,handler] of Object.entries({connect:console.connect,disconnect:console.disconnect,command:console.execute})){
    app.post('/api/rcon/'+name,async(req,res)=>{
      try{res.json(await handler(req.body));}
      catch(error){trace.event('rcon.control-error',{action:name,error});res.status(error.status||500).json({error:trace.sanitize(error.message),state:console.state()});}
    });
  }
}
module.exports={createRconConsole,installRconRoutes,presetsFor};
