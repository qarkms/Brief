import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';

let server;
let url;

before(async () => {
  ({ server } = createServer());
  await new Promise((r) => server.listen(0, r));
  url = `ws://127.0.0.1:${server.address().port}/ws`;
});
after(() => new Promise((r) => {
  server.closeAllConnections?.();
  server.close(r);
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
