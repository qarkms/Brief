// 계정 (선택): 로그인해 두면 이 기기의 데이터를 서버 계정에도 보관하고, 다른 기기·다시 설치한 앱에서 로그인하면 돌려받는다.
// 보관하는 것: 이름 · 기기 설정 · 보관함(곡·셋리스트) · 내 방 목록 · 방장 권한 · 내 악보 · 필기 · 악보 그림
// 부방장 권한과 참가자 목록은 "계정 열쇠"(기기 키)로 알아본다. 로그인하면 이 기기의 키가 계정 열쇠로 바뀐다.
import {
  getCachedBlob, listCachedIds, setBlobHooks,
} from './sheets.js';

const ACCT = 'brief.account';
const SETTINGS = 'brief.settings';
const ARRAY_BY = { 'brief.library': 'id', 'brief.setlists': 'id', 'brief.rooms': 'code' };
const MAPS = new Set(['brief.mysheets', 'brief.sheetpick']);
const PLAIN = new Set(['brief.name', SETTINGS, ...Object.keys(ARRAY_BY), ...MAPS]);
/** 계정에 보관하는 키 */
export const isSynced = (k) => PLAIN.has(k) || k.startsWith('brief.host.') || k.startsWith('brief.ink.');

const proto = Storage.prototype;
const rawSet = proto.setItem;
const rawRemove = proto.removeItem;
const rawGet = (k) => localStorage.getItem(k);

let acct = null;
try {
  acct = JSON.parse(rawGet(ACCT) || 'null');
} catch { acct = null; }

const listeners = new Set();
const emit = (type, detail) => {
  for (const fn of listeners) fn(type, detail);
};
/** type: 'state' (로그인 상태·동기화 시각이 바뀜), 'data' (다른 기기의 데이터가 들어옴), 'error' */
export const onAccount = (fn) => listeners.add(fn);

function saveAcct() {
  if (acct) rawSet.call(localStorage, ACCT, JSON.stringify(acct));
  else rawRemove.call(localStorage, ACCT);
  emit('state', status());
}

export const status = () => (acct ? {
  id: acct.id, at: acct.at || 0, dirty: !!acct.dirty, syncing: busy, error: acct.error || '',
} : null);

// ---------- 바뀐 것 알아채기: 계정에 보관하는 키를 쓰면 잠시 뒤 서버에 올린다 ----------
let applying = false;
let seq = 0;
let pushTimer = 0;
function touched(k) {
  if (!acct || applying || !isSynced(k)) return;
  seq++;
  if (!acct.dirty) {
    acct.dirty = true;
    saveAcct();
  }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync(), 1500);
}
proto.setItem = function setItem(k, v) {
  rawSet.call(this, k, v);
  if (this === localStorage) touched(k);
};
proto.removeItem = function removeItem(k) {
  rawRemove.call(this, k);
  if (this === localStorage) touched(k);
};

// ---------- 서버 ----------
const ERRORS = {
  BAD_ID: '아이디는 3~20자의 한글·영문·숫자(. _ -)로 정해 주세요',
  BAD_PASSWORD: '비밀번호는 6자 이상으로 정해 주세요',
  ID_TAKEN: '이미 있는 아이디예요. 다른 아이디를 정해 주세요',
  WRONG_LOGIN: '아이디 또는 비밀번호가 맞지 않아요',
  WRONG_PASSWORD: '비밀번호가 맞지 않아요',
  NO_LOGIN: '로그인이 풀렸어요. 다시 로그인해 주세요',
  TOO_LARGE: '데이터가 너무 커서 저장할 수 없어요',
  ACCOUNT_FULL: '계정 저장 공간이 가득 찼어요',
};

async function api(route, { method = 'GET', body, raw, type } = {}) {
  const headers = {};
  if (acct?.token) headers['x-echad-account'] = acct.token;
  if (body !== undefined) headers['content-type'] = type || 'application/json';
  let res;
  try {
    res = await fetch(`/api/account/${route}`, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  } catch {
    const e = new Error('인터넷 연결을 확인해 주세요');
    e.code = 'OFFLINE';
    throw e;
  }
  if (res.ok) return (res.headers.get('content-type') || '').includes('json') ? res.json() : res.blob();
  const info = await res.json().catch(() => ({}));
  const msg = info.error === 'TOO_MANY_TRIES'
    ? `여러 번 틀려서 잠시 막혔어요. ${info.retryAfter || 30}초 뒤에 다시 해 주세요`
    : ERRORS[info.error] || '잠시 뒤에 다시 해 주세요';
  const e = new Error(msg);
  e.code = info.error;
  e.rev = info.rev;
  throw e;
}

// ---------- 데이터 묶기·합치기 ----------
function collect() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && isSynced(k)) out[k] = rawGet(k);
  }
  return out;
}

