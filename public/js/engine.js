// 메트로놈 클릭 + 음성 브리핑/카운트 스케줄러.
// 서버 시각 startAt을 이 기기의 AudioContext 시각으로 변환해서
// 모든 소리를 Web Audio로 미리 예약하므로 모든 기기에서 같은 순간에 소리가 난다.
import { accentGroup } from './timeline.js';
import { clipsFor, VoiceBank } from './voice.js';

const LOOKAHEAD = 0.6; // 초: 이만큼 앞의 소리를 미리 예약
const RESYNC_EVERY = 1.0; // 초: 시계 보정 주기

const TICKER_SRC = `let id=null;onmessage=e=>{if(e.data==='start'){if(!id)id=setInterval(()=>postMessage(0),25)}else{clearInterval(id);id=null}}`;

export const DEFAULT_SETTINGS = {
  click: true,
  clickVolume: 0.8,
  subVolume: 0.5,
  voice: true,
  voiceSet: 'female', // female | male | device(기기 음성 합성)
  voiceVolume: 1,
  voiceURI: '',
  latencyMs: 0,
  speechLeadMs: 0, // 기기 음성 합성 미세 조정 (자동 측정값에 더해짐)
  speechAutoMs: 300, // 기기 음성 합성 지연 자동 측정값
  wakeLock: true,
};

// 클릭 소리: level → [주파수, 볼륨]
const TONES = {
  section: [2100, 1],
  bar: [1600, 1],
  group: [1300, 0.8],
  beat: [1000, 0.6],
  sub: [800, 0.32],
};

/** 계획 → 시간순 소리 이벤트 목록 (클릭·카운트 / 브리핑) */
export function buildEvents(plan) {
  const events = [];
  for (const bar of plan.bars) {
    const group = accentGroup(bar.beats, bar.unit);
    for (let b = 0; b < bar.beats; b++) {
      for (let s = 0; s < bar.sub; s++) {
        let level = 'beat';
        if (s > 0) level = 'sub';
        else if (b === 0) level = bar.bar === 1 && bar.sectionIndex >= 0 ? 'section' : 'bar';
        else if (group && b % group === 0) level = 'group';
        events.push({ t: bar.t + (b + s / bar.sub) * bar.beatDur, type: 'click', level });
      }
    }
  }
  for (const c of plan.counts) events.push({ t: c.t, type: 'count', key: c.key, slot: c.slot });
  events.sort((a, b) => a.t - b.t || (a.type === 'click' ? -1 : 1));
  const briefs = plan.briefs.map((br) => ({ t: br.t, type: 'brief', text: br.text }));
  return { sounds: events, briefs };
}

export class Engine {
  constructor(conn, settings) {
    this.conn = conn;
    this.settings = settings;
    this.ctx = null;
    this.plan = null;
    this.events = { sounds: [], briefs: [] };
    this.startAt = 0;
    this.nodes = new Map(); // AudioScheduledSourceNode -> 시작 시각
    this.speechTimers = new Map(); // timer -> 예정 시각
    this.voice = new VoiceBank();
    this.lastVoice = null;
    this.onEnded = null;
    const blobUrl = URL.createObjectURL(new Blob([TICKER_SRC], { type: 'text/javascript' }));
    this.ticker = new Worker(blobUrl);
    this.ticker.onmessage = () => this.#tick();
    this.synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  }

