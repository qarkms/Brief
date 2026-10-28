// 메트로놈 클릭 + 음성 브리핑 스케줄러.
// 서버 시각 startAt을 이 기기의 AudioContext 시각으로 변환해서
// 클릭을 Web Audio로 미리 예약하므로 모든 기기에서 같은 순간에 소리가 난다.

const LOOKAHEAD = 0.6; // 초: 이만큼 앞의 클릭을 미리 예약
const RESYNC_EVERY = 1.0; // 초: 시계 보정 주기

const TICKER_SRC = `let id=null;onmessage=e=>{if(e.data==='start'){if(!id)id=setInterval(()=>postMessage(0),25)}else{clearInterval(id);id=null}}`;

export const DEFAULT_SETTINGS = {
  click: true,
  clickVolume: 0.8,
  voice: true,
  voiceVolume: 1,
  voiceRate: 1.1,
  voicePitch: 0.8,
  voiceURI: '',
  latencyMs: 0,
  speechLeadMs: 150,
  wakeLock: true,
};

export class Engine {
  constructor(conn, settings) {
    this.conn = conn;
    this.settings = settings;
    this.ctx = null;
    this.plan = null;
    this.startAt = 0;
    this.nodes = new Set();
    this.pendingSpeech = [];
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
    return resumed;
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
    this.startAt = startAt;
    this.audioStart = this.#audioTimeFor(startAt);
    this.lastResync = this.ctx.currentTime;
    this.barIdx = 0;
    this.beatIdx = 0;
    this.briefIdx = 0;
    this.ticker.postMessage('start');
    this.#tick();
  }

  stop() {
    this.ticker.postMessage('stop');
    this.plan = null;
    for (const n of this.nodes) {
      try {
        n.stop(0);
      } catch { /* 이미 끝남 */ }
    }
    this.nodes.clear();
    this.pendingSpeech = [];
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

  #tick() {
    const plan = this.plan;
    if (!plan || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.#resync(now);
    const horizon = now + LOOKAHEAD;
    const { bars, briefs } = plan;

    while (this.barIdx < bars.length) {
      const bar = bars[this.barIdx];
      const t = this.audioStart + bar.t + this.beatIdx * bar.beatDur;
      if (t > horizon) break;
      // 늦게 들어온 경우 지나간 박은 건너뛴다
      if (t >= now - 0.01 && this.settings.click) {
        const level = this.beatIdx > 0 ? 0 : (bar.bar === 1 && bar.sectionIndex >= 0 ? 2 : 1);
        this.#click(Math.max(t, now), level);
      }
      if (++this.beatIdx >= bar.beats) {
        this.beatIdx = 0;
        this.barIdx++;
      }
    }

    while (this.briefIdx < briefs.length) {
      const br = briefs[this.briefIdx];
      const at = this.audioStart + br.t;
      if (at > horizon) break;
      if (at >= now - 0.3) this.pendingSpeech.push({ at, text: br.text });
      this.briefIdx++;
    }
    if (this.pendingSpeech.length) {
      const lead = this.settings.speechLeadMs / 1000;
      const due = this.pendingSpeech.filter((s) => s.at - lead <= now);
      if (due.length) {
        this.pendingSpeech = this.pendingSpeech.filter((s) => s.at - lead > now);
        if (this.settings.voice) this.speak(due[due.length - 1].text);
      }
    }

    if (this.barIdx >= bars.length && this.briefIdx >= briefs.length
      && !this.pendingSpeech.length && now > this.audioStart + plan.duration + 0.3) {
      this.ticker.postMessage('stop');
      this.plan = null;
      this.onEnded?.();
    }
  }

  // level 0: 일반 박, 1: 마디 첫 박, 2: 새 파트 첫 박
  #click(t, level) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = [1000, 1600, 2200][level];
    const vol = this.settings.clickVolume * [0.6, 1, 1][level];
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(gain).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.07);
    this.nodes.add(osc);
    osc.onended = () => this.nodes.delete(osc);
  }

  voices() {
    return this.synth ? this.synth.getVoices() : [];
  }

  speak(text) {
    if (!this.synth) {
      this.#beepFallback();
      return;
    }
    this.synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.voices().find((v) => v.voiceURI === this.settings.voiceURI);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = 'en-US';
    }
    u.rate = this.settings.voiceRate;
    u.pitch = this.settings.voicePitch;
    u.volume = this.settings.voiceVolume;
    this.synth.speak(u);
  }

  #beepFallback() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) this.#click(t + i * 0.12, 2);
  }
}
