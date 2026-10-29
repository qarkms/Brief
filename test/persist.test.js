import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoomManager } from '../server/rooms.js';
import { createServer } from '../server/index.js';

test('방은 디스크에 저장되어 서버를 다시 켜도 남는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-rooms-'));
  const file = path.join(dir, 'rooms.json');
  const a = new RoomManager(() => {}, () => {}, { file });
  const room = a.create([{ title: '주 은혜임을' }], { title: '주일 2부' });
  room.coHostKeys.add('e'.repeat(32));
  room.gapSeconds = 7;
  a.saveNow();

  const b = new RoomManager(() => {}, () => {}, { file });
  const back = b.get(room.code);
  assert.equal(back.title, '주일 2부');
  assert.equal(back.hostToken, room.hostToken);
  assert.equal(back.setlist[0].title, '주 은혜임을');
  assert.equal(back.gapSeconds, 7);
  assert.ok(back.coHostKeys.has('e'.repeat(32)));
  assert.equal(back.playback, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('닫힌 방을 방장이 같은 코드·토큰으로 다시 연다', () => {
  const m = new RoomManager(() => {}, () => {});
  const token = 'f'.repeat(32);
  const room = m.create([{ title: 'A' }], { code: 'WXYZ', hostToken: token, title: '팀' });
  assert.equal(room.code, 'WXYZ');
  assert.equal(room.hostToken, token);
  // 이미 있는 코드면 새 코드
  const other = m.create([], { code: 'WXYZ', hostToken: token });
  assert.notEqual(other.code, 'WXYZ');
  assert.notEqual(other.hostToken, token);
  // 형식이 틀린 코드는 무시
  assert.notEqual(m.create([], { code: '!!!!' }).code, '!!!!');
  for (const r of m.rooms.values()) r.dispose();
});

test('홈 "내 방" 상태 API', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-api-'));
  const { server, rooms } = createServer({ dataDir });
  await new Promise((r) => server.listen(0, r));
  const room = rooms.create([{ title: '곡1' }, { title: '곡2' }], { title: '청년부' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await (await fetch(`${base}/api/rooms?codes=${room.code},ZZZZ`)).json();
  assert.deepEqual(res, {
    [room.code]: {
      code: room.code, title: '청년부', members: 0, playing: false, song: '곡1', songs: 2,
    },
  });
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
