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

test('박자·음표: 6/8과 셋잇단, 파트별 박자 변경', async () => {
  const { buildPlan: bp, normalizeSong: ns, accentGroup } = await import('../public/js/timeline.js');
  const s = ns({
    bpm: 120, beatsPerBar: 4, beatUnit: 4, subdivision: 3, countInBars: 0,
    sections: [
      { name: 'Verse', bars: 1 },
      { name: '2/4', bars: 1, beatsPerBar: 2, beatUnit: 4, announce: false },
      { name: 'Chorus', bars: 1, beatsPerBar: 7, beatUnit: 8 },
    ],
  });
  const plan = bp({ songs: [s] });
  assert.deepEqual(plan.bars.map((b) => [b.beats, b.unit, b.sub]), [[4, 4, 3], [2, 4, 3], [7, 8, 3]]);
  // 4/4 → 7/8: 8분음표 길이가 그대로 유지되도록 BPM 환산 (♩=120 → ♪=240)
  assert.equal(plan.bars[2].bpm, 240);
  assert.equal(plan.duration, 2 + 1 + 7 * 0.25);
  // 브리핑 끈 파트는 말하지 않고, 다음 파트 브리핑은 그 파트(2/4 마디) 첫 박에
  assert.deepEqual(plan.briefs.map((b) => [b.t, b.text]), [[0, 'Verse'], [2, 'Chorus']]);
  assert.equal(accentGroup(6, 8), 3);
  assert.equal(accentGroup(4, 4), 0);
});

test('카운트 음성 "1 2 3 4"와 첫 파트 브리핑 위치', async () => {
  const { buildPlan: bp, normalizeSong: ns } = await import('../public/js/timeline.js');
  const base = { bpm: 120, countInBars: 2, sections: [{ name: 'Intro', bars: 1 }] };
  const beats = bp({ songs: [ns({ ...base, countVoice: 'beats' })] });
  assert.deepEqual(beats.counts.map((c) => [c.t, c.key]), [[2, '1'], [2.5, '2'], [3, '3'], [3.5, '4']]);
  // 카운트하는 마디(두 번째) 대신 그 앞 마디 첫 박에 "Intro"
  assert.deepEqual(beats.briefs.map((b) => b.t), [0]);
  // 예전 "1 n 2 n" 카운트 설정은 숫자 카운트로 바뀐다
  assert.equal(ns({ countVoice: 'and' }).countVoice, 'beats');
  // 카운트인 1마디 + 카운트 음성이면 첫 브리핑은 생략
  const one = bp({ songs: [ns({ ...base, countInBars: 1, countVoice: 'beats' })] });
  assert.equal(one.briefs.length, 0);
});

test('클릭 쪼개기: 곡 전체에서 박 사이에 클릭이 들어간다', async () => {
  const { buildPlan: bp, normalizeSong: ns } = await import('../public/js/timeline.js');
  const { buildEvents } = await import('../public/js/engine.js').catch(() => ({}));
  const plan = bp({ songs: [ns({ bpm: 120, subdivision: 2, countInBars: 1, sections: [{ name: 'Verse', bars: 2 }] })] });
  assert.deepEqual(plan.bars.map((b) => b.sub), [2, 2, 2]);
  if (buildEvents) {
    const clicks = buildEvents(plan).sounds.filter((e) => e.type === 'click');
    assert.equal(clicks.length, 3 * 4 * 2);
    assert.deepEqual(clicks.slice(0, 4).map((c) => [c.t, c.level]), [[0, 'bar'], [0.25, 'sub'], [0.5, 'beat'], [0.75, 'sub']]);
  }
  // 6/8은 그대로 여섯 박
  const six = bp({ songs: [ns({ bpm: 120, beatsPerBar: 6, beatUnit: 8, countInBars: 0, sections: [{ name: 'V', bars: 1 }] })] });
  assert.deepEqual([six.bars[0].beats, six.bars[0].sub], [6, 1]);
});

test('재생 순서(sequence)로 반복·생략된 송폼', async () => {
  const { buildPlan: bp, livePosition } = await import('../public/js/timeline.js');
  const s = song();
  const plan = bp({ songs: [s], sequence: [[0, 0], [0, 2], [0, 2], [0, 1]] });
  assert.deepEqual(plan.items.map((it) => [it.sectionIndex, it.t]), [[0, 2], [2, 6], [2, 10], [1, 14]]);
  assert.deepEqual(plan.briefs.map((b) => b.text), ['Intro', 'Big chorus', 'Big chorus', 'Verse']);
  const pos = livePosition(plan, 7);
  assert.equal(pos.cur, 1);
  assert.equal(pos.firstEditable, 2);
});