const parse = (v, fb) => {
  try { return JSON.parse(v) ?? fb; } catch { return fb; }
};

/** 두 묶음을 합친다. 같은 곡·셋리스트·방·필기가 양쪽에 있으면 prefer 쪽을 쓴다 */
function merge(local, remote, prefer) {
  const [win, lose] = prefer === 'local' ? [local, remote] : [remote, local];
  const out = { ...lose, ...win };
  for (const [k, by] of Object.entries(ARRAY_BY)) {
    if (!(k in local) || !(k in remote)) continue;
    const map = new Map();
    for (const it of parse(lose[k], [])) if (it?.[by]) map.set(it[by], it);
    for (const it of parse(win[k], [])) if (it?.[by]) map.set(it[by], it);
    out[k] = JSON.stringify([...map.values()]);
  }
  for (const k of MAPS) {
    if (k in local && k in remote) out[k] = JSON.stringify({ ...parse(lose[k], {}), ...parse(win[k], {}) });
  }
  return out;
}

/** 서버 묶음을 이 기기에 쓴다. 기기 설정(블루투스 지연 등)은 처음 로그인할 때 이 기기에 없을 때만 */
function apply(data, { first = false } = {}) {
  applying = true;
  try {
    const now = collect();
    for (const k of Object.keys(now)) {
      if (k === SETTINGS) continue;
      if (!(k in data)) rawRemove.call(localStorage, k);
    }
    for (const [k, v] of Object.entries(data)) {
      if (!isSynced(k) || typeof v !== 'string') continue;
      if (k === SETTINGS && !(first && !(k in now))) continue;
      if (now[k] !== v) {
        try { rawSet.call(localStorage, k, v); } catch { /* 저장 공간 부족 */ }
      }
    }
  } finally {
    applying = false;
  }
}

/** 지금 쓰는 악보 그림 id: 보관함 곡·셋리스트의 악보 + 내 악보 */
function referencedIds() {
  const ids = new Set();
  const addSongs = (songs) => {
    for (const s of Array.isArray(songs) ? songs : []) for (const p of s?.sheets || []) if (p?.id) ids.add(p.id);
  };
  addSongs(parse(rawGet('brief.library'), []));
  for (const sl of parse(rawGet('brief.setlists'), [])) addSongs(sl?.songs);
  for (const pages of Object.values(parse(rawGet('brief.mysheets'), {}))) {
    for (const p of Array.isArray(pages) ? pages : []) if (p?.id) ids.add(p.id);
  }
  return ids;
}

// ---------- 악보 그림 ----------
let remoteBlobs = null; // 서버에 이미 있는 그림 id
async function uploadBlob(id, blob) {
  if (!acct || remoteBlobs?.has(id)) return;
  const type = /^image\//.test(blob.type) ? blob.type : 'image/jpeg';
  await api(`blob/${id}`, {
    method: 'PUT', body: blob, raw: true, type,
  });
  remoteBlobs?.add(id);
}

async function syncBlobs() {
  const { ids } = await api('blobs');
  remoteBlobs = new Set(ids);
  const wanted = referencedIds();
  for (const id of await listCachedIds()) {
    if (!wanted.has(id) || remoteBlobs.has(id)) continue;
    const blob = await getCachedBlob(id);
    if (blob) await uploadBlob(id, blob);
  }
}

setBlobHooks({
  // 새로 넣은 악보 그림: 잠시 뒤(곡·내 악보에 연결된 다음) 동기화 때 올라간다
  onSaved: () => {
    if (acct) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => sync(), 1500);
    }
  },
  fallback: async (id) => (acct ? api(`blob/${id}`).catch(() => null) : null),
});

