// 곡 구조 → 시간표(마디/박/브리핑/카운트) 계산. 서버와 클라이언트가 같은 모듈을 써서
// 모든 기기가 완전히 같은 타임라인을 만들어낸다.

export const SECTION_PRESETS = [
  'Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Post-Chorus',
  'Bridge', 'Interlude', 'Solo', 'Break', 'Tag', 'Outro', 'Ending',
];

export const SHEET_ID = /^[a-f0-9]{32}$/;
export const BEAT_UNITS = [2, 4, 8, 16];
export const SUBDIVISIONS = [1, 2, 3, 4, 6];
export const COUNT_VOICES = ['none', 'beats'];

export const LIMITS = {
  bpm: [20, 400],
  beatsPerBar: [1, 16],
  bars: [1, 512],
  countInBars: [0, 8],
  gapSeconds: [0, 120],
  songs: 100,
  sections: 100,
  sheets: 40,
  sequence: 400,
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
const oneOf = (v, list, fallback) => (list.includes(Number(v)) ? Number(v) : fallback);
const optInt = (v, range) => {
  const n = clamp(v, range, null);
  return n === null ? null : Math.round(n);
};

export function normalizeSection(s = {}) {
  return {
    name: text(s.name, 40, 'Section'),
    bars: Math.round(clamp(s.bars, LIMITS.bars, 8)),
    // 아래 값이 null이면 곡 기본값을 쓴다
    bpm: clamp(s.bpm, LIMITS.bpm, null),
    beatsPerBar: optInt(s.beatsPerBar, LIMITS.beatsPerBar),
    beatUnit: BEAT_UNITS.includes(Number(s.beatUnit)) ? Number(s.beatUnit) : null,
    subdivision: SUBDIVISIONS.includes(Number(s.subdivision)) ? Number(s.subdivision) : null,
    cue: text(s.cue, 80),
    announce: s.announce !== false,
  };
}

export function normalizeSheets(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.id === 'string' && SHEET_ID.test(p.id))
    .slice(0, LIMITS.sheets)
    .map((p) => ({
      id: p.id,
      w: Math.round(clamp(p.w, [1, 20000], 1)),
      h: Math.round(clamp(p.h, [1, 20000], 1)),
    }));
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
    beatUnit: oneOf(s.beatUnit, BEAT_UNITS, 4),
    subdivision: oneOf(s.subdivision, SUBDIVISIONS, 1),
    countInBars: Math.round(clamp(s.countInBars, LIMITS.countInBars, 1)),
    // 예전 'and'(1 n 2 n) 카운트는 숫자 카운트로 (쪼개기는 "클릭 쪼개기"에서)
    countVoice: s.countVoice === 'and' ? 'beats' : COUNT_VOICES.includes(s.countVoice) ? s.countVoice : 'none',
    sections,
    sheets: normalizeSheets(s.sheets),
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
      { name: 'Verse 1', bars: 8 },
      { name: 'Pre-Chorus', bars: 4 },
      { name: 'Chorus', bars: 8 },
      { name: 'Verse 2', bars: 8 },
      { name: 'Chorus', bars: 8 },
      { name: 'Bridge', bars: 4 },
      { name: 'Chorus', bars: 8 },
      { name: 'Outro', bars: 4 },
    ],
  });
}

/**
 * 파트의 실제 박자·템포.
 * BPM은 박 단위(분모) 기준. 파트에서 분모만 바뀌고 BPM을 비워두면
 * 같은 음표 길이가 유지되도록 BPM을 환산한다 (예: 4/4 ♩=120 → 7/8 ♪=240).
 */
export function sectionMeter(song, section) {
  const unit = section.beatUnit ?? song.beatUnit ?? 4;
  const songUnit = song.beatUnit ?? 4;
  return {
    beats: section.beatsPerBar ?? song.beatsPerBar,
    unit,
    bpm: section.bpm ?? song.bpm * (unit / songUnit),
    sub: section.subdivision ?? song.subdivision ?? 1,
  };
}

export const meterLabel = (m) => `${m.beats}/${m.unit}`;

/** 강박 위치: 6/8, 9/8, 12/8 같은 겹박자는 3박마다 중간 강세 */
export function accentGroup(beats, unit) {
  return unit >= 8 && beats > 3 && beats % 3 === 0 ? 3 : 0;
}

/** 곡 하나의 전체 길이(초). 카운트인 포함. */
export function songDuration(song) {
  const plan = buildPlan({ songs: [song], sequence: song.sections.map((_, k) => [0, k]) });
  return plan.duration;
}

