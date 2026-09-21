const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveBotIdentity}=require('../src/bot-identity.cjs');
const {createRconConsole,presetsFor}=require('../src/rcon-console.cjs');
const {resetCommands}=require('../src/flag-reset.cjs');
const nic=(mac,internal=false)=>({mac,internal,family:'IPv4'});
function cache(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bot-identity-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return path.join(directory,'identity.json');}
test('machine alias is deterministic, legal and does not persist the raw MAC',t=>{
 const cacheFile=cache(t),interfaces={Ethernet:[nic('00:11:22:33:44:55')]};
 const first=resolveBotIdentity({interfaces,cacheFile}),second=resolveBotIdentity({interfaces,cacheFile});
 assert.deepEqual(first,second);assert.match(first.username,/^TypeSafeBot[A-Z0-9]{5}$/);assert.equal(first.username.length,16);
 assert.ok(!fs.readFileSync(cacheFile,'utf8').includes('00:11:22:33:44:55'));
});
test('different machine MACs produce different aliases in representative fixtures',t=>{
 const a=resolveBotIdentity({interfaces:{Ethernet:[nic('00:11:22:33:44:55')]},cacheFile:cache(t)});
 const b=resolveBotIdentity({interfaces:{Ethernet:[nic('00:11:22:33:44:66')]},cacheFile:cache(t)});
 assert.notEqual(a.username,b.username);
});
test('adapter order and duplicate IPv6 entries do not change the alias',t=>{
 const physical=nic('00:11:22:33:44:55'),virtual=nic('02:22:33:44:55:66');
 const a=resolveBotIdentity({interfaces:{VPN:[virtual],Ethernet:[physical,{...physical,family:'IPv6'}]},cacheFile:cache(t)});
 const b=resolveBotIdentity({interfaces:{Ethernet:[{...physical,mac:'00-11-22-33-44-55'}],VPN:[virtual]},cacheFile:cache(t)});
 assert.equal(a.username,b.username);
});
test('cached adapter identity survives adding another adapter and a cloned cache is rebound',t=>{
 const cacheFile=cache(t),original=nic('00:11:22:33:44:55'),extra=nic('00:00:12:34:56:78');
 const a=resolveBotIdentity({interfaces:{Ethernet:[original]},cacheFile});
 const b=resolveBotIdentity({interfaces:{Other:[extra],Ethernet:[original]},cacheFile});assert.equal(a.username,b.username);
 const cloned=resolveBotIdentity({interfaces:{Other:[extra]},cacheFile});assert.notEqual(a.username,cloned.username);
});
test('invalid adapters fail closed instead of reusing a copied identity',t=>{
 const cacheFile=cache(t);
 resolveBotIdentity({interfaces:{Ethernet:[nic('00:11:22:33:44:55')]},cacheFile});
 assert.throws(()=>resolveBotIdentity({interfaces:{Loop:[nic('00:11:22:33:44:55',true)],Invalid:[nic('00:00:00:00:00:00'),nic('ff:ff:ff:ff:ff:ff'),nic('garbage')]},cacheFile}),/No usable/);
});
test('corrupt cached alias is regenerated from the MAC rather than used in commands',t=>{
 const cacheFile=cache(t);fs.writeFileSync(cacheFile,'{broken');
 const identity=resolveBotIdentity({interfaces:{Ethernet:[nic('00:11:22:33:44:55')]},cacheFile});
 const saved=JSON.parse(fs.readFileSync(cacheFile));saved.username='@a';fs.writeFileSync(cacheFile,JSON.stringify(saved));
 assert.equal(resolveBotIdentity({interfaces:{Ethernet:[nic('00:11:22:33:44:55')]},cacheFile}).username,identity.username);
});
test('RCON query targets follow each instance identity and reject command injection',()=>{
 const a=createRconConsole({botUsername:'TypeSafeBot00001',env:{}}).state();
 const b=createRconConsole({botUsername:'TypeSafeBot00002',env:{}}).state();
 assert.equal(a.botUsername,'TypeSafeBot00001');assert.equal(a.presets.position.command,'data get entity TypeSafeBot00001 Pos');
 assert.equal(b.presets.inventory.command,'data get entity TypeSafeBot00002 Inventory');
 assert.throws(()=>presetsFor('@a'));assert.throws(()=>presetsFor('bot\nstop'));
});
test('flag reset targets only the expected generated identity and preserves site restrictions',()=>{
 const name='TypeSafeBot00001',origin={x:64,y:64,z:64};
 const commands=resetCommands(origin,name,25576,'127.0.0.1',true,name);
 assert.ok(commands.includes('tp '+name+' 61.5 64 70.5'));assert.ok(commands.includes('give '+name+' minecraft:red_wool 234'));
 assert.ok(commands.every(c=>!c.includes('TypeSafeExplorer')));
 assert.throws(()=>resetCommands(origin,'TypeSafeBot00002',25576,'127.0.0.1',false,name));
 assert.throws(()=>resetCommands(origin,name,25575,'127.0.0.1',false,name));
 assert.throws(()=>resetCommands(origin,name,25576,'example.com',false,name));
 assert.throws(()=>resetCommands({...origin,x:65},name,25576,'127.0.0.1',false,name));
 assert.throws(()=>resetCommands(origin,'@a',25576,'127.0.0.1',false,'@a'));
});
