import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlan, findBarIndex, normalizeSetlist, normalizeSong, songDuration,
} from '../public/js/timeline.js';

const song = (over = {}) => normalizeSong({
  title: 'A',
  bpm: 120,
  beatsPerBar: 4,
  countInBars: 1,
  sections: [
    { name: 'Intro', bars: 2 },
    { name: 'Verse', bars: 4 },
    { name: 'Chorus', bars: 2, cue: 'Big chorus' },
  ],
  ...over,
});

test('120 BPM 4/4: 한 마디는 2초, 카운트인 포함 길이', () => {
  const s = song();
  assert.equal(songDuration(s), (1 + 2 + 4 + 2) * 2);
  const plan = buildPlan({ songs: [s] });
  assert.equal(plan.bars.length, 9);
  assert.equal(plan.duration, 18);
  assert.equal(plan.bars[0].sectionIndex, -1);
});

test('브리핑은 각 파트 시작 한 마디 전 첫 박에 나온다', () => {
  const plan = buildPlan({ songs: [song()] });
  assert.deepEqual(
    plan.briefs.map((b) => [b.t, b.text]),
    [[0, 'Intro'], [4, 'Verse'], [12, 'Big chorus']],
  );
});

test('파트별 BPM/박자 변경이 반영된다', () => {
  const s = song({
    sections: [{ name: 'Intro', bars: 1 }, { name: 'Half', bars: 2, bpm: 60, beatsPerBar: 3 }],
  });
  const plan = buildPlan({ songs: [s] });
  const half = plan.bars.filter((b) => b.sectionIndex === 1);
  assert.equal(half[0].beats, 3);
  assert.equal(half[0].dur, 3);
  // Half 브리핑은 Intro 마지막 마디(t=2) 시작에
  assert.equal(plan.briefs[1].t, 2);
  assert.equal(plan.duration, 2 + 2 + 6);
});

test('중간 파트부터 시작하면 그 파트 박자로 카운트인', () => {
  const s = song({ sections: [{ name: 'Intro', bars: 2 }, { name: 'Slow', bars: 1, bpm: 60 }] });
  const plan = buildPlan({ songs: [s], startSectionIndex: 1 });
  assert.equal(plan.bars[0].sectionIndex, -1);
  assert.equal(plan.bars[0].bpm, 60);
  assert.equal(plan.briefs[0].text, 'Slow');
  assert.equal(plan.duration, 8);
});

test('셋리스트 자동 진행: 곡 사이 간격과 다음 곡 제목 안내', () => {
  const songs = [song({ title: 'One' }), song({ title: 'Two' })];
  const plan = buildPlan({ songs, autoAdvance: true, gapSeconds: 3 });
  assert.equal(plan.songs.length, 2);
  assert.equal(plan.songs[1].start, 18 + 3);
  assert.equal(plan.duration, 18 + 3 + 18);
  const titleBrief = plan.briefs.find((b) => b.kind === 'song');
  assert.deepEqual([titleBrief.t, titleBrief.text], [18, 'Two']);
  // 간격 중에는 마디가 없다
  assert.equal(findBarIndex(plan, 19.5), -1);
  assert.equal(plan.bars[findBarIndex(plan, 21.1)].songIndex, 1);
});

test('간격 0 + 카운트인 0이면 이전 곡 마지막 마디에서 다음 곡 브리핑', () => {
  const songs = [song({ title: 'One', countInBars: 0 }), song({ title: 'Two', countInBars: 0 })];
  const plan = buildPlan({ songs, gapSeconds: 0 });
  const b = plan.briefs.find((x) => x.songIndex === 1 && x.sectionIndex === 0);
  assert.equal(b.t, 16 - 2);
});

test('자동 진행 끄면 한 곡만', () => {
  const plan = buildPlan({ songs: [song(), song()], startSongIndex: 1, autoAdvance: false });
  assert.equal(plan.songs.length, 1);
  assert.equal(plan.songs[0].songIndex, 1);
});

test('findBarIndex 경계', () => {
  const plan = buildPlan({ songs: [song()] });
  assert.equal(findBarIndex(plan, -0.1), -1);
  assert.equal(findBarIndex(plan, 0), 0);
  assert.equal(findBarIndex(plan, 1.999), 0);
  assert.equal(findBarIndex(plan, 2), 1);
  assert.equal(findBarIndex(plan, 18), -1);
});

test('잘못된 입력은 안전한 값으로 정리된다', () => {
  const [s] = normalizeSetlist([{ bpm: 'abc', beatsPerBar: 99, sections: [{ name: '', bars: -3, bpm: '' }] }]);
  assert.equal(s.bpm, 120);
  assert.equal(s.beatsPerBar, 16);
  assert.equal(s.sections[0].bars, 1);
  assert.equal(s.sections[0].bpm, null);
  assert.equal(s.sections[0].name, 'Section');
  assert.deepEqual(normalizeSetlist('nope'), []);
});

test('Tag 파트 프리셋', async () => {
  const { SECTION_PRESETS } = await import('../public/js/timeline.js');
  assert.ok(SECTION_PRESETS.includes('Tag'));
});