/** 곡의 기본 송폼 순서대로 재생 순서(sequence)를 만든다. [songIndex, sectionIndex] 목록 */
export function defaultSequence({
  songs, startSongIndex = 0, startSectionIndex = 0, autoAdvance = true,
}) {
  const seq = [];
  const last = autoAdvance ? songs.length - 1 : startSongIndex;
  for (let si = startSongIndex; si <= last && si < songs.length; si++) {
    const first = si === startSongIndex ? Math.max(0, Math.min(startSectionIndex, songs[si].sections.length - 1)) : 0;
    for (let k = first; k < songs[si].sections.length; k++) seq.push([si, k]);
  }
  return seq;
}

function pushBar(bars, t, m, extra) {
  const beatDur = 60 / m.bpm;
  const bar = {
    t, dur: beatDur * m.beats, beats: m.beats, unit: m.unit, beatDur, bpm: m.bpm, sub: m.sub, ...extra,
  };
  bars.push(bar);
  return bar;
}

/**
 * 재생 계획을 만든다.
 * - bars: 연주될 모든 마디 (카운트인은 sectionIndex = -1)
 * - items: 파트 하나하나의 시작/끝 (seq = sequence 안의 위치)
 * - briefs: 음성 브리핑. 파트가 시작하기 한 마디 전 첫 박.
 * - counts: 카운트인 음성 ("1 2 3 4" / "1 and 2 and …")
 * - songs: 곡별 시작/끝
 * 시간(t)은 startAt 기준 초.
 */
export function buildPlan(pb) {
  const { songs, gapSeconds = 0 } = pb;
  const sequence = pb.sequence || defaultSequence(pb);
  const bars = [];
  const items = [];
  const briefs = [];
  const counts = [];
  const songMeta = [];
  let t = 0;
  let prevSong = null;

  sequence.forEach(([si, k], seq) => {
    const song = songs[si];
    const sec = song && song.sections[k];
    if (!sec) return;

    if (si !== prevSong) {
      // 새 곡 시작: 간격 → 카운트인
      if (prevSong !== null) {
        songMeta[songMeta.length - 1].end = t;
        if (gapSeconds > 0) {
          if (gapSeconds >= 1.5) briefs.push({ t, text: song.title, songIndex: si, sectionIndex: -1, seq, kind: 'song' });
          t += gapSeconds;
        }
      }
      prevSong = si;
      songMeta.push({ songIndex: si, start: t, end: t });
      const m0 = sectionMeter(song, sec);
      const n = song.countInBars;
      for (let c = 0; c < n; c++) {
        const bar = pushBar(bars, t, m0, {
          songIndex: si, sectionIndex: -1, seq: -1, bar: c + 1, barsInSection: n,
        });
        if (song.countVoice !== 'none' && c === n - 1) {
          for (let b = 0; b < m0.beats; b++) {
            counts.push({ t: t + b * bar.beatDur, key: String(b + 1), slot: bar.beatDur });
          }
        }
        t += bar.dur;
      }
    }

    // 브리핑: 바로 앞 마디 첫 박. 카운트 음성이 그 마디를 쓰면 한 마디 더 앞, 없으면 생략.
    const m = sectionMeter(song, sec);
    if (sec.announce) {
      let at = null;
      const prev = bars[bars.length - 1];
      const contiguous = prev && Math.abs(prev.t + prev.dur - t) < 1e-6;
      if (contiguous && !(prev.sectionIndex === -1 && song.countVoice !== 'none')) at = prev.t;
      else if (contiguous) {
        const before = bars[bars.length - 2];
        if (before && before.sectionIndex === -1 && before.songIndex === si) at = before.t;
      } else at = t;
      if (at !== null) {
        briefs.push({
          t: at, text: sec.cue || sec.name, songIndex: si, sectionIndex: k, seq, kind: 'section',
        });
      }
    }

    const start = t;
    for (let b = 0; b < sec.bars; b++) {
      const bar = pushBar(bars, t, m, {
        songIndex: si, sectionIndex: k, seq, bar: b + 1, barsInSection: sec.bars,
      });
      t += bar.dur;
    }
    items.push({
      seq, songIndex: si, sectionIndex: k, t: start, end: t,
    });
  });
  if (songMeta.length) songMeta[songMeta.length - 1].end = t;

  return {
    bars, items, briefs, counts, songs: songMeta, duration: t,
  };
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

/**
 * 실시간 송폼 변경에서 쓰는 현재 위치.
 * cur: 지금 연주 중인 파트의 seq (카운트인/간격이면 -1)
 * firstEditable: 아직 시작하지 않아 바꿀 수 있는 첫 seq
 */
export function livePosition(plan, time, margin = 0.25) {
  const cur = plan.items.find((it) => it.t <= time && time < it.end);
  const editable = plan.items.find((it) => it.t > time + margin);
  return {
    cur: cur ? cur.seq : -1,
    curItem: cur || null,
    firstEditable: editable ? editable.seq : Infinity,
    nextItem: editable || null,
  };
}
