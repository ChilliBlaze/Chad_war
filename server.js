const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const players = new Map();
const clients = new Map();
const damageByWeapon = { rifle: 24, machinegun: 9, sniper: 72, knife: 46, bat: 38, lightsaber: 58 };
const meleeWeapons=new Set(['knife','bat','lightsaber']);
let nextId = 1;

function encodeFrame(text){
  const payload = Buffer.from(text);
  let header;
  if(payload.length < 126){
    header = Buffer.from([0x81, payload.length]);
  }else if(payload.length < 65536){
    header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(payload.length,2);
  }else{
    header = Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(payload.length),2);
  }
  return Buffer.concat([header,payload]);
}
function send(ws,obj){ if(ws && !ws.destroyed) ws.write(encodeFrame(JSON.stringify(obj))); }
function broadcast(obj, except=null){ const frame=encodeFrame(JSON.stringify(obj)); for(const ws of clients.values()) if(ws!==except && !ws.destroyed) ws.write(frame); }
function playerState(id,p){ return {id,name:p.name,kills:p.kills,p:p.p,f:p.f,u:p.u,weapon:p.weapon,aiming:p.aiming,crouch:p.crouch,sprint:p.sprint,move:p.move,thirdPerson:p.thirdPerson,health:p.health,emote:p.emote||null}; }
function cleanName(v,id){const x=String(v??'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,20);return x||id;}
function scoreboard(){return [...players.entries()].map(([id,p])=>({id,name:p.name,kills:p.kills,health:p.health})).sort((a,b)=>b.kills-a.kills||a.name.localeCompare(b.name));}
function sendScoreboard(){broadcast({type:'scoreboard',players:scoreboard()});}
function registerDeath(victimId,killerId){const victim=players.get(victimId);if(!victim)return;victim.kills=0;if(killerId&&killerId!==victimId&&players.has(killerId))players.get(killerId).kills++;sendScoreboard();}

function parseFrames(socket, chunk){
  socket._wsbuf = Buffer.concat([socket._wsbuf || Buffer.alloc(0), chunk]);
  while(socket._wsbuf.length >= 2){
    const b=socket._wsbuf; const b0=b[0], b1=b[1]; const opcode=b0&0x0f; const masked=!!(b1&0x80); let len=b1&0x7f, off=2;
    if(len===126){ if(b.length<4)return; len=b.readUInt16BE(2); off=4; }
    else if(len===127){ if(b.length<10)return; const n=b.readBigUInt64BE(2); if(n>BigInt(Number.MAX_SAFE_INTEGER)) return socket.destroy(); len=Number(n); off=10; }
    const maskLen=masked?4:0; if(b.length < off+maskLen+len)return;
    let mask=null; if(masked){mask=b.subarray(off,off+4);off+=4;}
    const payload=Buffer.from(b.subarray(off,off+len));
    if(masked) for(let i=0;i<payload.length;i++) payload[i]^=mask[i%4];
    socket._wsbuf=b.subarray(off+len);
    if(opcode===0x8){ socket.end(); return; }
    if(opcode===0x9){ // ping -> pong
      const h=Buffer.from([0x8a,payload.length]); socket.write(Buffer.concat([h,payload])); continue;
    }
    if(opcode!==0x1) continue;
    handleMessage(socket,payload.toString('utf8'));
  }
}

function handleMessage(ws, raw){
  const id=ws._playerId, p=players.get(id); if(!p)return;
  let m; try{m=JSON.parse(raw)}catch{return}
  if(m.type==='setName'){
    p.name=cleanName(m.name,id);sendScoreboard();broadcast({type:'state',player:playerState(id,p)},ws);
  }else if(m.type==='state'&&Array.isArray(m.p)&&Array.isArray(m.f)&&Array.isArray(m.u)){
    p.p=m.p.slice(0,3).map(Number);p.f=m.f.slice(0,3).map(Number);p.u=m.u.slice(0,3).map(Number);
    p.weapon=m.weapon||null;p.aiming=!!m.aiming;p.crouch=!!m.crouch;p.sprint=!!m.sprint;p.move=Number(m.move)||0;p.thirdPerson=!!m.thirdPerson;p.emote=typeof m.emote==='string'?m.emote:null;
    broadcast({type:'state',player:playerState(id,p)},ws);
  }else if(m.type==='fire'){
    broadcast({type:'fire',id,weapon:m.weapon,start:m.start,dir:m.dir},ws);
  }else if(m.type==='hit'&&players.has(m.target)){
    const target=players.get(m.target),weapon=String(m.weapon||''),dmg=damageByWeapon[weapon]||12;
    if(meleeWeapons.has(weapon)){
      if(p.weapon!==weapon)return;
      const now=Date.now();if(now-(p.lastMelee||0)<150)return;p.lastMelee=now;
      const d=Math.hypot((target.p[0]||0)-(p.p[0]||0),(target.p[1]||0)-(p.p[1]||0),(target.p[2]||0)-(p.p[2]||0));
      const reach=weapon==='knife'?2.6:weapon==='bat'?3.1:3.35;if(d>reach)return;
    }
    if(target.health>0){const before=target.health;target.health=Math.max(0,target.health-dmg);broadcast({type:'health',id:m.target,health:target.health});if(before>0&&target.health<=0)registerDeath(m.target,id);}
  }else if(m.type==='emote'){
    const ok=new Set(['wave','dance','cheer','point']);p.emote=ok.has(m.emote)?m.emote:null;broadcast({type:'state',player:playerState(id,p)},ws);
  }else if(m.type==='explode'&&Array.isArray(m.p)){
    const ep=m.p.slice(0,3).map(Number),kind=m.kind==='airbomb'?'airbomb':'grenade';
    const radius=kind==='airbomb'?5.0:5.2,maxDamage=kind==='airbomb'?115:125;
    for(const [pid,t] of players){
      if(t.health<=0)continue;
      const dx=t.p[0]-ep[0],dy=t.p[1]-ep[1],dz=t.p[2]-ep[2],d=Math.hypot(dx,dy,dz);
      if(d<radius){const dmg=maxDamage*Math.pow(1-d/radius,1.25),before=t.health;t.health=Math.max(0,t.health-dmg);broadcast({type:'health',id:pid,health:t.health});if(before>0&&t.health<=0)registerDeath(pid,id);}
    }
    broadcast({type:'effectExplosion',source:id,p:ep,kind},ws);
  }else if(m.type==='respawn'){
    p.health=100;if(Array.isArray(m.p))p.p=m.p.slice(0,3).map(Number);broadcast({type:'health',id,health:100});
  }
}

const server=http.createServer((req,res)=>{
  let url=req.url.split('?')[0];if(url==='/'||url==='/index.html')url='/game.html';
  const rel=path.normalize(url).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/,'');
  const file=path.join(ROOT,rel);
  if(!file.startsWith(ROOT)){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found');}const ext=path.extname(file);const types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.txt':'text/plain'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);});
});

server.on('upgrade',(req,socket)=>{
  const key=req.headers['sec-websocket-key']; if(!key){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const id='P'+nextId++;
  const p={name:id,kills:0,p:[0,27.65,6],f:[0,0,-1],u:[0,1,0],weapon:null,aiming:false,crouch:false,sprint:false,move:0,thirdPerson:false,health:100,emote:null,lastMelee:0};
  socket._playerId=id;socket._wsbuf=Buffer.alloc(0);players.set(id,p);clients.set(id,socket);
  send(socket,{type:'welcome',id,health:p.health,players:[...players.entries()].filter(([pid])=>pid!==id).map(([pid,pp])=>playerState(pid,pp)),scoreboard:scoreboard()});
  sendScoreboard();
  socket.on('data',chunk=>parseFrames(socket,chunk));
  const cleanup=()=>{if(clients.get(id)!==socket)return;players.delete(id);clients.delete(id);broadcast({type:'leave',id});sendScoreboard();};
  socket.on('close',cleanup);socket.on('end',cleanup);socket.on('error',cleanup);
});

server.listen(PORT,'0.0.0.0',()=>console.log(`Spherical Battlefield multiplayer server running on http://localhost:${PORT}`));
