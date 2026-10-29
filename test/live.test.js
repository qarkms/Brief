import assert from 'node:assert/strict';
import test from 'node:test';
import { Room } from '../server/rooms.js';
import { buildPlan } from '../public/js/timeline.js';

// 120 BPM 4/4, 카운트인 1마디: 한 마디 2초
const SONG = {
  title: 'A',
  countInBars: 1,
  sections: [
    { name: 'Verse', bars: 2 }, // 2~6초
    { name: 'Chorus', bars: 2 }, // 6~10초
    { name: 'Bridge', bars: 1 }, // 10~12초
    { name: 'Outro', bars: 1 }, // 12~14초
  ],
};

function playing(at = 0) {
  const room = new Room('LIVE', [SONG, { title: 'B' }]);
  room.autoAdvance = false;
  const pb = room.play({ songIndex: 0 }, 0);
  const now = (sec) => pb.startAt + sec * 1000;
  return {
    room, pb, now, at,
  };
}
const names = (room) => room.playback.sequence.map(([, k]) => SONG.sections[k].name);

test('코러스 한 번 더 / 다음 파트 건너뛰기 / 파트 취소', () => {
  const { room, now } = playing();
  // 코러스 중(7초)에 "한 번 더"
  assert.equal(room.live({ op: 'repeat' }, now(7)), null);
  assert.deepEqual(names(room), ['Verse', 'Chorus', 'Chorus', 'Bridge', 'Outro']);
  assert.equal(room.playback.rev, 1);
  // 다음(두 번째 코러스) 건너뛰기
  assert.equal(room.live({ op: 'skipNext' }, now(7)), null);
  assert.deepEqual(names(room), ['Verse', 'Chorus', 'Bridge', 'Outro']);
  // Verse 중(3초)에 코러스 하나 더 넣기 → Verse 바로 뒤
  assert.equal(room.live({ op: 'insert', sectionIndex: 1 }, now(3)), null);
  assert.deepEqual(names(room), ['Verse', 'Chorus', 'Chorus', 'Bridge', 'Outro']);
  // 아직 안 지나간 파트 취소 (rev가 맞아야 함)
  assert.equal(room.live({ op: 'remove', seq: 3, rev: 0 }, now(3)), 'STALE');
  assert.equal(room.live({ op: 'remove', seq: 3, rev: room.playback.rev }, now(3)), null);
  assert.deepEqual(names(room), ['Verse', 'Chorus', 'Chorus', 'Outro']);
  // 이미 연주 중인 파트는 취소할 수 없다
  assert.equal(room.live({ op: 'remove', seq: 0, rev: room.playback.rev }, now(3)), 'TOO_LATE');
  room.dispose();
});

test('이 파트 후 곡 끝내기: 길이와 종료 시각이 줄어든다', () => {
  const { room, now } = playing();
  const before = room.playback.duration;
  assert.equal(room.live({ op: 'endSong' }, now(7)), null);
  assert.deepEqual(names(room), ['Verse', 'Chorus']);
  assert.equal(room.playback.duration, 10);
  assert.ok(room.playback.duration < before);
  room.dispose();
});

test('파트 경계 직전에 바꾸면 그다음 자리에 적용 (이미 시작된 박은 그대로)', () => {
  const { room, now, pb } = playing();
  const planBefore = buildPlan(pb);
  // Verse가 5.9초에 거의 끝남 → Chorus는 곧 시작하므로 그 뒤에 삽입
  assert.equal(room.live({ op: 'insert', sectionIndex: 2 }, now(5.9)), null);
  assert.deepEqual(names(room), ['Verse', 'Chorus', 'Bridge', 'Bridge', 'Outro']);
  const planAfter = buildPlan(room.playback);
  // 지금까지(6초 전)의 마디 시각은 완전히 같다
  const upTo = (p) => p.bars.filter((b) => b.t < 6).map((b) => b.t);
  assert.deepEqual(upTo(planAfter), upTo(planBefore));
  room.dispose();
});

test('부방장: 기기 키로 권한이 유지되고 방장만 임명할 수 있다', () => {
  const room = new Room('ABCD', []);
  const host = { id: 'h' };
  const guest = { id: 'g' };
  room.addMember(host, 'H', room.hostToken, 'a'.repeat(32));
  room.addMember(guest, 'G', null, 'b'.repeat(32));
  assert.equal(room.canControl('g'), false);
  assert.ok(room.setCoHost('g', true));
  assert.equal(room.canControl('g'), true);
  assert.equal(room.canControlKey('b'.repeat(32)), true);
  // 재접속(새 id, 같은 키)해도 부방장
  room.removeMember('g');
  room.addMember({ id: 'g2' }, 'G', null, 'b'.repeat(32));
  assert.equal(room.canControl('g2'), true);
  assert.equal(room.publicState().members.find((m) => m.id === 'g2').role, 'cohost');
  // 방장 넘기면 이전 방장은 부방장
  room.transferHost('g2');
  assert.ok(room.isHost('g2'));
  assert.ok(room.isCoHost('h'));
  room.dispose();
});
