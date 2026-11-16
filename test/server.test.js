import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';

let server;
let url;
let http;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'));

before(async () => {
  const made = createServer({ dataDir });
  ({ server } = made);
  globalThis.__briefServer = made;
  await new Promise((r) => server.listen(0, r));
  url = `ws://127.0.0.1:${server.address().port}/ws`;
  http = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => {
  server.closeAllConnections?.();
  server.close(r);
  fs.rmSync(dataDir, { recursive: true, force: true });
}));

function client() {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    open: new Promise((r) => ws.on('open', r)),
    send: (type, data = {}) => ws.send(JSON.stringify({ type, ...data })),
    next(pred) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('timeout')), 2000);
      });
    },
    close: () => ws.close(),
  };
}

const isType = (type) => (m) => m.type === type;

test('방 생성 → 입장 → 방장 시작이 모든 참가자에게 같은 startAt으로 전달', async () => {
  const host = client();
  await host.open;
  host.send('create', { name: '방장', setlist: [{ title: 'Song', bpm: 100, sections: [{ name: 'Verse', bars: 2 }] }] });
  const joined = await host.next(isType('joined'));
  assert.ok(joined.hostToken);
  assert.match(joined.code, /^[A-Z2-9]{4}$/);

  const guest = client();
  await guest.open;
  guest.send('join', { code: joined.code.toLowerCase(), name: '기타' });
  const gj = await guest.next(isType('joined'));
  assert.equal(gj.hostToken, null);
  const gs = await guest.next((m) => m.type === 'state' && m.state.members.length === 2);
  assert.equal(gs.state.setlist[0].title, 'Song');

  // 게스트는 시작할 수 없다
  guest.send('play');
  const err = await guest.next(isType('error'));
  assert.equal(err.code, 'NOT_HOST');

  const before = Date.now();
  host.send('play', {});
  const [a, b] = await Promise.all([
    host.next((m) => m.type === 'state' && m.state.playback),
    guest.next((m) => m.type === 'state' && m.state.playback),
  ]);
  assert.equal(a.state.playback.playId, b.state.playback.playId);
  assert.equal(a.state.playback.startAt, b.state.playback.startAt);
  assert.ok(a.state.playback.startAt >= before + 1000);
  assert.equal(a.state.playback.songs[0].sections[0].name, 'Verse');

  host.send('stop');
  const stopped = await guest.next((m) => m.type === 'state' && !m.state.playback);
  assert.equal(stopped.state.playback, null);
  host.close();
  guest.close();
});

test('방장이 재접속하면 hostToken으로 권한을 되찾는다', async () => {
  const host = client();
  await host.open;
  host.send('create', { name: 'H' });
  const { code, hostToken } = await host.next(isType('joined'));
  host.close();

  const again = client();
  await again.open;
  again.send('join', { code, name: 'H', hostToken });
  const j = await again.next(isType('joined'));
  assert.equal(j.hostToken, hostToken);
  const s = await again.next(isType('state'));
  assert.equal(s.state.hostId, j.you);
  again.close();
});

test('없는 방 코드는 에러', async () => {
  const c = client();
  await c.open;
  c.send('join', { code: 'ZZZZ', name: 'x' });
  const err = await c.next(isType('error'));
  assert.equal(err.code, 'ROOM_NOT_FOUND');
  c.close();
});

test('시계 동기화 ping/pong', async () => {
  const c = client();
  await c.open;
  c.send('ping', { t0: 42 });
  const pong = await c.next(isType('pong'));
  assert.equal(pong.t0, 42);
  assert.ok(Math.abs(pong.ts - Date.now()) < 1000);
  c.close();
});

