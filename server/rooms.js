import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyLiveOp, buildPlan, clamp, defaultSequence, demoSong, LIMITS, normalizeSetlist, SUBDIVISIONS,
} from '../public/js/timeline.js';

// 방장이 시작을 누른 뒤 실제 재생까지의 여유. 모든 기기가 메시지를 받고
// 오디오를 예약할 시간을 확보해서 동시에 시작하도록 한다.
export const START_LEAD_MS = 1500;
// 아무도 없는 방은 이 기간이 지나면 지운다 (방장은 같은 코드로 다시 열 수 있다)
const EMPTY_ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const ROSTER_MAX = 100;
const uidOf = (hash) => hash.slice(0, 16);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const TOKEN = /^[a-f0-9]{32}$/;
export const cleanTitle = (v) => (typeof v === 'string' ? v.trim().slice(0, 40) : '');

export const token = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

const toInt = (v, max, fallback) => {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(0, n), Math.max(0, max));
};

const CLIENT_KEY = /^[a-f0-9]{32}$/;
export const cleanKey = (k) => (typeof k === 'string' && CLIENT_KEY.test(k) ? k : null);
const HASH = /^[a-f0-9]{64}$/;
/** 비밀값(방장 토큰·기기 키)의 지문. 멤버 기기에 저장해도 원래 값은 알 수 없다. */
export const hashSecret = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

export class Room {
  constructor(code, setlist, onChange = () => {}, {
    hostToken, hostTokenHash, coHostHashes, title, roster, hostKeyHash,
  } = {}) {
    this.code = code;
    this.title = cleanTitle(title) || `방 ${code}`;
    if (typeof hostToken === 'string' && TOKEN.test(hostToken)) this.hostToken = hostToken;
    else if (typeof hostTokenHash === 'string' && HASH.test(hostTokenHash)) this.hostToken = null; // 멤버가 되살린 방: 방장이 오면 지문으로 확인
    else this.hostToken = token();
    this.hostTokenHash = this.hostToken ? hashSecret(this.hostToken) : hostTokenHash;
    this.hostId = null;
    // 부방장: 기기 키의 지문으로 기억 (재접속·방 되살리기에도 유지)
    this.coHostKeys = new Set((Array.isArray(coHostHashes) ? coHostHashes : []).filter((h) => HASH.test(h)));
    this.setlist = normalizeSetlist(setlist);
    if (!this.setlist.length) this.setlist = [demoSong()];
    this.autoAdvance = true;
    this.gapSeconds = 4;
    this.selectedSong = 0;
    this.selectedSection = 0;
    this.playback = null;
    this.members = new Map();
    // 한 번이라도 들어온 사람 (기기 키 지문 → 이름·마지막 접속). 접속을 끊어도 참가자 목록에 남는다
    this.roster = new Map();
    for (const r of Array.isArray(roster) ? roster : []) {
      if (r && HASH.test(r.h)) {
        this.roster.set(r.h, { name: String(r.name || '멤버').slice(0, 24), joinedAt: Number(r.joinedAt) || 0, lastSeen: Number(r.lastSeen) || 0 });
      }
    }
    this.hostKeyHash = typeof hostKeyHash === 'string' && HASH.test(hostKeyHash) ? hostKeyHash : null;
    this.emptySince = null;
    this.endTimer = null;
    this.onChange = onChange;
  }

  addMember(client, name, hostToken, key = null) {
    const isHost = typeof hostToken === 'string' && TOKEN.test(hostToken)
      && (hostToken === this.hostToken || (!this.hostToken && hashSecret(hostToken) === this.hostTokenHash));
    if (isHost) {
      this.hostId = client.id;
      this.hostToken = hostToken; // 되살린 방이면 이때 방장 토큰을 다시 알게 된다
    }
    const k = cleanKey(key);
    this.members.set(client.id, { client, name, key: k });
    if (k) {
      const h = hashSecret(k);
      const now = Date.now();
      const prev = this.roster.get(h);
      this.roster.delete(h);
      this.roster.set(h, { name, joinedAt: prev?.joinedAt || now, lastSeen: now });
      if (isHost) this.hostKeyHash = h;
      this.#trimRoster();
    }
    this.emptySince = null;
    return isHost;
  }

