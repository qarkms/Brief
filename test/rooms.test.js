import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from '../server/rooms.js';

test('재생이 끝나면 다음 곡이 선택된다', () => {
  const room = new Room('ABCD', [{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
  room.autoAdvance = false;
  const pb = room.play({ songIndex: 1 }, 0);
  assert.equal(pb.endSongIndex, 1);
  assert.ok(room.finish(pb.playId));
  assert.equal(room.selectedSong, 2);
  assert.equal(room.playback, null);
  room.dispose();
});

test('자동 진행이면 마지막 곡까지 하나의 재생으로 이어진다', () => {
  const room = new Room('ABCD', [{ title: 'A' }, { title: 'B' }]);
  const pb = room.play({ songIndex: 0 }, 0);
  assert.equal(pb.endSongIndex, 1);
  // 재생 중 셋리스트를 고쳐도 진행 중인 재생은 영향 없음
  room.setSetlist([{ title: 'X' }]);
  assert.equal(room.playback.songs[0].title, 'A');
  assert.equal(room.finish('wrong-id'), false);
  room.dispose();
});

test('방장 넘기기는 토큰을 새로 발급한다', () => {
  const room = new Room('ABCD', []);
  const old = room.hostToken;
  room.addMember({ id: 'h' }, 'H', old);
  room.addMember({ id: 'g' }, 'G', null);
  const t = room.transferHost('g');
  assert.ok(t && t !== old);
  assert.ok(room.isHost('g'));
  assert.equal(room.transferHost('nobody'), null);
  room.dispose();
});
