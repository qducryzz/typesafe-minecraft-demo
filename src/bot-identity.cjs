const os=require('node:os');
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const PREFIX='TypeSafeBot';
const hash=mac=>createHash('sha256').update('typesafe-minecraft:mac:'+mac).digest('hex');
const usernameFor=macHash=>PREFIX+(BigInt('0x'+macHash)%(36n**5n)).toString(36).toUpperCase().padStart(5,'0');
function candidates(interfaces){
  const unique=new Map();
  for(const [name,addresses] of Object.entries(interfaces))for(const item of addresses||[]){
    const mac=String(item.mac||'').replace(/[:-]/g,'').toLowerCase();
    if(item.internal||!/^[0-9a-f]{12}$/.test(mac)||/^0+$/.test(mac)||(parseInt(mac.slice(0,2),16)&1))continue;
    // Prefer globally assigned addresses and ordinary network adapters. Sorting
    // makes initial selection independent of OS enumeration and IPv4/IPv6 order.
    const rank=((parseInt(mac.slice(0,2),16)&2)?2:0)+(/virtual|vethernet|docker|vbox|vmnet|vpn|tunnel|tailscale|tap/i.test(name)?1:0);
    const entry={macHash:hash(mac),rank};
    if(!unique.has(mac)||rank<unique.get(mac).rank)unique.set(mac,entry);
  }
  return [...unique.entries()].sort((a,b)=>a[1].rank-b[1].rank||a[0].localeCompare(b[0])).map(([,entry])=>entry);
}
function resolveBotIdentity({interfaces=os.networkInterfaces(),cacheFile=path.resolve(__dirname,'../runtime/bot-identity.json')}={}){
  const available=candidates(interfaces);
  if(!available.length)throw new Error('No usable network MAC address found. Enable a network adapter before starting the Minecraft bot.');
  let saved;
  try{saved=JSON.parse(fs.readFileSync(cacheFile,'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  const selected=available.find(item=>saved?.version===1&&item.macHash===saved.macHash)||available[0];
  const identity={version:1,macHash:selected.macHash,username:usernameFor(selected.macHash)};
  if(saved?.macHash!==identity.macHash||saved?.username!==identity.username||saved?.version!==1){
    fs.mkdirSync(path.dirname(cacheFile),{recursive:true});
    const temporary=cacheFile+'.'+randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify(identity,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,cacheFile);}
    finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  return {username:identity.username,source:'mac'};
}
module.exports={resolveBotIdentity};
