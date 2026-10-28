// 곡 구조 → 시간표(마디/브리핑) 계산. 서버와 클라이언트가 같은 모듈을 써서
// 모든 기기가 완전히 같은 타임라인을 만들어낸다.

export const SECTION_PRESETS = [
  'Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Post-Chorus',
  'Bridge', 'Interlude', 'Solo', 'Break', 'Outro', 'Ending',
];

export const LIMITS = {
  bpm: [20, 400],
  beatsPerBar: [1, 16],
  bars: [1, 512],
  countInBars: [0, 8],
  gapSeconds: [0, 120],
  songs: 100,
  sections: 100,
};

export function clamp(value, [lo, hi], fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

const text = (v, max, fallback = '') => {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return s || fallback;
};

export function normalizeSection(s = {}) {
  const bpm = clamp(s.bpm, LIMITS.bpm, null);
  const beats = clamp(s.beatsPerBar, LIMITS.beatsPerBar, null);
  return {
    name: text(s.name, 40, 'Section'),
    bars: Math.round(clamp(s.bars, LIMITS.bars, 8)),
    bpm,
    beatsPerBar: beats === null ? null : Math.round(beats),
    cue: text(s.cue, 80),
  };
}

export function normalizeSong(s = {}) {
  let sections = Array.isArray(s.sections)
    ? s.sections.slice(0, LIMITS.sections).map(normalizeSection)
    : [];
  if (!sections.length) sections = [normalizeSection({ name: 'Intro', bars: 4 })];
  return {
    id: text(s.id, 40) || makeId(),
    title: text(s.title, 80, '제목 없음'),
    bpm: clamp(s.bpm, LIMITS.bpm, 120),
    beatsPerBar: Math.round(clamp(s.beatsPerBar, LIMITS.beatsPerBar, 4)),
    countInBars: Math.round(clamp(s.countInBars, LIMITS.countInBars, 1)),
    sections,
  };
}

export function normalizeSetlist(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, LIMITS.songs).map(normalizeSong);
}

export function demoSong() {
  return normalizeSong({
    title: '예시 곡',
    bpm: 120,
    beatsPerBar: 4,
    countInBars: 1,
    sections: [
      { name: 'Intro', bars: 4 },
      { name: 'Verse', bars: 8 },
      { name: 'Pre-Chorus', bars: 4 },
      { name: 'Chorus', bars: 8 },
      { name: 'Verse', bars: 8 },
      { name: 'Chorus', bars: 8 },
      { name: 'Bridge', bars: 4 },
      { name: 'Chorus', bars: 8 },
      { name: 'Outro', bars: 4 },
    ],
  });
}

export function sectionMeter(song, section) {
  return {
    bpm: section.bpm ?? song.bpm,
    beats: section.beatsPerBar ?? song.beatsPerBar,
  };
}

/** 곡 하나의 전체 길이(초). 카운트인 포함. */
export function songDuration(song) {
  const first = song.sections[0];
  const m0 = sectionMeter(song, first);
  let t = song.countInBars * m0.beats * (60 / m0.bpm);
  for (const sec of song.sections) {
    const m = sectionMeter(song, sec);
    t += sec.bars * m.beats * (60 / m.bpm);
  }
  return t;
}

/**
 * 재생 계획을 만든다.
 * - bars: 연주될 모든 마디 (카운트인은 sectionIndex = -1)
 * - briefs: 음성 브리핑. 각 파트가 시작하기 한 마디 전 첫 박에 나온다.
 * - songs: 곡별 시작/끝 시간
 * 시간(t)은 startAt 기준 초 단위.
 */
export function buildPlan({
  songs,
  startSongIndex = 0,
  startSectionIndex = 0,
  autoAdvance = true,
  gapSeconds = 0,
}) {
  const bars = [];
  const briefs = [];
  const songMeta = [];
  let t = 0;
  const lastSong = autoAdvance ? songs.length - 1 : startSongIndex;

  for (let si = startSongIndex; si <= lastSong && si < songs.length; si++) {
    const song = songs[si];
    const firstSec = si === startSongIndex
      ? Math.max(0, Math.min(startSectionIndex, song.sections.length - 1))
      : 0;

    if (si > startSongIndex && gapSeconds > 0) {
      // 곡 사이 간격: 길이가 충분하면 다음 곡 제목을 미리 알려준다.
      if (gapSeconds >= 1.5) {
        briefs.push({ t, text: song.title, songIndex: si, sectionIndex: -1, kind: 'song' });
      }
      t += gapSeconds;
    }
    const songStart = t;

    const m0 = sectionMeter(song, song.sections[firstSec]);
    const beatDur0 = 60 / m0.bpm;
    for (let c = 0; c < song.countInBars; c++) {
      bars.push({
        t, dur: beatDur0 * m0.beats, beats: m0.beats, beatDur: beatDur0, bpm: m0.bpm,
        songIndex: si, sectionIndex: -1, bar: c + 1, barsInSection: song.countInBars,
      });
      t += beatDur0 * m0.beats;
    }

    for (let k = firstSec; k < song.sections.length; k++) {
      const sec = song.sections[k];
      const m = sectionMeter(song, sec);
      const beatDur = 60 / m.bpm;
      const dur = beatDur * m.beats;

      // 바로 앞 마디가 이어져 있으면 그 마디 시작에 브리핑, 아니면 파트 시작과 동시에.
      const prev = bars[bars.length - 1];
      const contiguous = prev && Math.abs(prev.t + prev.dur - t) < 1e-6;
      briefs.push({
        t: contiguous ? prev.t : t,
        text: sec.cue || sec.name,
        songIndex: si,
        sectionIndex: k,
        kind: 'section',
      });

      for (let b = 0; b < sec.bars; b++) {
        bars.push({
          t, dur, beats: m.beats, beatDur, bpm: m.bpm,
          songIndex: si, sectionIndex: k, bar: b + 1, barsInSection: sec.bars,
        });
        t += dur;
      }
    }
    songMeta.push({ songIndex: si, start: songStart, end: t });
  }

  return { bars, briefs, songs: songMeta, duration: t };
}

/** time(초)에 연주 중인 마디의 인덱스. 없으면 -1 (시작 전, 곡 사이 간격, 종료 후). */
export function findBarIndex(plan, time) {
  const { bars } = plan;
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return -1;
  const bar = bars[found];
  return time < bar.t + bar.dur ? found : -1;
}
