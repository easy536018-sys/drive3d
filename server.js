const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = 20;
const ROOM_NAME = 'server-1';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, room:ROOM_NAME, players:players.size}));
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
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
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
  return String(value || '플레이어').replace(/[<>]/g,'').trim().slice(0,16) || '플레이어';
}

function cleanCarType(value){
  const allowed = ['슈퍼카','머슬카','SUV','픽업트럭','밴','해치백','쿠페','택시'];
  return allowed.includes(value) ? value : '슈퍼카';
}

function publicPlayer(p){
  return {
    id:p.id,
    nickname:p.nickname,
    carType:p.carType,
    x:p.x,
    z:p.z,
    ry:p.ry,
    speed:p.speed
  };
}

function broadcastPlayers(){
  const payload = JSON.stringify({
    type:'players',
    players:[...players.values()].map(publicPlayer)
  });

  for(const p of players.values()){
    if(p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
  }
}

wss.on('connection', ws => {
  if(players.size >= MAX_PLAYERS){
    ws.send(JSON.stringify({type:'error', message:'서버 1이 가득 찼습니다.'}));
    ws.close();
    return;
  }

  const id = Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);

  const player = {
    id,
    ws,
    room:ROOM_NAME,
    nickname:'플레이어',
    carType:'슈퍼카',
    x:0,
    z:0,
    ry:0,
    speed:0
  };

  players.set(id, player);

  ws.send(JSON.stringify({
    type:'welcome',
    id,
    room:ROOM_NAME,
    count:players.size
  }));

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if(msg.type === 'join'){
      player.nickname = cleanNickname(msg.nickname);
      player.carType = cleanCarType(msg.carType);
      player.x = Number.isFinite(Number(msg.x)) ? Number(msg.x) : 0;
      player.z = Number.isFinite(Number(msg.z)) ? Number(msg.z) : 0;
      player.ry = Number.isFinite(Number(msg.ry)) ? Number(msg.ry) : 0;
      broadcastPlayers();
      return;
    }

    if(msg.type === 'state'){
      // 서버에서 기본적인 값 검증만 수행하고 위치를 최신 상태로 저장한다.
      player.nickname = cleanNickname(msg.nickname);
      player.carType = cleanCarType(msg.carType);

      const x = Number(msg.x);
      const z = Number(msg.z);
      const ry = Number(msg.ry);
      const speed = Number(msg.speed);

      if(Number.isFinite(x)) player.x = Math.max(-1100, Math.min(1100, x));
      if(Number.isFinite(z)) player.z = Math.max(-1100, Math.min(1100, z));
      if(Number.isFinite(ry)) player.ry = ry;
      if(Number.isFinite(speed)) player.speed = Math.max(-100, Math.min(100, speed));
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcastPlayers();
  });

  ws.on('error', () => {
    players.delete(id);
  });
});

// 20회/초로 모든 접속자에게 최신 상태를 전송.
setInterval(broadcastPlayers, 50);

server.listen(PORT, () => {
  console.log(`Drive 3D Server 1 listening on port ${PORT}`);
});