  /** 너무 많이 쌓이면 오래 안 온 사람부터 목록에서 뺀다 (지금 접속 중인 사람·방장은 남긴다) */
  #trimRoster() {
    if (this.roster.size <= ROSTER_MAX) return;
    const online = new Set([...this.members.values()].filter((m) => m.key).map((m) => hashSecret(m.key)));
    const old = [...this.roster.entries()]
      .filter(([h]) => !online.has(h) && h !== this.hostKeyHash)
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    while (this.roster.size > ROSTER_MAX && old.length) this.roster.delete(old.shift()[0]);
  }

  /** 참가자 목록의 사람 → 기기 키 지문 (접속 중이면 접속 id로, 아니면 목록 uid로 찾는다) */
  #hashFor(id, uid) {
    const m = id ? this.members.get(id) : null;
    if (m) return m.key ? hashSecret(m.key) : null;
    if (typeof uid !== 'string' || !/^[0-9a-f]{16}$/.test(uid)) return null;
    for (const h of this.roster.keys()) if (uidOf(h) === uid) return h;
    return null;
  }

  removeMember(id) {
    const m = this.members.get(id);
    if (m?.key) {
      const r = this.roster.get(hashSecret(m.key));
      if (r) r.lastSeen = Date.now();
    }
    this.members.delete(id);
    // hostId는 유지: 방장이 재접속하면 hostToken으로 권한을 되찾는다.
    if (!this.members.size) this.emptySince = Date.now();
  }

  isHost(id) {
    return id === this.hostId;
  }

  isCoHost(id) {
    const m = this.members.get(id);
    return !!(m && m.key && this.coHostKeys.has(hashSecret(m.key)));
  }

  /** 방장 또는 부방장: 곡 편집·시작·정지·실시간 송폼 변경 가능 */
  canControl(id) {
    return this.isHost(id) || this.isCoHost(id);
  }

  canControlKey(key) {
    const k = cleanKey(key);
    if (!k) return false;
    const host = this.members.get(this.hostId);
    return this.coHostKeys.has(hashSecret(k)) || (!!host && host.key === k);
  }

  /** 부방장 임명·해제: 접속 중이 아닌 사람도 목록에 있으면 된다 */
  setCoHost(memberId, on, uid = null) {
    if (memberId && memberId === this.hostId) return false;
    const h = this.#hashFor(memberId, uid);
    if (!h || h === this.hostKeyHash) return false;
    if (on) this.coHostKeys.add(h);
    else this.coHostKeys.delete(h);
    return true;
  }

  /** 접속 중이 아닌 사람을 참가자 목록에서 뺀다 (부방장이었으면 그것도 해제) */
  forget(uid) {
    const h = this.#hashFor(null, uid);
    if (!h || h === this.hostKeyHash) return false;
    if ([...this.members.values()].some((m) => m.key && hashSecret(m.key) === h)) return false;
    this.roster.delete(h);
    this.coHostKeys.delete(h);
    return true;
  }

  transferHost(toId) {
    const target = this.members.get(toId);
    if (!target) return null;
    const old = this.members.get(this.hostId);
    if (target.key) this.coHostKeys.delete(hashSecret(target.key));
    if (old && old.key) this.coHostKeys.add(hashSecret(old.key)); // 이전 방장은 부방장으로
    this.hostId = toId;
    this.hostKeyHash = target.key ? hashSecret(target.key) : null;
    this.hostToken = token();
    this.hostTokenHash = hashSecret(this.hostToken);
    return this.hostToken;
  }

  setSetlist(list) {
    this.setlist = normalizeSetlist(list);
    if (!this.setlist.length) this.setlist = [demoSong()];
    this.select(this.selectedSong, this.selectedSection);
  }

  updateSettings({ autoAdvance, gapSeconds }) {
    if (typeof autoAdvance === 'boolean') this.autoAdvance = autoAdvance;
    if (gapSeconds !== undefined) this.gapSeconds = clamp(gapSeconds, LIMITS.gapSeconds, this.gapSeconds);
  }

  select(songIndex, sectionIndex = 0) {
    this.selectedSong = toInt(songIndex, this.setlist.length - 1, 0);
    const song = this.setlist[this.selectedSong];
    this.selectedSection = toInt(sectionIndex, song.sections.length - 1, 0);
  }

  play({ songIndex, sectionIndex } = {}, now = Date.now()) {
    this.select(songIndex ?? this.selectedSong, sectionIndex ?? this.selectedSection);
    const songs = structuredClone(this.setlist);
    const pb = {
      playId: token(6),
      rev: 0,
      startAt: now + START_LEAD_MS,
      songs,
      sequence: defaultSequence({
        songs,
        startSongIndex: this.selectedSong,
        startSectionIndex: this.selectedSection,
        autoAdvance: this.autoAdvance,
      }),
      startSongIndex: this.selectedSong,
      gapSeconds: this.gapSeconds,
    };
    this.playback = pb;
    this.#replanned(now);
    return pb;
  }

  /** 재생 계획이 바뀐 뒤: 길이·끝 곡·종료 타이머 갱신 */
  #replanned(now) {
    const pb = this.playback;
    const plan = buildPlan(pb);
    pb.duration = plan.duration;
    pb.endSongIndex = plan.songs.length ? plan.songs[plan.songs.length - 1].songIndex : pb.startSongIndex;
    clearTimeout(this.endTimer);
    const ms = pb.startAt + pb.duration * 1000 - now + 300;
    const { playId } = pb;
    this.endTimer = setTimeout(() => {
      if (this.finish(playId)) this.onChange(this);
    }, Math.max(0, ms));
    this.endTimer.unref?.();
    return plan;
  }

  /**
   * 실시간 송폼 변경. 아직 시작하지 않은 파트만 바뀌므로 모든 기기의 지난 박은 그대로다.
   * op: insert(sectionIndex) | repeat | skipNext | remove(seq, rev) | endSong
   */
  live(msg, now = Date.now()) {
    const pb = this.playback;
    if (!pb) return 'NOT_PLAYING';
    const err = applyLiveOp(pb, msg, now);
    if (err) return err;
    this.#replanned(now);
    return null;
  }

  /**
   * 클릭 쪼개기(박 사이 클릭) 변경. 셋리스트에 저장하고, 재생 중인 곡이면 바로 반영한다.
   * 박 위치는 그대로라 지나간 소리에는 영향이 없다.
   */
  setSubdivision(songIndex, sub, now = Date.now()) {
    const value = Number(sub);
    if (!SUBDIVISIONS.includes(value)) return false;
    const song = this.setlist[songIndex];
    if (!song) return false;
    song.subdivision = value;
    const pb = this.playback;
    const playing = pb && pb.songs[songIndex];
    if (playing && playing.id === song.id) {
      playing.subdivision = value;
      pb.rev++;
      this.#replanned(now);
    }
    return true;
  }

  stop() {
    clearTimeout(this.endTimer);
    this.playback = null;
  }

  /** 재생이 끝까지 진행됐을 때: 다음 곡을 선택해 둔다. */
  finish(playId) {
    if (!this.playback || this.playback.playId !== playId) return false;
    const end = this.playback.endSongIndex;
    this.playback = null;
    this.select(end + 1 < this.setlist.length ? end + 1 : end, 0);
    return true;
  }

  /** 디스크에 저장할 내용 (접속자·재생 상태는 저장하지 않는다) */
  serialize() {
    return {
      code: this.code,
      title: this.title,
      hostToken: this.hostToken,
      hostTokenHash: this.hostTokenHash,
      coHostKeys: [...this.coHostKeys],
      hostKeyHash: this.hostKeyHash,
      roster: [...this.roster.entries()].map(([h, r]) => ({ h, ...r })),
      setlist: this.setlist,
      autoAdvance: this.autoAdvance,
      gapSeconds: this.gapSeconds,
      selectedSong: this.selectedSong,
      lastActive: this.members.size ? Date.now() : this.emptySince || Date.now(),
    };
  }

  static restore(data, onChange) {
    const room = new Room(data.code, data.setlist, onChange, data);
    // 예전 저장 파일은 기기 키를 그대로 저장했다 → 지문으로 바꿔 둔다
    for (const k of data.coHostKeys || []) {
      if (HASH.test(k)) room.coHostKeys.add(k);
      else if (cleanKey(k)) room.coHostKeys.add(hashSecret(k));
    }
    room.updateSettings(data);
    room.select(data.selectedSong ?? 0, 0);
    room.emptySince = Number(data.lastActive) || Date.now();
    return room;
  }

  /** 홈 화면 "내 방" 카드에 보여줄 요약 */
  summary() {
    const pb = this.playback;
    const song = pb ? pb.songs[pb.startSongIndex] : this.setlist[this.selectedSong];
    return {
      code: this.code,
      title: this.title,
      members: this.members.size,
      playing: !!pb,
      song: song ? song.title : '',
      songs: this.setlist.length,
    };
  }

  /**
   * 멤버 기기에 저장해 둘 방 사본. 서버가 방을 잃어도(무료 서버 재시작 등) 멤버가 코드로 들어오면 되살린다.
   * 방장 토큰·기기 키는 지문만 들어 있어 사본으로 방장 행세를 할 수 없다.
   */
  reviveData() {
    return {
      title: this.title,
      setlist: this.setlist,
      hostTokenHash: this.hostTokenHash,
      coHostHashes: [...this.coHostKeys],
      autoAdvance: this.autoAdvance,
      gapSeconds: this.gapSeconds,
    };
  }

  publicState() {
    return {
      code: this.code,
      title: this.title,
      revive: this.reviveData(),
      hostId: this.hostId,
      setlist: this.setlist,
      autoAdvance: this.autoAdvance,
      gapSeconds: this.gapSeconds,
      selectedSong: this.selectedSong,
      selectedSection: this.selectedSection,
      playback: this.playback,
      members: this.memberList(),
    };
  }

  /**
   * 참가자 목록: 한 번이라도 들어온 사람 모두 + 지금 접속 중인지.
   * 같은 기기로 여러 창을 열었으면 한 사람으로 묶는다(ids).
   */
  memberList() {
    const roleOf = (h, id) => {
      if ((id && id === this.hostId) || (!id && h && h === this.hostKeyHash)) return 'host';
      return h && this.coHostKeys.has(h) ? 'cohost' : 'member';
    };
    const list = [];
    const byHash = new Map();
    for (const [id, m] of this.members) {
      const h = m.key ? hashSecret(m.key) : null;
      const same = h && byHash.get(h);
      if (same) {
        same.ids.push(id);
        if (id === this.hostId) { same.role = 'host'; same.id = id; }
        continue;
      }
      const entry = {
        id, ids: [id], uid: h ? uidOf(h) : null, name: m.name, online: true, lastSeen: null, role: roleOf(h, id),
      };
      if (h) byHash.set(h, entry);
      list.push(entry);
    }
    const offline = [...this.roster.entries()]
      .filter(([h]) => !byHash.has(h))
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
      .map(([h, r]) => ({
        id: null, ids: [], uid: uidOf(h), name: r.name, online: false, lastSeen: r.lastSeen, role: roleOf(h, null),
      }));
    const rank = { host: 0, cohost: 1, member: 2 };
    list.sort((a, b) => rank[a.role] - rank[b.role]);
    return [...list, ...offline];
  }

  dispose() {
    clearTimeout(this.endTimer);
  }
}