test('악보: 방장만 올릴 수 있고 누구나 받을 수 있다', async () => {
  const host = client();
  await host.open;
  host.send('create', { name: 'H' });
  const { code, hostToken } = await host.next(isType('joined'));
  const id = 'a'.repeat(32);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const put = (headers, body = png, sheetId = id) => fetch(`${http}/api/sheets/${sheetId}?room=${code}`, {
    method: 'PUT', headers: { 'content-type': 'image/png', ...headers }, body,
  });

  assert.equal((await put({ 'x-host-token': 'wrong' })).status, 403);
  assert.equal((await put({ 'x-host-token': hostToken, 'content-type': 'text/html' })).status, 400);
  assert.equal((await put({ 'x-host-token': hostToken }, png, 'xyz')).status, 404);
  assert.equal((await put({ 'x-host-token': hostToken })).status, 200);

  const res = await fetch(`${http}/sheets/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
  assert.equal((await fetch(`${http}/sheets/${'b'.repeat(32)}`, { method: 'HEAD' })).status, 404);

  // 셋리스트에 악보 페이지가 저장된다
  host.send('setlist', { setlist: [{ title: 'S', sheets: [{ id, w: 100, h: 140 }, { id: '../etc' }] }] });
  const s = await host.next((m) => m.type === 'state' && m.state.setlist[0].title === 'S');
  assert.deepEqual(s.state.setlist[0].sheets, [{ id, w: 100, h: 140 }]);
  host.close();
});

test('부방장은 시작할 수 있지만 다른 사람을 임명할 수는 없다', async () => {
  const host = client();
  await host.open;
  host.send('create', { name: 'H', key: 'c'.repeat(32) });
  const { code } = await host.next(isType('joined'));
  const co = client();
  await co.open;
  co.send('join', { code, name: 'C', key: 'd'.repeat(32) });
  const { you } = await co.next(isType('joined'));
  host.send('cohost', { to: you, on: true });
  await co.next((m) => m.type === 'state' && m.state.members.find((x) => x.id === you)?.role === 'cohost');
  co.send('play', {});
  await co.next((m) => m.type === 'state' && m.state.playback);
  co.send('cohost', { to: you, on: false });
  assert.equal((await co.next(isType('error'))).code, 'NOT_HOST');
  co.send('owner_cohost', { to: you, on: false });
  co.send('live', { op: 'endSong' });
  const live = await co.next((m) => m.type === 'state' && m.state.playback?.rev === 1);
  assert.equal(live.state.members.find((x) => x.id === you).role, 'cohost');
  host.close();
  co.close();
});

test('링크 미리보기: 접속 주소로 og:image 전체 주소를 채운다', async () => {
  const page = await (await fetch(`${http}/?room=ABCD`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'echad.onrender.com' } })).text();
  assert.match(page, /<meta property="og:image" content="https:\/\/echad\.onrender\.com\/icons\/share-echad-v3-1200x630\.png">/);
  assert.ok(!page.includes('__ORIGIN__'));
  // 이상한 주소는 넣지 않는다
  const bad = await (await fetch(`${http}/`, { headers: { 'x-forwarded-host': 'x"><script>' } })).text();
  assert.ok(!bad.includes('<script>"'));
  assert.match(bad, /og:image" content="\/icons\//);
});

test('서버가 방을 잃어도 멤버가 코드로 들어오면 기기의 사본으로 되살리고, 방장·부방장은 그대로', async () => {
  // 1) 방장이 방을 만들고, 멤버(부방장)가 들어와서 방 사본을 받는다
  const host = client();
  await host.open;
  host.send('create', { name: 'H', key: '1'.repeat(32), title: '청년부', setlist: [{ title: '주 은혜임을' }] });
  const { code, hostToken } = await host.next(isType('joined'));
  const co = client();
  await co.open;
  co.send('join', { code, name: 'C', key: '2'.repeat(32) });
  const { you } = await co.next(isType('joined'));
  host.send('cohost', { to: you, on: true });
  const st = await co.next((m) => m.type === 'state' && m.state.members.find((x) => x.id === you)?.role === 'cohost');
  const { revive } = st.state;
  assert.ok(!JSON.stringify(revive).includes(hostToken), '사본에 방장 토큰 원문은 없다');
  assert.ok(!JSON.stringify(revive).includes('2'.repeat(32)), '사본에 기기 키 원문은 없다');
  host.close();
  co.close();
  await new Promise((r) => setTimeout(r, 100));

  // 2) 서버가 방을 잃음 (무료 서버 재시작 흉내)
  const code2 = `${code}`;
  const { rooms } = globalThis.__briefServer;
  rooms.rooms.delete(code2);

  // 3) 다른 멤버가 사본 없이 들어오면 실패
  const m1 = client();
  await m1.open;
  m1.send('join', { code: code2, name: 'X' });
  assert.equal((await m1.next(isType('error'))).code, 'ROOM_NOT_FOUND');

  // 4) 사본이 있는 멤버가 들어오면 같은 코드로 되살아난다
  const m2 = client();
  await m2.open;
  m2.send('join', { code: code2, name: 'M', key: '3'.repeat(32), revive });
  const j = await m2.next(isType('joined'));
  assert.equal(j.code, code2);
  assert.equal(j.hostToken, null, '멤버는 방장이 되지 않는다');
  const s2 = await m2.next(isType('state'));
  assert.equal(s2.state.title, '청년부');
  assert.equal(s2.state.setlist[0].title, '주 은혜임을');

  // 5) 원래 방장이 토큰으로 들어오면 방장, 부방장도 그대로
  const h2 = client();
  await h2.open;
  h2.send('join', { code: code2, name: 'H', key: '1'.repeat(32), hostToken });
  const hj = await h2.next(isType('joined'));
  assert.equal(hj.hostToken, hostToken);
  const c2 = client();
  await c2.open;
  c2.send('join', { code: code2, name: 'C', key: '2'.repeat(32) });
  const cj = await c2.next(isType('joined'));
  const s3 = await c2.next((m) => m.type === 'state' && m.state.members.length === 3);
  assert.equal(s3.state.members.find((x) => x.id === cj.you).role, 'cohost');
  assert.equal(s3.state.hostId, hj.you);
  for (const c of [m1, m2, h2, c2]) c.close();
});
