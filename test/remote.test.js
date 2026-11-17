import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { createServer, pullRemote } from '../server/index.js';
import { RemoteStore } from '../server/remote.js';

/** Supabase Storage API를 흉내 내는 작은 서버 */
function fakeSupabase(key) {
  const buckets = new Set();
  const objects = new Map(); // "bucket/path" -> { buf, type }
  const server = http.createServer(async (req, res) => {
    if (req.headers.apikey !== key) return res.writeHead(401).end('no key');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let m;
    if ((m = u.match(/^\/storage\/v1\/bucket\/([^/]+)$/)) && req.method === 'GET') {
      return res.writeHead(buckets.has(m[1]) ? 200 : 404).end('{}');
    }
    if (u === '/storage/v1/bucket' && req.method === 'POST') {
      const { id, public: pub } = JSON.parse(body);
      assert.equal(pub, false, '버킷은 비공개');
      buckets.add(id);
      return res.writeHead(200).end('{}');
    }
    if ((m = u.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/))) {
      const k = `${m[1]}/${m[2]}`;
      if (req.method === 'POST') {
        if (!buckets.has(m[1])) return res.writeHead(404).end();
        objects.set(k, { buf: body, type: req.headers['content-type'] });
        return res.writeHead(200).end('{}');
      }
      if (req.method === 'GET') {
        const o = objects.get(k);
        return o ? res.writeHead(200, { 'content-type': o.type }).end(o.buf) : res.writeHead(400).end('not found');
      }
    }
    if ((m = u.match(/^\/storage\/v1\/object\/([^/]+)$/)) && req.method === 'DELETE') {
      for (const p of JSON.parse(body).prefixes) objects.delete(`${m[1]}/${p}`);
      return res.writeHead(200).end('[]');
    }
    return res.writeHead(404).end();
  });
  return { server, objects, buckets };
}

const listen = (s) => new Promise((r) => s.listen(0, () => r(s.address().port)));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'echad-remote-'));

test('Supabase 저장소: 서버 디스크가 다 지워져도 방과 악보가 돌아온다', async () => {
  const KEY = 'sb_secret_test';
  const supa = fakeSupabase(KEY);
  const supaPort = await listen(supa.server);
  const remote = new RemoteStore({ url: `http://127.0.0.1:${supaPort}`, key: KEY });

  // 1) 첫 서버: 버킷 만들기 → 방 만들기 → 악보 올리기
  const dirA = tmp();
  await pullRemote(remote, dirA);
  assert.ok(supa.buckets.has('echad'));
  const a = createServer({ dataDir: dirA, remote });
  const portA = await listen(a.server);
  const ws = new WebSocket(`ws://127.0.0.1:${portA}/ws`);
  await new Promise((r) => ws.on('open', r));
  const joined = new Promise((r) => ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'joined') r(m); }));
  ws.send(JSON.stringify({ type: 'create', name: 'H', title: '청년부', setlist: [{ title: '주 은혜임을' }] }));
  const { code, hostToken } = await joined;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
  const id = 'c'.repeat(32);
  const up = await fetch(`http://127.0.0.1:${portA}/api/sheets/${id}?room=${code}`, {
    method: 'PUT', headers: { 'content-type': 'image/png', 'x-host-token': hostToken }, body: png,
  });
  assert.equal(up.status, 200);
  a.rooms.saveNow();
  await remote.flush();
  assert.ok(supa.objects.has('echad/rooms.json'));
  assert.ok(supa.objects.has(`echad/sheets/${id}`));
  assert.ok(supa.objects.has('echad/sheets/index.json'));
  ws.close();
  a.server.closeAllConnections?.();
  await new Promise((r) => a.server.close(r));

  // 2) 디스크가 통째로 지워진 새 서버 (Render 무료 요금제 재시작)
  fs.rmSync(dirA, { recursive: true, force: true });
  const dirB = tmp();
  const got = await pullRemote(remote, dirB);
  assert.deepEqual(got, { rooms: true, sheets: true });
  const b = createServer({ dataDir: dirB, remote });
  const portB = await listen(b.server);
  const room = b.rooms.get(code);
  assert.ok(room, '방이 돌아왔다');
  assert.equal(room.title, '청년부');
  assert.equal(room.hostToken, hostToken, '방장도 그대로');
  // 악보는 처음 볼 때 Supabase에서 내려받는다
  assert.equal((await fetch(`http://127.0.0.1:${portB}/sheets/${id}`, { method: 'HEAD' })).status, 200);
  const sheet = await fetch(`http://127.0.0.1:${portB}/sheets/${id}`);
  assert.equal(sheet.status, 200);
  assert.deepEqual(Buffer.from(await sheet.arrayBuffer()), png);
  assert.ok(fs.existsSync(path.join(dirB, 'sheets', id)), '한 번 받은 뒤엔 서버 디스크에도 둔다');

  b.server.closeAllConnections?.();
  await new Promise((r) => b.server.close(r));
  await new Promise((r) => supa.server.close(r));
  fs.rmSync(dirB, { recursive: true, force: true });
});

test('Supabase 설정이 없으면 꺼져 있다', () => {
  assert.equal(RemoteStore.fromEnv({}), null);
  assert.equal(RemoteStore.fromEnv({ SUPABASE_URL: 'https://x.supabase.co' }), null);
  const r = RemoteStore.fromEnv({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_KEY: 'eyJabc' });
  assert.equal(r.base, 'https://x.supabase.co/storage/v1');
  assert.equal(r.headers().authorization, 'Bearer eyJabc', '예전 service_role 키는 Authorization도');
  assert.equal(RemoteStore.fromEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret_x' }).headers().authorization, undefined);
});