export class RoomManager {
  constructor(onChange, onRemove = () => {}, { file = null, onSaved = null } = {}) {
    this.rooms = new Map();
    this.onChange = onChange;
    this.onRemove = onRemove;
    this.file = file;
    this.onSaved = onSaved; // 저장할 때마다 (바깥 저장소에도 올리기)
    this.saveTimer = null;
    this.load();
  }

  /** 서버를 다시 켜도 방(셋리스트·방장·부방장)이 남도록 디스크에 저장 */
  load() {
    if (!this.file) return;
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const data of list) {
        if (!ROOM_CODE.test(data.code)) continue;
        this.rooms.set(data.code, Room.restore(data, this.onChange));
      }
    } catch { /* 파일 없음 */ }
  }

  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const json = JSON.stringify([...this.rooms.values()].map((r) => r.serialize()));
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.file);
      this.onSaved?.(json);
    } catch (e) {
      console.error('방 저장 실패', e.message);
    }
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  /** code·hostToken을 주면 그 코드로 방을 다시 연다 (방장이 닫힌 방을 다시 열 때) */
  create(setlist, {
    code, hostToken, hostTokenHash, coHostHashes, title,
  } = {}) {
    const wanted = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const useCode = ROOM_CODE.test(wanted) && !this.rooms.has(wanted) ? wanted : this.newCode();
    const same = useCode === wanted;
    const room = new Room(useCode, setlist, this.onChange, {
      hostToken: same ? hostToken : null,
      hostTokenHash: same ? hostTokenHash : null,
      coHostHashes: same ? coHostHashes : null,
      title,
    });
    this.rooms.set(room.code, room);
    this.save();
    return room;
  }

  get(code) {
    return typeof code === 'string' ? this.rooms.get(code.trim().toUpperCase()) : undefined;
  }

  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
        room.dispose();
        this.rooms.delete(code);
        this.onRemove(code);
        this.save();
      }
    }
  }
}
