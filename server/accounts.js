// 계정 (선택): 아이디 + 비밀번호로 내 데이터(권한·보관함·내 악보·필기)를 서버에 보관한다.
// 앱을 지웠거나 기기를 바꿔도 로그인하면 돌아온다.
//
// 비밀번호는 저장하지 않고 scrypt 해시만 저장한다. 로그인하면 세션 토큰을 주고, 서버에는 토큰의 지문만 둔다.
// 저장 위치: <dir>/<아이디 지문>.json (계정), <dir>/<아이디 지문>/vault.json (데이터), <dir>/<아이디 지문>/blobs/<id> (악보 그림)
// 바깥 저장소(Supabase)가 있으면 같은 이름으로 accounts/... 에도 저장한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ACCOUNT_ID = /^[0-9a-z가-힣._-]{3,20}$/;
export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 128;
export const MAX_VAULT_BYTES = 5 * 1024 * 1024;
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_BLOBS = 3000;
const MAX_ACCOUNT_BYTES = 400 * 1024 * 1024;
const MAX_SESSIONS = 10;
const BLOB_ID = /^[a-f0-9]{32}$/;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 아이디는 대소문자·조합형 차이 없이 같은 것으로 본다 */
export function normalizeId(v) {
  return typeof v === 'string' ? v.normalize('NFC').trim().toLowerCase() : '';
}

/**
 * 비밀번호를 연달아 틀리면 잠시 막는다 (아이디별·접속 주소별).
 * 5번째 실패부터 30초, 그 뒤로 실패할 때마다 두 배 (최대 15분).
 */
class Limiter {
  constructor() {
    this.map = new Map();
  }

  waitMs(k, now = Date.now()) {
    const e = this.map.get(k);
    return e && e.until > now ? e.until - now : 0;
  }

  fail(k, now = Date.now()) {
    const e = this.map.get(k) || { n: 0, until: 0 };
    e.n += 1;
    if (e.n >= 5) e.until = now + Math.min(15 * 60_000, 30_000 * 2 ** (e.n - 5));
    this.map.set(k, e);
    if (this.map.size > 5000) this.map.delete(this.map.keys().next().value);
  }

  ok(k) {
    this.map.delete(k);
  }
}

export class AccountError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export class AccountStore {
  constructor(dir, { remote = null } = {}) {
    this.dir = dir;
    this.remote = remote;
    this.cache = new Map(); // 아이디 지문 → 계정 기록 (없는 계정은 null)
    this.limiter = new Limiter();
    fs.mkdirSync(dir, { recursive: true });
  }

  // ---------- 저장 ----------
  recordFile(h) {
    return path.join(this.dir, `${h}.json`);
  }

  dataFile(h, name) {
    return path.join(this.dir, h, name);
  }

