import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { cleanTitle, RoomManager } from './rooms.js';
import { MAX_SHEET_BYTES, SheetStore } from './sheets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// 브라우저에서 PDF 악보를 이미지로 바꿀 때 쓰는 pdf.js (인터넷 없는 합주실에서도 동작하도록 직접 제공)
const VENDOR = {
  '/vendor/pdf.min.mjs': path.join(ROOT, 'node_modules/pdfjs-dist/build/pdf.min.mjs'),
  '/vendor/pdf.worker.min.mjs': path.join(ROOT, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, file) {
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

function serveStatic(req, res, pathname) {
  if (VENDOR[pathname]) {
    serveFile(res, VENDOR[pathname]);
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
  serveFile(res, file);
}

const LIVE_ERRORS = {
  TOO_LATE: '이미 지나간 파트는 바꿀 수 없어요.',
  STALE: '송폼이 방금 바뀌었어요. 다시 시도해 주세요.',
  NOTHING_NEXT: '이 곡에 남은 다음 파트가 없어요.',
  NOT_IN_SECTION: '파트가 시작된 뒤에 반복할 수 있어요.',
  NOT_PLAYING: '재생 중이 아니에요.',
  TOO_MANY: '더 늘릴 수 없어요.',
};

const cleanName = (v) => (typeof v === 'string' ? v.trim().slice(0, 24) : '') || '멤버';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createServer({ dataDir = process.env.DATA_DIR || path.resolve('data') } = {}) {
  const sheets = new SheetStore(path.join(dataDir, 'sheets'));

  // PUT /api/sheets/:id?room=CODE  (x-host-token 헤더 필요) — 방장만 업로드
  async function uploadSheet(req, res, id, url) {
    const room = rooms.get(url.searchParams.get('room'));
    if (!room) return json(res, 404, { error: 'ROOM_NOT_FOUND' });
    const allowed = req.headers['x-host-token'] === room.hostToken || room.canControlKey(req.headers['x-client-key']);
    if (!allowed) return json(res, 403, { error: 'NOT_HOST' });
    let buf;
    try {
      buf = await readBody(req, MAX_SHEET_BYTES);
    } catch {
      return json(res, 413, { error: 'TOO_LARGE' });
    }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    const err = sheets.put(id, room.code, type, buf);
    if (err) return json(res, err === 'ROOM_FULL' ? 507 : 400, { error: err });
    return json(res, 200, { ok: true });
  }

  function serveSheet(req, res, id) {
    const meta = sheets.get(id);
    if (!meta) {
      res.writeHead(404).end();
      return;
    }
    const headers = {
      'content-type': meta.type,
      'content-length': meta.size,
      // 같은 id의 내용은 바뀌지 않는다
      'cache-control': 'public, max-age=31536000, immutable',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, headers).end();
      return;
    }
    fs.createReadStream(sheets.file(id)).on('error', () => res.destroy()).pipe(res.writeHead(200, headers));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    const sheetUpload = pathname.match(/^\/api\/sheets\/([a-f0-9]{32})$/);
    if (sheetUpload && req.method === 'PUT') {
      uploadSheet(req, res, sheetUpload[1], url);
      return;
    }
    // 홈 화면 "내 방" 상태: /api/rooms?codes=ABCD,EFGH
    if (pathname === '/api/rooms' && req.method === 'GET') {
      const codes = String(url.searchParams.get('codes') || '').split(',').slice(0, 50);
      const out = {};
      for (const c of codes) {
        const room = rooms.get(c);
        if (room) out[room.code] = room.summary();
      }
      json(res, 200, out);
      return;
    }
    const sheet = pathname.match(/^\/sheets\/([a-f0-9]{32})$/);
    if (sheet && (req.method === 'GET' || req.method === 'HEAD')) {
      serveSheet(req, res, sheet[1]);
      return;
    }
    serveStatic(req, res, pathname);
  });
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

  const rooms = new RoomManager((room) => {
    broadcast(room);
    rooms.save();
  }, (code) => sheets.removeRoom(code), { file: path.join(dataDir, 'rooms.json') });
  const sweeper = setInterval(() => rooms.sweep(), 60 * 1000);
  sweeper.unref();

  const leave = (client) => {
    const room = client.room;
    if (!room) return;
    client.room = null;
    room.removeMember(client.id);
    broadcast(room);
    rooms.save();
  };

  const enter = (client, room, msg, hostToken) => {
    leave(client);
    client.room = room;
    const isHost = room.addMember(client, cleanName(msg.name), hostToken, msg.key);
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
    title(room, msg) {
      room.title = cleanTitle(msg.title) || room.title;
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
    split(room, msg) {
      room.setSubdivision(Number(msg.songIndex), msg.subdivision);
    },
    live(room, msg, client) {
      const err = room.live(msg);
      if (err) send(client.ws, { type: 'error', code: err, message: LIVE_ERRORS[err] || '송폼을 바꿀 수 없어요.' });
    },
    owner_cohost(room, msg) {
      room.setCoHost(msg.to, !!msg.on);
    },
    owner_transfer(room, msg, client) {
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
        // 방을 만든 사람이 방장. code+hostToken이 있으면 닫힌 방을 같은 코드로 다시 연다.
        const existing = rooms.get(msg.code);
        if (existing && msg.hostToken && existing.hostToken === msg.hostToken) {
          enter(client, existing, msg, msg.hostToken);
          return;
        }
        const room = rooms.create(msg.setlist, { code: msg.code, hostToken: msg.hostToken, title: msg.title });
        enter(client, room, msg, room.hostToken);
        return;
      }
      case 'join': {
        const room = rooms.get(msg.code);
        if (!room) {
          send(client.ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: '방을 찾을 수 없어요.' });
          return;
        }
        enter(client, room, msg, msg.hostToken);
        return;
      }
      case 'leave':
        leave(client);
        return;
      default: {
        // owner_* 는 방장만, 나머지는 방장·부방장
        if (msg.type.startsWith('owner_')) return;
        const ownerOnly = ['cohost', 'transfer'].includes(msg.type);
        const action = hostActions[ownerOnly ? `owner_${msg.type}` : msg.type];
        const room = client.room;
        if (!action || !room) return;
        if (ownerOnly ? !room.isHost(client.id) : !room.canControl(client.id)) {
          send(client.ws, { type: 'error', code: 'NOT_HOST', message: ownerOnly ? '방장만 할 수 있어요.' : '방장·부방장만 할 수 있어요.' });
          return;
        }
        action(room, msg, client);
        broadcast(room);
        rooms.save();
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
    rooms.saveNow();
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
