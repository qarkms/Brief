// 바깥 저장소(Supabase Storage)에 방·악보를 함께 보관한다.
// 무료 서버가 잠들거나 새로 배포되어 서버 디스크가 지워져도, 켜질 때 여기서 다시 가져온다.
// 환경변수 SUPABASE_URL, SUPABASE_SERVICE_KEY 가 있을 때만 켜진다 (없으면 지금처럼 서버 디스크만 사용).
import fs from 'node:fs';
import path from 'node:path';

const BUCKET_DEFAULT = 'echad';

export class RemoteStore {
  constructor({
    url, key, bucket = BUCKET_DEFAULT, fetchImpl = globalThis.fetch,
  }) {
    this.base = `${String(url).replace(/\/+$/, '')}/storage/v1`;
    this.key = key;
    this.bucket = bucket;
    this.fetch = fetchImpl;
    this.writing = new Map(); // name -> { running, next }
  }

  /** 환경변수가 다 있으면 저장소를 만들고, 아니면 null */
  static fromEnv(env = process.env) {
    const url = (env.SUPABASE_URL || '').trim();
    const key = (env.SUPABASE_SERVICE_KEY || '').trim();
    if (!url || !key) return null;
    return new RemoteStore({ url, key, bucket: (env.SUPABASE_BUCKET || BUCKET_DEFAULT).trim() });
  }

  headers(extra = {}) {
    // 예전 service_role 키(JWT)는 Authorization 헤더도, 새 sb_secret 키는 apikey 헤더만으로 된다
    const h = { apikey: this.key, ...extra };
    if (this.key.startsWith('eyJ')) h.authorization = `Bearer ${this.key}`;
    return h;
  }

  objectUrl(name) {
    return `${this.base}/object/${this.bucket}/${name.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** 버킷이 없으면 비공개로 만든다 (처음 한 번) */
  async ensureBucket() {
    const res = await this.fetch(`${this.base}/bucket/${this.bucket}`, { headers: this.headers() });
    if (res.ok) return;
    const made = await this.fetch(`${this.base}/bucket`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false }),
    });
    if (!made.ok && made.status !== 409) {
      throw new Error(`Supabase 버킷을 만들 수 없어요 (${made.status}): ${await made.text()}`);
    }
  }

  async get(name) {
    const res = await this.fetch(this.objectUrl(name), { headers: this.headers() });
    if (!res.ok) return null;
    return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'application/octet-stream' };
  }

  async put(name, body, type) {
    const res = await this.fetch(this.objectUrl(name), {
      method: 'POST',
      headers: this.headers({ 'content-type': type, 'x-upsert': 'true', 'cache-control': 'no-cache' }),
      body,
    });
    if (!res.ok) throw new Error(`Supabase 저장 실패 ${name} (${res.status})`);
  }

  /**
   * 같은 이름을 자주 고쳐 쓸 때: 쓰는 중이면 끝난 뒤 가장 마지막 내용만 한 번 더 쓴다.
   * 실패는 기록만 하고 다음 저장 때 다시 시도된다.
   */
  putLatest(name, body, type = 'application/json') {
    const slot = this.writing.get(name) || { running: null, next: null };
    this.writing.set(name, slot);
    slot.next = { body, type };
    if (!slot.running) {
      slot.running = (async () => {
        while (slot.next) {
          const job = slot.next;
          slot.next = null;
          try {
            await this.put(name, job.body, job.type);
          } catch (e) {
            console.error(e.message);
          }
        }
        slot.running = null;
      })();
    }
    return slot.running;
  }

  async remove(names) {
    if (!names.length) return;
    const res = await this.fetch(`${this.base}/object/${this.bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: names }),
    });
    if (!res.ok) console.error(`Supabase 삭제 실패 (${res.status})`);
  }

  /** 진행 중인 저장이 끝날 때까지 기다린다 (서버 종료 직전) */
  async flush() {
    await Promise.all([...this.writing.values()].map((s) => s.running).filter(Boolean));
  }

  /** 저장소에 파일이 있으면 로컬 파일로 내려받는다 */
  async pull(name, file) {
    const got = await this.get(name);
    if (!got) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, got.buf);
    return true;
  }

  /** Supabase 무료 프로젝트는 오래 안 쓰면 일시정지되므로 가끔 가볍게 접속한다 */
  async touch() {
    try {
      await this.fetch(`${this.base}/bucket/${this.bucket}`, { headers: this.headers() });
    } catch { /* 다음에 다시 */ }
  }
}