  async load(h) {
    if (this.cache.has(h)) return this.cache.get(h);
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(this.recordFile(h), 'utf8'));
    } catch {
      if (this.remote) {
        const got = await this.remote.get(`accounts/${h}.json`).catch(() => null);
        if (got) {
          try {
            rec = JSON.parse(got.buf.toString('utf8'));
            fs.writeFileSync(this.recordFile(h), got.buf);
          } catch { rec = null; }
        }
      }
    }
    // 동시에 다른 요청이 먼저 넣었으면 그것을 쓴다
    if (this.cache.has(h)) return this.cache.get(h);
    this.cache.set(h, rec);
    return rec;
  }

  saveRecord(rec) {
    const json = JSON.stringify(rec);
    fs.writeFileSync(this.recordFile(rec.h), json);
    this.remote?.putLatest(`accounts/${rec.h}.json`, json);
  }

  async readData(h, name) {
    const file = this.dataFile(h, name);
    try {
      return fs.readFileSync(file);
    } catch {
      if (!this.remote) return null;
      const got = await this.remote.get(`accounts/${h}/${name}`).catch(() => null);
      if (!got) return null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, got.buf);
      return got.buf;
    }
  }

  writeData(h, name, buf, type) {
    const file = this.dataFile(h, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    this.remote?.putLatest(`accounts/${h}/${name}`, buf, type);
  }

  // ---------- 계정 ----------
  async newSession(rec) {
    const tok = crypto.randomBytes(24).toString('base64url');
    rec.sessions = [...(rec.sessions || []), { t: sha(tok), at: Date.now() }].slice(-MAX_SESSIONS);
    this.saveRecord(rec);
    return `${rec.h}.${tok}`;
  }

  async signup({ id, password, key }) {
    const nid = normalizeId(id);
    if (!ACCOUNT_ID.test(nid)) throw new AccountError('BAD_ID');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) throw new AccountError('BAD_PASSWORD');
    const h = sha(`id:${nid}`);
    if (await this.load(h)) throw new AccountError('ID_TAKEN', 409);
    const salt = crypto.randomBytes(16);
    const rec = {
      h,
      id: nid,
      salt: salt.toString('base64'),
      hash: (await scrypt(password, salt)).toString('base64'),
      // 계정 열쇠: 방 참가자·부방장을 알아보는 기기 키. 계정을 만든 기기의 키를 그대로 써서 지금 권한이 이어진다
      key: typeof key === 'string' && KEY.test(key) ? key : crypto.randomBytes(16).toString('hex'),
      createdAt: Date.now(),
      sessions: [],
      vaultRev: 0,
      blobs: {},
    };
    // 같은 아이디로 동시에 만들려 할 때
    if (this.cache.get(h)) throw new AccountError('ID_TAKEN', 409);
    this.cache.set(h, rec);
    const token = await this.newSession(rec);
    return { id: nid, token, key: rec.key };
  }

  async checkPassword(rec, password) {
    if (typeof password !== 'string' || password.length > MAX_PASSWORD) return false;
    const got = await scrypt(password, Buffer.from(rec.salt, 'base64'));
    const want = Buffer.from(rec.hash, 'base64');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  async login({ id, password }, ip = '') {
    const nid = normalizeId(id);
    const keys = [`id:${nid}`, `ip:${ip}`];
    const wait = Math.max(...keys.map((k) => this.limiter.waitMs(k)));
    if (wait) throw new AccountError('TOO_MANY_TRIES', 429, { retryAfter: Math.ceil(wait / 1000) });
    const rec = ACCOUNT_ID.test(nid) ? await this.load(sha(`id:${nid}`)) : null;
    // 없는 아이디도 같은 시간이 걸리게 (아이디가 있는지 알아내기 어렵게)
    const ok = rec ? await this.checkPassword(rec, password) : (await scrypt('x', 'y'), false);
    if (!ok) {
      for (const k of keys) this.limiter.fail(k);
      throw new AccountError('WRONG_LOGIN', 401);
    }
    for (const k of keys) this.limiter.ok(k);
    const token = await this.newSession(rec);
    return { id: rec.id, token, key: rec.key };
  }

  /** "아이디지문.토큰" → 계정 기록 */
  async auth(header) {
    const m = /^([a-f0-9]{64})\.([A-Za-z0-9_-]{20,64})$/.exec(String(header || '').trim());
    if (!m) throw new AccountError('NO_LOGIN', 401);
    const rec = await this.load(m[1]);
    const t = sha(m[2]);
    if (!rec || !(rec.sessions || []).some((s) => s.t === t)) throw new AccountError('NO_LOGIN', 401);
    return { rec, t };
  }

  async logout(header) {
    const { rec, t } = await this.auth(header);
    rec.sessions = rec.sessions.filter((s) => s.t !== t);
    this.saveRecord(rec);
  }

  /** 비밀번호 바꾸기: 다른 기기의 로그인은 모두 풀린다 */
  async changePassword(header, { current, next }) {
    const { rec } = await this.auth(header);
    if (!(await this.checkPassword(rec, current))) throw new AccountError('WRONG_PASSWORD', 401);
    if (typeof next !== 'string' || next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) throw new AccountError('BAD_PASSWORD');
    const salt = crypto.randomBytes(16);
    rec.salt = salt.toString('base64');
    rec.hash = (await scrypt(next, salt)).toString('base64');
    rec.sessions = [];
    const token = await this.newSession(rec);
    return { token };
  }

  /** 계정 지우기: 서버에 맡긴 데이터와 악보 그림까지 모두 지운다 (기기에 있는 것은 그대로) */
  async remove(header, { password }) {
    const { rec } = await this.auth(header);
    if (!(await this.checkPassword(rec, password))) throw new AccountError('WRONG_PASSWORD', 401);
    const names = [`accounts/${rec.h}.json`, `accounts/${rec.h}/vault.json`, ...Object.keys(rec.blobs || {}).map((b) => `accounts/${rec.h}/blobs/${b}`)];
    fs.rmSync(path.join(this.dir, rec.h), { recursive: true, force: true });
    fs.rmSync(this.recordFile(rec.h), { force: true });
    this.cache.set(rec.h, null);
    if (this.remote) {
      await this.remote.flush();
      for (let i = 0; i < names.length; i += 500) await this.remote.remove(names.slice(i, i + 500));
    }
  }

  // ---------- 데이터 ----------
  /** since: 이 기기가 가진 판. 같으면 내용 없이 알려 준다 (자주 확인해도 가볍게) */
  async getVault(header, since = null) {
    const { rec } = await this.auth(header);
    if (since !== null && Number(since) === (rec.vaultRev || 0)) return { id: rec.id, rev: rec.vaultRev || 0, unchanged: true };
    const buf = rec.vaultRev ? await this.readData(rec.h, 'vault.json') : null;
    return { id: rec.id, rev: rec.vaultRev || 0, data: buf ? JSON.parse(buf.toString('utf8')) : null };
  }

  /** base: 이 기기가 마지막으로 본 판. 그 사이 다른 기기가 바꿨으면 409로 알려 다시 합치게 한다 */
  async putVault(header, base, data) {
    const { rec } = await this.auth(header);
    if (Number(base) !== (rec.vaultRev || 0)) throw new AccountError('STALE', 409, { rev: rec.vaultRev || 0 });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AccountError('BAD_DATA');
    const buf = Buffer.from(JSON.stringify(data));
    if (buf.length > MAX_VAULT_BYTES) throw new AccountError('TOO_LARGE', 413);
    rec.vaultRev = (rec.vaultRev || 0) + 1;
    this.writeData(rec.h, 'vault.json', buf, 'application/json');
    rec.vaultAt = Date.now();
    this.saveRecord(rec);
    return { rev: rec.vaultRev };
  }

  async listBlobs(header) {
    const { rec } = await this.auth(header);
    return Object.keys(rec.blobs || {});
  }

  async putBlob(header, id, buf, type) {
    const { rec } = await this.auth(header);
    if (!BLOB_ID.test(id)) throw new AccountError('BAD_ID');
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new AccountError('BAD_TYPE');
    rec.blobs ||= {};
    if (rec.blobs[id]) return;
    const used = Object.values(rec.blobs).reduce((a, b) => a + b.size, 0);
    if (Object.keys(rec.blobs).length >= MAX_BLOBS || used + buf.length > MAX_ACCOUNT_BYTES) throw new AccountError('ACCOUNT_FULL', 507);
    this.writeData(rec.h, `blobs/${id}`, buf, type);
    rec.blobs[id] = { size: buf.length, type };
    this.saveRecord(rec);
  }

  async getBlob(header, id) {
    const { rec } = await this.auth(header);
    const meta = BLOB_ID.test(id) && rec.blobs?.[id];
    if (!meta) return null;
    const buf = await this.readData(rec.h, `blobs/${id}`);
    return buf ? { buf, type: meta.type } : null;
  }
}