  get unlocked() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** 반드시 사용자 탭 이벤트 안에서 호출 (iOS/안드로이드 오디오 정책). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.out = this.ctx.createGain();
      this.out.connect(this.ctx.destination);
      this.voiceOut = this.ctx.createGain();
      this.voiceOut.connect(this.ctx.destination);
    }
    try {
      // iOS 무음 스위치가 켜져 있어도 소리가 나도록
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* 지원 안 함 */ }
    const resumed = this.ctx.resume();
    const buf = this.ctx.createBuffer(1, 1, 22050);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start(0);
    if (this.synth) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      this.synth.speak(u);
    }
    this.loadVoice();
    return resumed;
  }

  loadVoice() {
    if (this.ctx && this.settings.voiceSet !== 'device') this.voice.load(this.ctx, this.settings.voiceSet);
  }

  /** 서버 시각(ms) → 이 기기에서 그 순간에 "들리는" AudioContext 시각(초) */
  #audioTimeFor(serverMs) {
    const ctx = this.ctx;
    const perf = serverMs - this.conn.offset;
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    let t;
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      // 출력 지연(블루투스 등)까지 반영된 매핑
      t = ts.contextTime + (perf - ts.performanceTime) / 1000;
    } else {
      t = ctx.currentTime + (perf - performance.now()) / 1000
        - (ctx.outputLatency || ctx.baseLatency || 0);
    }
    return t - this.settings.latencyMs / 1000;
  }

  start(plan, startAt) {
    this.stop();
    if (!this.unlocked) return;
    this.plan = plan;
    this.events = buildEvents(plan);
    this.startAt = startAt;
    this.audioStart = this.#audioTimeFor(startAt);
    this.lastResync = this.ctx.currentTime;
    this.idx = 0;
    this.briefIdx = 0;
    this.ticker.postMessage('start');
    this.#tick();
  }

  /**
   * 재생 중 송폼이 바뀌었을 때: 아직 소리 나지 않은 예약만 지우고 새 계획으로 다시 예약.
   * 바뀌는 건 미래 파트뿐이라 지금까지의 박은 그대로 이어진다.
   */
  update(plan) {
    if (!this.plan || !this.ctx) {
      this.plan = plan;
      return;
    }
    const cut = this.ctx.currentTime + 0.02;
    for (const [node, at] of this.nodes) {
      if (at > cut) {
        try {
          node.stop(0);
        } catch { /* 무시 */ }
        this.nodes.delete(node);
      }
    }
    for (const [timer, at] of this.speechTimers) {
      if (at > cut) {
        clearTimeout(timer);
        this.speechTimers.delete(timer);
      }
    }
    this.plan = plan;
    this.events = buildEvents(plan);
    const rel = cut - this.audioStart;
    const from = (list) => {
      const i = list.findIndex((e) => e.t > rel);
      return i === -1 ? list.length : i;
    };
    this.idx = from(this.events.sounds);
    this.briefIdx = from(this.events.briefs);
    this.#tick();
  }

  stop() {
    this.ticker.postMessage('stop');
    this.plan = null;
    for (const n of this.nodes.keys()) {
      try {
        n.stop(0);
      } catch { /* 이미 끝남 */ }
    }
    this.nodes.clear();
    for (const timer of this.speechTimers.keys()) clearTimeout(timer);
    this.speechTimers.clear();
    this.lastVoice = null;
    if (this.synth) this.synth.cancel();
  }

  #resync(now) {
    if (now - this.lastResync < RESYNC_EVERY) return;
    this.lastResync = now;
    const est = this.#audioTimeFor(this.startAt);
    const d = est - this.audioStart;
    // 작은 오차는 천천히, 큰 오차는 즉시 보정
    this.audioStart += Math.abs(d) > 0.08 ? d : d * 0.15;
  }

  #track(node, at) {
    this.nodes.set(node, at);
    node.onended = () => this.nodes.delete(node);
  }

  #tick() {
    const plan = this.plan;
    if (!plan || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.#resync(now);
    const { sounds, briefs } = this.events;

    while (this.idx < sounds.length) {
      const ev = sounds[this.idx];
      const at = this.audioStart + ev.t;
      if (at > now + LOOKAHEAD) break;
      this.idx++;
      if (at < now - 0.01) continue; // 늦게 들어온 경우 지나간 소리는 건너뛴다
      if (ev.type === 'click') {
        if (this.settings.click) this.#click(Math.max(at, now), ev.level);
      } else if (this.settings.voice) {
        this.#voiceClip([ev.key], at, ev.slot);
      }
    }

    // 기기 음성은 늦게 시작하므로 그만큼 더 일찍 꺼내 본다
    const briefHorizon = now + LOOKAHEAD + this.#speechLead();
    while (this.briefIdx < briefs.length) {
      const ev = briefs[this.briefIdx];
      const at = this.audioStart + ev.t;
      if (at > briefHorizon) break;
      this.briefIdx++;
      if (at >= now - 0.3 && this.settings.voice) this.#brief(ev.text, at);
    }

    if (this.idx >= sounds.length && this.briefIdx >= briefs.length && !this.speechTimers.size && now > this.audioStart + plan.duration + 0.3) {
      this.ticker.postMessage('stop');
      this.plan = null;
      this.onEnded?.();
    }
  }

  #click(t, level) {
    const ctx = this.ctx;
    const [freq, gainMul] = TONES[level];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const vol = (level === 'sub' ? this.settings.subVolume : 1) * this.settings.clickVolume * gainMul;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (level === 'sub' ? 0.035 : 0.06));
    osc.connect(gain).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.07);
    this.#track(osc, t);
  }

  /** 녹음 클립 재생. slot이 있으면 그 안에 들어가도록 조금 빠르게 읽는다. */
  #voiceClip(keys, at, slot) {
    if (this.settings.voiceSet === 'device' || !this.voice.has(keys)) {
      if (keys.length === 1 && keys[0] === 'and') return;
      this.#speech(keys.join(' '), at);
      return;
    }
    let rate = 1;
    if (slot) {
      const clip = this.voice.clips.get(keys[0]);
      const need = clip.buffer.duration - clip.onset;
      rate = Math.min(1.6, Math.max(1, need / (slot * 0.95)));
    }
    this.voiceOutGain();
    // 이전 음성이 아직 나오고 있으면 새 음성 시작에 맞춰 끊는다
    const prev = this.lastVoice;
    this.voice.schedule(keys, at, this.voiceOut, {
      rate,
      onNode: (node, start) => {
        if (prev && prev !== node) {
          try {
            prev.stop(Math.max(this.ctx.currentTime, start));
          } catch { /* 무시 */ }
        }
        this.lastVoice = node;
        this.#track(node, start);
      },
    });
  }

  voiceOutGain() {
    this.voiceOut.gain.value = this.settings.voiceVolume;
  }

  #brief(text, at) {
    const keys = clipsFor(text);
    if (keys && this.settings.voiceSet !== 'device' && this.voice.has(keys)) this.#voiceClip(keys, at);
    else this.#speech(text, at);
  }

  #speechLead() {
    return (this.settings.speechAutoMs + this.settings.speechLeadMs) / 1000;
  }

  /** 기기 음성 합성: 측정된 지연만큼 미리 말하기 시작 */
  #speech(text, at) {
    if (!this.synth) return;
    const fireAt = at - this.#speechLead();
    const delay = Math.max(0, (fireAt - this.ctx.currentTime) * 1000);
    const timer = setTimeout(() => {
      this.speechTimers.delete(timer);
      this.speak(text);
    }, delay);
    this.speechTimers.set(timer, at);
  }

  voices() {
    return this.synth ? this.synth.getVoices() : [];
  }

  /** 즉시 말하기 (기기 음성). 시작까지 걸린 시간을 재서 다음 예약에 반영한다. */
  speak(text) {
    if (!this.synth) return;
    if (this.synth.speaking || this.synth.pending) this.synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.voices().find((v) => v.voiceURI === this.settings.voiceURI);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = /[가-힣]/.test(text) ? 'ko-KR' : 'en-US';
    }
    u.rate = 1.1;
    u.volume = this.settings.voiceVolume;
    const t0 = performance.now();
    u.onstart = () => {
      // 음성 엔진이 실제로 말하기 시작할 때까지의 지연(+출력 지연 근사)을 서서히 학습
      const measured = performance.now() - t0 + 60;
      if (measured > 0 && measured < 1500) {
        this.settings.speechAutoMs = Math.round(this.settings.speechAutoMs * 0.6 + measured * 0.4);
        this.onSettingsLearned?.();
      }
    };
    this.synth.speak(u);
  }

  /** 미리 듣기 */
  preview(text) {
    if (!this.ctx) return;
    const keys = clipsFor(text);
    if (keys && this.settings.voiceSet !== 'device' && this.voice.has(keys)) {
      this.voiceOutGain();
      this.voice.schedule(keys, this.ctx.currentTime + 0.15, this.voiceOut);
    } else {
      this.speak(text);
    }
  }
}
