const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = 20;
const ROOM_NAME = 'server-1';

const MAX_HP = 100;
const RESPAWN_MS = 3000;

// PvP 공격 쿨다운
const pvpCooldown = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      ok:true,
      room:ROOM_NAME,
      players:players.size
    }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = path.join(__dirname, 'index.html');

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500, {'Content-Type':'text/plain'});
        res.end('index.html not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type':'text/html; charset=utf-8'
      });

      res.end(data);
    });

    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain'});
  res.end('Not found');
});

const wss = new WebSocket.Server({server});

const players = new Map();

function cleanNickname(value){
  return String(value || '플레이어')
    .replace(/[<>]/g,'')
    .trim()
    .slice(0,16) || '플레이어';
}

function cleanCarType(value){
  const allowed = [
    '슈퍼카',
    '머슬카',
    'SUV',
    '픽업트럭',
    '밴',
    '해치백',
    '쿠페',
    '택시'
  ];

  return allowed.includes(value) ? value : '슈퍼카';
}

function publicPlayer(p){
  const remaining = p.deadUntil
    ? Math.max(0, p.deadUntil - Date.now())
    : 0;

  return {
    id:p.id,
    nickname:p.nickname,
    carType:p.carType,
    x:p.x,
    z:p.z,
    ry:p.ry,
    speed:p.speed,
    hp:p.hp,
    dead:p.deadUntil > Date.now(),
    respawnIn:remaining
  };
}

function broadcastPlayers(){
  const payload = JSON.stringify({
    type:'players',
    players:[...players.values()].map(publicPlayer)
  });

  for(const p of players.values()){
    if(p.ws.readyState === WebSocket.OPEN){
      p.ws.send(payload);
    }
  }
}

function sendToPlayer(p,data){
  if(p && p.ws.readyState === WebSocket.OPEN){
    p.ws.send(JSON.stringify(data));
  }
}

function broadcast(data){
  const payload = JSON.stringify(data);

  for(const p of players.values()){
    if(p.ws.readyState === WebSocket.OPEN){
      p.ws.send(payload);
    }
  }
}

function distance(a,b){
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx*dx + dz*dz);
}

function weaponDamage(type){
  // 0 = 차량 충돌
  // 1 = 미사일
  // 2 = 기관총

  if(type === 1) return 25;
  if(type === 2) return 7;
  return 12;
}

function tryPvPDamage(attacker,target,weaponType){

  if(!attacker || !target) return;

  if(attacker.id === target.id) return;

  if(target.deadUntil > Date.now()) return;

  if(attacker.deadUntil > Date.now()) return;

  // 너무 먼 거리에서 데미지를 주는 것 방지
  if(distance(attacker,target) > 120) return;

  const key = attacker.id + ':' + target.id + ':' + weaponType;
  const now = Date.now();

  const last = pvpCooldown.get(key) || 0;

  // 최소 공격 간격
  if(now - last < 100) return;

  pvpCooldown.set(key,now);

  const damage = weaponDamage(weaponType);

  target.hp = Math.max(0,target.hp - damage);

  // 피해 결과 전달
  sendToPlayer(target,{
    type:'pvp_damage',
    targetId:target.id,
    attackerId:attacker.id,
    hp:target.hp,
    amount:damage,
    weaponType:weaponType
  });

  // 다른 플레이어들에게도 HP 상태 전달
  broadcastPlayers();

  // 사망
  if(target.hp <= 0){

    target.hp = 0;
    target.deadUntil = Date.now() + RESPAWN_MS;

    broadcast({
      type:'pvp_death',
      victimId:target.id,
      killerId:attacker.id,
      respawnMs:RESPAWN_MS
    });

    // 처치자 내구도 +15
    sendToPlayer(attacker,{
      type:'pvp_kill_reward',
      killerId:attacker.id,
      amount:15
    });

    // 3초 후 부활
    setTimeout(() => {

      if(!players.has(target.id)) return;

      target.hp = MAX_HP;
      target.deadUntil = 0;

      sendToPlayer(target,{
        type:'pvp_respawn',
        hp:MAX_HP
      });

      broadcastPlayers();

    },RESPAWN_MS);
  }
}

