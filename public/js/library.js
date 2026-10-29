// 이 기기의 저장소: 보관함 곡(송폼+악보) · 셋리스트 · 내 방 목록
import { makeId, normalizeSetlist, normalizeSong } from './timeline.js';

const KEYS = { songs: 'brief.library', setlists: 'brief.setlists', rooms: 'brief.rooms' };

function read(key, fallback = []) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // 저장 공간 부족
  }
}

const byTitle = (a, b) => a.title.localeCompare(b.title, 'ko');

// ---------- 곡 ----------
export function loadLibrary() {
  const list = read(KEYS.songs);
  return Array.isArray(list) ? list.map(normalizeSong) : [];
}

/** id가 같으면 고치고, 없으면 새로 저장 */
export function putSong(song) {
  const list = loadLibrary();
  const s = { ...normalizeSong(song), updatedAt: Date.now() };
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) list[i] = s;
  else list.push(s);
  list.sort(byTitle);
  write(KEYS.songs, list);
  return s;
}

/** 방에서 "보관함에 저장": 같은 제목이 있으면 덮어쓴다 */
export function saveToLibrary(song) {
  const existing = loadLibrary().find((s) => s.title === song.title);
  return putSong({ ...song, id: existing ? existing.id : makeId() });
}

export function removeFromLibrary(id) {
  write(KEYS.songs, loadLibrary().filter((s) => s.id !== id));
}

// ---------- 셋리스트 ----------
export function loadSetlists() {
  const list = read(KEYS.setlists);
  if (!Array.isArray(list)) return [];
  return list.map((sl) => ({
    id: String(sl.id || makeId()),
    name: String(sl.name || '셋리스트').slice(0, 60),
    songs: normalizeSetlist(sl.songs),
    updatedAt: Number(sl.updatedAt) || 0,
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function putSetlist(sl) {
  const list = loadSetlists();
  const s = {
    id: sl.id || makeId(), name: (sl.name || '').trim() || '새 셋리스트', songs: normalizeSetlist(sl.songs), updatedAt: Date.now(),
  };
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) list[i] = s;
  else list.unshift(s);
  write(KEYS.setlists, list);
  return s;
}

export function removeSetlist(id) {
  write(KEYS.setlists, loadSetlists().filter((s) => s.id !== id));
}

// ---------- 내 방 ----------
export function loadRooms() {
  const list = read(KEYS.rooms);
  return Array.isArray(list) ? list.filter((r) => r && typeof r.code === 'string').sort((a, b) => (b.lastVisited || 0) - (a.lastVisited || 0)) : [];
}

export function upsertRoom(entry) {
  const list = loadRooms();
  const i = list.findIndex((r) => r.code === entry.code);
  const merged = { ...(i >= 0 ? list[i] : {}), ...entry, lastVisited: Date.now() };
  if (i >= 0) list[i] = merged;
  else list.unshift(merged);
  write(KEYS.rooms, list.slice(0, 30));
}

export function removeRoom(code) {
  write(KEYS.rooms, loadRooms().filter((r) => r.code !== code));
}

// ---------- 백업 ----------
export function exportAll() {
  return { app: 'brief', kind: 'library', version: 1, songs: loadLibrary(), setlists: loadSetlists() };
}

export function importAll(data) {
  const songs = normalizeSetlist(data.songs);
  const sets = Array.isArray(data.setlists) ? data.setlists : [];
  for (const s of songs) putSong(s);
  for (const sl of sets) putSetlist({ ...sl, id: sl.id || makeId() });
  return { songs: songs.length, setlists: sets.length };
}