// ---------- 동기화 ----------
let busy = false;
let again = false;
/** 서버와 맞춘다: 다른 기기에서 바뀐 것은 받아 오고, 이 기기에서 바뀐 것은 올린다 */
export async function sync() {
  if (!acct) return;
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  clearTimeout(pushTimer);
  emit('state', status());
  let gotData = false;
  try {
    for (let round = 0; round < 3; round++) {
      const remote = await api(`vault?since=${acct.rev}`);
      if (!remote.unchanged && remote.rev !== acct.rev) {
        const theirs = remote.data || {};
        apply(acct.dirty ? merge(collect(), theirs, 'local') : theirs);
        acct.rev = remote.rev;
        gotData = true;
      }
      if (!acct.dirty) break;
      const mark = seq;
      try {
        const r = await api(`vault?base=${acct.rev}`, { method: 'PUT', body: collect() });
        acct.rev = r.rev;
        if (seq === mark) acct.dirty = false;
        break;
      } catch (e) {
        if (e.code !== 'STALE') throw e; // 그 사이 다른 기기가 바꿨다 → 받아서 합치고 다시
      }
    }
    await syncBlobs();
    acct.at = Date.now();
    acct.error = '';
  } catch (e) {
    if (acct) {
      acct.error = e.message;
      if (e.code === 'NO_LOGIN') {
        // 다른 기기에서 비밀번호를 바꿨거나 계정을 지웠다
        acct = null;
        emit('error', '로그인이 풀렸어요. 내 정보에서 다시 로그인해 주세요');
      }
    }
  } finally {
    busy = false;
    saveAcct();
    if (gotData) emit('data');
    if (again) {
      again = false;
      sync();
    }
  }
}

// ---------- 계정 만들기 · 로그인 · 로그아웃 ----------
const deviceKey = () => parse(rawGet('brief.key'), '');

/** 지금 기기의 데이터와 권한을 그대로 새 계정으로 */
export async function signup(id, password) {
  const r = await api('signup', { method: 'POST', body: { id, password, key: deviceKey() } });
  acct = {
    id: r.id, token: r.token, rev: 0, dirty: true, at: 0,
  };
  saveAcct();
  await sync();
  return r.id;
}

/**
 * 로그인: 계정 열쇠를 이 기기의 키로 쓰고, 계정 데이터를 받아 이 기기의 데이터와 합친다.
 * 이 기기에만 있던 곡·셋리스트 등은 사라지지 않고 계정에 더해진다. 다 끝나면 앱을 다시 불러온다.
 */
export async function login(id, password) {
  const r = await api('login', { method: 'POST', body: { id, password } });
  acct = {
    id: r.id, token: r.token, rev: 0, dirty: false, at: 0,
  };
  saveAcct();
  rawSet.call(localStorage, 'brief.key', JSON.stringify(r.key));
  const remote = await api('vault');
  const local = collect();
  apply(merge(local, remote.data || {}, 'remote'), { first: true });
  acct.rev = remote.rev;
  // 이 기기에만 있던 것이 있으면 계정에도 올린다
  acct.dirty = Object.keys(local).some((k) => k !== SETTINGS && local[k] !== (remote.data || {})[k]);
  saveAcct();
  await sync();
  return r.id;
}

/** 로그아웃: 이 기기의 데이터는 그대로 두고 동기화만 멈춘다 */
export async function logout() {
  if (!acct) return;
  if (acct.dirty) await sync().catch(() => {});
  await api('logout', { method: 'POST' }).catch(() => {});
  acct = null;
  remoteBlobs = null;
  saveAcct();
}

export async function changePassword(current, next) {
  const r = await api('password', { method: 'POST', body: { current, next } });
  acct.token = r.token;
  saveAcct();
}

/** 계정 지우기: 서버에 맡긴 데이터만 지운다. 이 기기의 데이터는 그대로 */
export async function deleteAccount(password) {
  await api('delete', { method: 'POST', body: { password } });
  acct = null;
  remoteBlobs = null;
  saveAcct();
}

export const isLoggedIn = () => !!acct;

// 앱을 열 때, 다시 돌아올 때, 그리고 켜져 있는 동안 가끔 맞춘다
if (acct) setTimeout(() => sync(), 800);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && acct) sync();
  else if (acct?.dirty) sync(); // 앱을 떠날 때 남은 것 올리기
});
setInterval(() => {
  if (acct && document.visibilityState === 'visible') sync();
}, 120_000);