wss.on('connection', ws => {

  if(players.size >= MAX_PLAYERS){

    ws.send(JSON.stringify({
      type:'error',
      message:'서버 1이 가득 찼습니다.'
    }));

    ws.close();
    return;
  }

  const id =
    Math.random().toString(36).slice(2,10) +
    Date.now().toString(36).slice(-4);

  const player = {
    id,
    ws,
    room:ROOM_NAME,

    nickname:'플레이어',
    carType:'슈퍼카',

    x:0,
    z:0,
    ry:0,
    speed:0,

    hp:MAX_HP,
    deadUntil:0
  };

  players.set(id,player);

  ws.send(JSON.stringify({
    type:'welcome',
    id,
    room:ROOM_NAME,
    count:players.size
  }));

  broadcastPlayers();

  ws.on('message', raw => {

    let msg;

    try{
      msg = JSON.parse(raw.toString());
    }catch{
      return;
    }

    // -------------------------
    // 입장
    // -------------------------

    if(msg.type === 'join'){

      player.nickname = cleanNickname(msg.nickname);
      player.carType = cleanCarType(msg.carType);

      player.x =
        Number.isFinite(Number(msg.x))
          ? Number(msg.x)
          : 0;

      player.z =
        Number.isFinite(Number(msg.z))
          ? Number(msg.z)
          : 0;

      player.ry =
        Number.isFinite(Number(msg.ry))
          ? Number(msg.ry)
          : 0;

      player.hp = MAX_HP;
      player.deadUntil = 0;

      broadcastPlayers();

      return;
    }

    // -------------------------
    // 차량 상태
    // -------------------------

    if(msg.type === 'state'){

      player.nickname = cleanNickname(msg.nickname);
      player.carType = cleanCarType(msg.carType);

      const x = Number(msg.x);
      const z = Number(msg.z);
      const ry = Number(msg.ry);
      const speed = Number(msg.speed);

      if(Number.isFinite(x)){
        player.x = Math.max(-1100,Math.min(1100,x));
      }

      if(Number.isFinite(z)){
        player.z = Math.max(-1100,Math.min(1100,z));
      }

      if(Number.isFinite(ry)){
        player.ry = ry;
      }

      if(Number.isFinite(speed)){
        player.speed =
          Math.max(-100,Math.min(100,speed));
      }

      broadcastPlayers();

      return;
    }

    // -------------------------
    // PvP 데미지
    // -------------------------

    if(msg.type === 'pvp_damage'){

      const target =
        players.get(String(msg.targetId));

      if(!target) return;

      let weaponType = Number(msg.weaponType);

      if(
        weaponType !== 0 &&
        weaponType !== 1 &&
        weaponType !== 2
      ){
        weaponType = 2;
      }

      tryPvPDamage(
        player,
        target,
        weaponType
      );

      return;
    }

    // -------------------------
    // 기존 클라이언트의 kill 메시지는
    // 서버에서 따로 처리하지 않는다.
    // 서버가 직접 처치 판정을 하기 때문.
    // -------------------------

    if(msg.type === 'pvp_kill'){
      return;
    }

    // -------------------------
    // 채팅
    // -------------------------

    if(msg.type === 'chat'){

      const message =
        String(msg.message || '')
          .trim()
          .slice(0,100);

      if(!message) return;

      const chat = {
        type:'chat',
        id:player.id,
        name:player.nickname,
        message
      };

      broadcast(chat);

      return;
    }

  });

  ws.on('close',() => {

    players.delete(id);

    // 해당 플레이어의 PvP 쿨다운 삭제
    for(const key of pvpCooldown.keys()){

      if(key.startsWith(id + ':')){
        pvpCooldown.delete(key);
      }
    }

    broadcastPlayers();
  });

  ws.on('error',() => {

    players.delete(id);

    broadcastPlayers();
  });

});

// 20회/초 상태 전송
setInterval(() => {

  broadcastPlayers();

  // 오래된 쿨다운 정리
  const now = Date.now();

  for(const [key,time] of pvpCooldown){

    if(now - time > 5000){
      pvpCooldown.delete(key);
    }
  }

},50);

server.listen(PORT,() => {

  console.log(
    `Drive 3D Server 1 listening on port ${PORT}`
  );

});
