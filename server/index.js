import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    }).end(data);
  });
}

const cleanName = (v) => (typeof v === 'string' ? v.trim().slice(0, 24) : '') || '멤버';

export function createServer() {
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (room) => {
    const msg = JSON.stringify({ type: 'state', state: room.publicState() });
    for (const { client } of room.members.values()) {
      if (client.ws.readyState === client.ws.OPEN) client.ws.send(msg);
    }
  };

  const rooms = new RoomManager(broadcast);
  const sweeper = setInterval(() => rooms.sweep(), 60 * 1000);
  sweeper.unref();

  const leave = (client) => {
    const room = client.room;
    if (!room) return;
    client.room = null;
    room.removeMember(client.id);
    broadcast(room);
  };

  const enter = (client, room, name, hostToken) => {
    leave(client);
    client.room = room;
    const isHost = room.addMember(client, cleanName(name), hostToken);
    send(client.ws, {
      type: 'joined',
      you: client.id,
      code: room.code,
      hostToken: isHost ? room.hostToken : null,
    });
    broadcast(room);
  };

  const hostActions = {
    setlist(room, msg) {
      room.setSetlist(msg.setlist);
    },
    settings(room, msg) {
      room.updateSettings(msg);
    },
    select(room, msg) {
      room.select(msg.songIndex, msg.sectionIndex);
    },
    play(room, msg) {
      room.play({ songIndex: msg.songIndex, sectionIndex: msg.sectionIndex });
    },
    stop(room) {
      room.stop();
    },
    transfer(room, msg, client) {
      const newToken = room.transferHost(msg.to);
      if (!newToken) return;
      const target = room.members.get(msg.to).client;
      send(target.ws, { type: 'host', hostToken: newToken });
      send(client.ws, { type: 'host', hostToken: null });
    },
  };

  const handle = (client, msg) => {
    switch (msg.type) {
      case 'ping':
        send(client.ws, { type: 'pong', t0: msg.t0, ts: Date.now() });
        return;
      case 'create': {
        // 방을 만든 사람이 방장
        const room = rooms.create(msg.setlist);
        enter(client, room, msg.name, room.hostToken);
        return;
      }
      case 'join': {
        const room = rooms.get(msg.code);
        if (!room) {
          send(client.ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: '방을 찾을 수 없어요.' });
          return;
        }
        enter(client, room, msg.name, msg.hostToken);
        return;
      }
      case 'leave':
        leave(client);
        return;
      default: {
        const action = hostActions[msg.type];
        const room = client.room;
        if (!action || !room) return;
        if (!room.isHost(client.id)) {
          send(client.ws, { type: 'error', code: 'NOT_HOST', message: '방장만 할 수 있어요.' });
          return;
        }
        action(room, msg, client);
        broadcast(room);
      }
    }
  };

  wss.on('connection', (ws) => {
    const client = { id: Math.random().toString(36).slice(2, 10), ws, room: null };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      handle(client, msg);
    });
    ws.on('close', () => leave(client));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30 * 1000);
  heartbeat.unref();

  server.on('close', () => {
    clearInterval(sweeper);
    clearInterval(heartbeat);
    for (const room of rooms.rooms.values()) room.dispose();
  });

  return { server, wss, rooms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createServer();
  server.listen(port, () => {
    console.log(`Brief 서버 실행 중: http://localhost:${port}`);
  });
}
