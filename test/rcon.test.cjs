const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net'),{once}=require('node:events'),express=require('express');
const {RconClient,packet}=require('../src/rcon-client.cjs');
const {createRconConsole,installRconRoutes}=require('../src/rcon-console.cjs');
const {trace}=require('../src/trace.cjs');

async function server(t,{secret='test-only-password',reject=false,hang=false,onCommand=()=>{}}={}){
 const received=[],sockets=new Set();
 const service=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffer=Buffer.alloc(0);
  socket.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   while(buffer.length>=4&&buffer.length>=buffer.readInt32LE(0)+4){
    const size=buffer.readInt32LE(0),frame=buffer.subarray(0,size+4);buffer=buffer.subarray(size+4);
    const id=frame.readInt32LE(4),type=frame.readInt32LE(8),text=frame.subarray(12,-2).toString('utf8');
    if(type===3){assert.equal(text,secret);socket.write(packet(id,0));socket.write(packet(reject?-1:id,2));}
    else {received.push(text);onCommand(text);if(hang)continue;
     const reply=text==='list'?packet(id,0,'players'):Buffer.concat([packet(id,0,'first '),packet(id,0,'第二段 <script>alert(1)</script>')]);
     socket.write(reply.subarray(0,7));socket.write(reply.subarray(7));
    }
   }
  });
 });
 service.listen(0,'127.0.0.1');await once(service,'listening');
 t.after(()=>{for(const socket of sockets)socket.destroy();service.close();});
 return {host:'127.0.0.1',port:service.address().port,password:secret,received};
}
test('RCON authenticates, handles split frames and assembles multi-packet UTF-8 output',async t=>{
 const options=await server(t),client=new RconClient(options);t.after(()=>client.disconnect());
 await client.connect();assert.equal(client.connected,true);
 assert.equal(await client.send('help'),'first 第二段 <script>alert(1)</script>');
 assert.deepEqual(options.received,['help','list']);
});
test('RCON rejects invalid credentials',async t=>{
 const options=await server(t,{reject:true}),client=new RconClient(options);t.after(()=>client.disconnect());
 await assert.rejects(client.connect(),/authentication failed/);assert.equal(client.connected,false);
});
test('RCON waits for a complete response before its marker on vanilla-style servers',async t=>{
 const received=[],sockets=new Set();let allowNext=true;
 const service=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  socket.on('data',frame=>{
   // Reproduce vanilla's one-request-per-read requirement, and reject a
   // premature marker even if TCP happened to split the writes.
   if(frame.length<14||frame.readInt32LE(0)!==frame.length-4||!allowNext){socket.destroy();return;}
   const id=frame.readInt32LE(4),type=frame.readInt32LE(8),command=frame.subarray(12,-2).toString();
   if(type===3){socket.write(packet(id,2));return;}
   received.push(command);
   if(command==='list'){socket.write(packet(id,0,'players'));return;}
   allowNext=false;
   const first=packet(id,0,'first ');
   socket.write(first.subarray(0,13));
   setTimeout(()=>{
    allowNext=true;
    socket.write(Buffer.concat([first.subarray(13),packet(id,0,'第二段')]));
   },20);
  });
 });
 service.listen(0,'127.0.0.1');await once(service,'listening');
 t.after(()=>{for(const socket of sockets)socket.destroy();service.close();});
 const client=new RconClient({host:'127.0.0.1',port:service.address().port,password:'test',timeout:1000});
 t.after(()=>client.disconnect());await client.connect();
 assert.equal(await client.send('help'),'first 第二段');
 assert.equal(await client.send('list'),'players');
 assert.deepEqual(received,['help','list','list','list']);
});
test('RCON timeout does not retry an uncertain command',async t=>{
 const options=await server(t,{hang:true}),client=new RconClient({...options,timeout:80});t.after(()=>client.disconnect());
 await client.connect();await assert.rejects(client.send('custom-command'),/may have executed/);
 assert.equal(options.received.filter(s=>s==='custom-command').length,1);assert.equal(client.connected,false);
});
test('RCON disconnect cancels pending work and response limit fails closed',async t=>{
 const options=await server(t),client=new RconClient({...options,maxOutputBytes:2});t.after(()=>client.disconnect());
 await client.connect();await assert.rejects(client.send('help'),/exceeded/);
 const secondOptions=await server(t,{hang:true}),second=new RconClient(secondOptions);t.after(()=>second.disconnect());
 await second.connect();const pending=second.send('help');second.disconnect();await assert.rejects(pending,/disconnected/);
});
test('console excludes passwords, enforces task guard and retains real response history',async t=>{
 const options=await server(t),console=createRconConsole({env:{},defaultHost:()=>options.host,isTaskBusy:()=>true});t.after(()=>console.disconnect());
 await console.connect(options);
 assert.ok(!JSON.stringify(console.state()).includes(options.password));
 await assert.rejects(console.execute({command:'tp TypeSafeExplorer 0 80 0'}),/先暂停/);
 const state=await console.execute({preset:'players'});assert.equal(state.history[0].output,'players');
 assert.deepEqual(options.received,['list','list']);
 await assert.rejects(console.execute({preset:'__proto__'}),/未知/);
 await assert.rejects(console.execute({command:'list\nstop'}),/一条命令/);
});
test('password reuse is restricted to the previously configured endpoint',async t=>{
 const options=await server(t),console=createRconConsole({env:{}});t.after(()=>console.disconnect());
 await console.connect(options);console.disconnect();
 await assert.rejects(console.connect({host:options.host,port:options.port+1}),/密码/);
 await console.connect({host:options.host,port:options.port});assert.equal(console.state().connected,true);
});
test('command and connection busy guard prevents concurrent sends',async t=>{
 const options=await server(t,{hang:true}),console=createRconConsole({env:{}});t.after(()=>console.disconnect());
 await console.connect(options);const pending=console.execute({preset:'players'});
 await assert.rejects(console.execute({preset:'players'}),/尚未完成/);
 await assert.rejects(console.connect(options),/稍候/);
 console.disconnect();await assert.rejects(pending);assert.equal(console.state().history[0].status,'error');
});
test('RCON HTTP rejects cross-origin, rebinding and browser form requests',async t=>{
 const app=express();app.use(express.json());const console=createRconConsole({env:{}});installRconRoutes(app,console);
 const http=app.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close());
 const base=`http://127.0.0.1:${http.address().port}`;
 assert.equal((await fetch(base+'/api/rcon/state')).status,200);
 const rebindingStatus=await new Promise((resolve,reject)=>require('node:http').get(base+'/api/rcon/state',{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
 assert.equal(rebindingStatus,403);
 const post=headers=>fetch(base+'/api/rcon/connect',{method:'POST',headers,body:'{}'});
 assert.equal((await post({'Content-Type':'application/json','X-Rcon-Console':'1',Origin:'https://attacker.example'})).status,403);
 assert.equal((await post({'Content-Type':'application/json'})).status,403);
 assert.equal((await post({'Content-Type':'application/json','X-Rcon-Console':'1',Origin:base})).status,400);
});
test('RCON password is redacted in server output and diagnostics',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rcon-trace-')),logger=trace.configure({directory});
 t.after(()=>{trace.configure();fs.rmSync(directory,{recursive:true,force:true});});
 const options=await server(t),console=createRconConsole({env:{}});t.after(()=>console.disconnect());
 await console.connect(options);await console.execute({command:'say '+options.password});
 assert.ok(!JSON.stringify(console.state()).includes(options.password));
 assert.ok(!fs.readFileSync(logger.file,'utf8').includes(options.password));
});
