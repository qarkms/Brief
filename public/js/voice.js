// 미리 녹음된 음성 클립(public/voice)을 Web Audio로 박에 정확히 맞춰 재생한다.
// 클립에 없는 문구(직접 쓴 한글 문구 등)는 기기 음성 합성으로 대신 읽는다.

export const VOICES = { female: '여성 (기본)', male: '남성' };

const ALIASES = {
  intro: 'intro', 인트로: 'intro', i: 'intro', in: 'intro',
  verse: 'verse', 벌스: 'verse', 버스: 'verse', 절: 'verse', v: 'verse', vs: 'verse',
  prechorus: 'pre-chorus', pre: 'pre-chorus', 프리코러스: 'pre-chorus', 프리: 'pre-chorus', pc: 'pre-chorus', p: 'pre-chorus',
  chorus: 'chorus', 코러스: 'chorus', 후렴: 'chorus', c: 'chorus', ch: 'chorus',
  postchorus: 'post-chorus', 포스트코러스: 'post-chorus',
  bridge: 'bridge', 브릿지: 'bridge', 브리지: 'bridge', b: 'bridge', br: 'bridge',
  interlude: 'interlude', 간주: 'interlude', 인터루드: 'interlude',
  instrumental: 'instrumental', inst: 'instrumental', 연주: 'instrumental',
  solo: 'solo', 솔로: 'solo',
  break: 'break', 브레이크: 'break',
  tag: 'tag', 태그: 'tag', t: 'tag',
  outro: 'outro', 아웃트로: 'outro', o: 'outro',
  ending: 'ending', 엔딩: 'ending', end: 'ending',
  refrain: 'refrain', vamp: 'vamp', 뱀프: 'vamp', turnaround: 'turnaround', 턴어라운드: 'turnaround',
  hook: 'hook', 훅: 'hook', build: 'build', 빌드: 'build', drop: 'drop', breakdown: 'breakdown', coda: 'coda', 코다: 'coda',
};

/** "Chorus 2", "코러스2", "V1" → ['chorus', '2']. 클립으로 못 읽으면 null */
export function clipsFor(text) {
  const t = String(text).trim().toLowerCase();
  const m = t.match(/^(.*?)[\s._-]*(\d{1,2})$/);
  const word = (m ? m[1] : t).replace(/[\s._-]/g, '');
  const num = m ? String(Number(m[2])) : null;
  const key = ALIASES[word];
  if (!key) return null;
  if (num !== null && (Number(num) < 1 || Number(num) > 12)) return null;
  return num ? [key, num] : [key];
}

export class VoiceBank {
  constructor() {
    this.ctx = null;
    this.voice = null;
    this.clips = new Map(); // key -> { buffer, onset }
    this.loading = null;
  }

  /** 음성 세트를 받아서 디코딩. 같은 세트면 다시 받지 않는다. */
  load(ctx, voice) {
    if (this.ctx === ctx && this.voice === voice && this.loading) return this.loading;
    this.ctx = ctx;
    this.voice = voice;
    const clips = new Map();
    this.loading = (async () => {
      const manifest = await (await fetch(`/voice/${voice}/manifest.json`)).json();
      await Promise.all(Object.entries(manifest).map(async ([key, meta]) => {
        const data = await (await fetch(`/voice/${voice}/${key}.wav`)).arrayBuffer();
        const buffer = await ctx.decodeAudioData(data);
        clips.set(key, { buffer, onset: meta.o });
      }));
      if (this.voice === voice) this.clips = clips;
      return true;
    })().catch(() => {
      this.loading = null;
      return false;
    });
    return this.loading;
  }

  has(keys) {
    return !!keys && keys.every((k) => this.clips.has(k));
  }

  /** 클립의 "들리는 시작점"(모음)이 at에 오도록 예약. 실제 시작 시각과 길이를 돌려준다. */
  schedule(keys, at, out, { rate = 1, onNode } = {}) {
    let t = at;
    let first = true;
    for (const key of keys) {
      const clip = this.clips.get(key);
      if (!clip) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = clip.buffer;
      src.playbackRate.value = rate;
      src.connect(out);
      const start = first ? t - clip.onset / rate : t;
      src.start(Math.max(this.ctx.currentTime, start));
      onNode?.(src, start);
      // 다음 단어(번호)는 앞 단어 바로 뒤에
      t = start + (clip.buffer.duration / rate) * 0.94;
      first = false;
    }
    return t;
  }
}
