const net=require('node:net');
const {EventEmitter}=require('node:events');

function packet(id,type,text=''){
  const body=Buffer.from(text,'utf8'),frame=Buffer.alloc(body.length+14);
  frame.writeInt32LE(body.length+10,0);frame.writeInt32LE(id,4);frame.writeInt32LE(type,8);body.copy(frame,12);
  return frame;
}
class RconClient extends EventEmitter {
  constructor({host,port,password,timeout=8000,maxOutputBytes=262144}){
    super();Object.assign(this,{host,port,password,timeout,maxOutputBytes});
    this.buffer=Buffer.alloc(0);this.nextId=1;this.connected=false;this.pending=null;this.socket=null;
  }
  connect(){
    if(this.socket)throw new Error('RCON already connected or connecting');
    return new Promise((resolve,reject)=>{
      const id=this.nextId++;
      this.pending={kind:'auth',id,resolve,reject};
      this.socket=net.createConnection({host:this.host,port:this.port});
      this.socket.setNoDelay(true);
      this.timer=setTimeout(()=>this.fail(new Error('RCON connection/authentication timeout')),this.timeout);
      this.socket.once('connect',()=>this.socket.write(packet(id,3,this.password)));
      this.socket.on('data',chunk=>this.receive(chunk));
      this.socket.on('error',error=>this.fail(error));
      this.socket.on('close',()=>{
        this.connected=false;this.rejectPending(new Error('RCON connection closed; command outcome may be unknown'));
        this.socket=null;this.emit('end');
      });
    });
  }
  rejectPending(error){
    clearTimeout(this.timer);
    const pending=this.pending;this.pending=null;pending?.reject(error);
  }
  fail(error){this.rejectPending(error);this.connected=false;this.socket?.destroy();}
  disconnect(){this.fail(new Error('RCON disconnected; an in-flight command is not retried'));this.password='';}
  receive(chunk){
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=4){
      const length=this.buffer.readInt32LE(0);
      if(length<10||length>1048576){this.fail(new Error('Invalid RCON packet length'));return;}
      if(this.buffer.length<length+4)return;
      const frame=this.buffer.subarray(0,length+4);this.buffer=this.buffer.subarray(length+4);
      if(frame.at(-1)!==0||frame.at(-2)!==0){this.fail(new Error('Invalid RCON packet terminator'));return;}
      const id=frame.readInt32LE(4),type=frame.readInt32LE(8),body=frame.subarray(12,-2),pending=this.pending;
      if(!pending)continue;
      if(pending.kind==='auth'){
        // Some servers send an empty value packet before the authentication response.
        if(type!==2)continue;
        if(id===-1||id!==pending.id){this.fail(new Error('RCON authentication failed'));return;}
        clearTimeout(this.timer);this.pending=null;this.connected=true;this.password='';pending.resolve();
      }else if(id===pending.id){
        pending.bytes+=body.length;
        if(pending.bytes>this.maxOutputBytes){this.fail(new Error('RCON response exceeded 256 KiB; command is not retried'));return;}
        pending.parts.push(body);
        // Vanilla rejects multiple requests in one socket read. Wait for the
        // first complete response before sending our completion query; separate
        // write() calls alone can still be coalesced by TCP.
        if(!pending.markerSent){
          pending.markerSent=true;
          this.socket.write(packet(pending.marker,2,'list'));
        }
      }else if(id===pending.marker){
        // Minecraft processes commands in order. A read-only list query marks the
        // end of the preceding response, including all its fragmented packets.
        clearTimeout(this.timer);this.pending=null;
        pending.resolve(Buffer.concat(pending.parts).toString('utf8'));
      }
    }
  }
  send(command){
    if(!this.connected)return Promise.reject(new Error('RCON is not connected'));
    if(this.pending)return Promise.reject(new Error('Another RCON operation is in progress'));
    return new Promise((resolve,reject)=>{
      const id=this.nextId++,marker=this.nextId++;
      this.pending={kind:'command',id,marker,resolve,reject,parts:[],bytes:0};
      this.timer=setTimeout(()=>this.fail(new Error('RCON response timeout; command may have executed and is not retried')),this.timeout);
      this.socket.write(packet(id,2,command));
    });
  }
}
module.exports={RconClient,packet};
