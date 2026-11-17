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

test('참가자 목록: 나간 사람도 남고 접속 여부가 보인다', () => {
  const room = new Room('ABCD', []);
  const K = (c) => c.repeat(32);
  room.addMember({ id: 'h' }, '방장', room.hostToken, K('a'));
  room.addMember({ id: 'g' }, '기타', null, K('b'));
  room.addMember({ id: 'g-tab2' }, '기타', null, K('b')); // 같은 기기 두 번째 창
  room.addMember({ id: 'd' }, '드럼', null, K('c'));
  let list = room.memberList();
  assert.equal(list.length, 3, '같은 기기는 한 사람');
  assert.deepEqual(list.find((m) => m.name === '기타').ids, ['g', 'g-tab2']);
  room.removeMember('d');
  list = room.memberList();
  const drum = list.find((m) => m.name === '드럼');
  assert.equal(list.length, 3);
  assert.equal(drum.online, false);
  assert.ok(drum.lastSeen > 0 && drum.id === null);
  assert.equal(list[list.length - 1], drum, '접속 안 한 사람은 뒤로');
  // 접속 안 한 사람도 부방장 임명 → 다시 들어오면 부방장
  assert.ok(room.setCoHost(null, true, drum.uid));
  room.addMember({ id: 'd2' }, '드럼', null, K('c'));
  assert.equal(room.memberList().find((m) => m.id === 'd2').role, 'cohost');
  assert.ok(room.canControl('d2'));
  // 방장이 나가도 목록에 방장으로 남는다
  room.removeMember('h');
  assert.equal(room.memberList().find((m) => m.name === '방장').role, 'host');
  // 목록에서 빼기: 접속 중이면 안 되고, 나간 사람만
  assert.equal(room.forget(room.memberList().find((m) => m.name === '드럼').uid), false);
  room.removeMember('d2');
  assert.ok(room.forget(room.memberList().find((m) => m.name === '드럼').uid));
  assert.equal(room.memberList().some((m) => m.name === '드럼'), false);
  assert.equal(room.canControlKey(K('c')), false, '빼면 부방장도 해제');
  // 저장했다가 다시 불러와도 남는다
  const again = Room.restore(JSON.parse(JSON.stringify(room.serialize())));
  const names = again.memberList().map((m) => `${m.name}:${m.online}:${m.role}`);
  assert.deepEqual(names.sort(), ['기타:false:member', '방장:false:host']);
  room.dispose();
  again.dispose();
});
