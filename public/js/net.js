// WebSocket 연결 + 서버 시계 동기화(NTP 방식).
// offset: 서버시각(ms) ≈ performance.now() + offset

const SAMPLE_WINDOW = 12;

export class Connection extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.retry = 0;
    this.wantOpen = false;
    this.samples = [];
    this.offset = Date.now() - performance.now();
    this.rtt = null;
    this.synced = false;
    this.pingTimer = null;
  }

  get open() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect() {
    this.wantOpen = true;
    if (!this.ws) this.#open();
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.#emit('open');
      this.#startSync();
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') this.#onPong(msg);
      else this.#emit(msg.type, msg);
    };
    ws.onclose = () => {
      this.ws = null;
      clearInterval(this.pingTimer);
      this.#emit('close');
      if (this.wantOpen) {
        const delay = Math.min(5000, 400 * 2 ** this.retry++);
        setTimeout(() => this.#open(), delay);
      }
    };
  }

  send(type, data = {}) {
    if (this.open) this.ws.send(JSON.stringify({ type, ...data }));
  }

  serverNow() {
    return performance.now() + this.offset;
  }

  #ping() {
    this.send('ping', { t0: performance.now() });
  }

  #startSync() {
    clearInterval(this.pingTimer);
    // 접속 직후 빠르게 여러 번 측정, 이후 주기적으로 갱신
    let burst = 0;
    this.pingTimer = setInterval(() => {
      this.#ping();
      if (++burst === 8) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.#ping(), 3000);
      }
    }, 120);
  }

  #onPong({ t0, ts }) {
    const t1 = performance.now();
    const rtt = t1 - t0;
    if (!(rtt >= 0)) return;
    this.samples.push({ rtt, offset: ts - (t0 + t1) / 2 });
    if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();
    // 왕복시간이 가장 짧은 측정값이 가장 정확하다
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.rtt = best.rtt;
    this.synced = this.samples.length >= 3;
    this.#emit('sync', { rtt: this.rtt });
  }
}
