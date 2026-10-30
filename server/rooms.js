import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPlan, clamp, defaultSequence, demoSong, LIMITS, livePosition, normalizeSetlist, SUBDIVISIONS,
} from '../public/js/timeline.js';

// 방장이 시작을 누른 뒤 실제 재생까지의 여유. 모든 기기가 메시지를 받고
// 오디오를 예약할 시간을 확보해서 동시에 시작하도록 한다.
export const START_LEAD_MS = 1500;
// 아무도 없는 방은 이 기간이 지나면 지운다 (방장은 같은 코드로 다시 열 수 있다)
const EMPTY_ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
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

export class Room {
  constructor(code, setlist, onChange = () => {}, { hostToken, title } = {}) {
    this.code = code;
    this.title = cleanTitle(title) || `방 ${code}`;
    this.hostToken = typeof hostToken === 'string' && TOKEN.test(hostToken) ? hostToken : token();
    this.hostId = null;
    this.coHostKeys = new Set(); // 부방장 (기기 키 기준이라 재접속해도 유지)
    this.setlist = normalizeSetlist(setlist);
    if (!this.setlist.length) this.setlist = [demoSong()];
    this.autoAdvance = true;
    this.gapSeconds = 4;
    this.selectedSong = 0;
    this.selectedSection = 0;
    this.playback = null;
    this.members = new Map();
    this.emptySince = null;
    this.endTimer = null;
    this.onChange = onChange;
  }

  addMember(client, name, hostToken, key = null) {
    const isHost = typeof hostToken === 'string' && hostToken === this.hostToken;
    if (isHost) this.hostId = client.id;
    this.members.set(client.id, { client, name, key: cleanKey(key) });
    this.emptySince = null;
    return isHost;
  }

  removeMember(id) {
    this.members.delete(id);
    // hostId는 유지: 방장이 재접속하면 hostToken으로 권한을 되찾는다.
    if (!this.members.size) this.emptySince = Date.now();
  }

  isHost(id) {
    return id === this.hostId;
  }

  isCoHost(id) {
    const m = this.members.get(id);
    return !!(m && m.key && this.coHostKeys.has(m.key));
  }

  /** 방장 또는 부방장: 곡 편집·시작·정지·실시간 송폼 변경 가능 */
  canControl(id) {
    return this.isHost(id) || this.isCoHost(id);
  }

  canControlKey(key) {
    const k = cleanKey(key);
    if (!k) return false;
    const host = this.members.get(this.hostId);
    return this.coHostKeys.has(k) || (!!host && host.key === k);
  }

  setCoHost(memberId, on) {
    const m = this.members.get(memberId);
    if (!m || !m.key || memberId === this.hostId) return false;
    if (on) this.coHostKeys.add(m.key);
    else this.coHostKeys.delete(m.key);
    return true;
  }

  transferHost(toId) {
    const target = this.members.get(toId);
    if (!target) return null;
    const old = this.members.get(this.hostId);
    if (target.key) this.coHostKeys.delete(target.key);
    if (old && old.key) this.coHostKeys.add(old.key); // 이전 방장은 부방장으로
    this.hostId = toId;
    this.hostToken = token();
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
    const plan = buildPlan(pb);
    const time = (now - pb.startAt) / 1000;
    const pos = livePosition(plan, time);
    const seq = pb.sequence;
    // 지금 곡: 연주 중인 파트의 곡, 카운트인/간격이면 다음 파트의 곡
    const ctxItem = pos.curItem || pos.nextItem;
    if (!ctxItem) return 'TOO_LATE';
    const songIndex = ctxItem.songIndex;
    const song = pb.songs[songIndex];
    // 다음 파트 자리: 현재 파트 바로 뒤. 이미 너무 늦었으면 그다음 자리.
    const nextPos = Math.max(pos.cur + 1, pos.firstEditable === Infinity ? seq.length : pos.firstEditable);
    const sameSong = (i) => i < seq.length && seq[i][0] === songIndex;

    switch (msg.op) {
      case 'insert': {
        const k = Number(msg.sectionIndex);
        if (!Number.isInteger(k) || !song.sections[k]) return 'BAD_SECTION';
        seq.splice(nextPos, 0, [songIndex, k]);
        break;
      }
      case 'repeat': {
        if (pos.cur < 0) return 'NOT_IN_SECTION';
        seq.splice(nextPos, 0, [...seq[pos.cur]]);
        break;
      }
      case 'skipNext': {
        if (!sameSong(nextPos)) return 'NOTHING_NEXT';
        seq.splice(nextPos, 1);
        break;
      }
      case 'remove': {
        const i = Number(msg.seq);
        if (msg.rev !== pb.rev) return 'STALE';
        if (!Number.isInteger(i) || i < pos.firstEditable || i >= seq.length) return 'TOO_LATE';
        seq.splice(i, 1);
        break;
      }
      case 'addBar': {
        // 지금 파트를 한 마디 늘린다. 파트 끝이 코앞이면 곧 시작할 다음 파트를 늘린다.
        // (늘려도 그 파트가 끝나기 전까지는 아무것도 바뀌지 않으므로 "끝"이 아직 남았는지만 본다)
        const target = plan.items.find((it) => it.end > time + 0.25);
        const i = target ? target.seq : -1;
        if (i < 0 || !sameSong(i)) return 'NOT_IN_SECTION';
        const [s0, k0, extra = 0] = seq[i];
        if (extra >= 64) return 'TOO_MANY';
        seq[i] = [s0, k0, extra + 1];
        break;
      }
      case 'endSong': {
        let n = 0;
        while (sameSong(nextPos)) {
          seq.splice(nextPos, 1);
          n++;
        }
        if (!n) return 'NOTHING_NEXT';
        break;
      }
      default:
        return 'BAD_OP';
    }
    if (seq.length > LIMITS.sequence) seq.length = LIMITS.sequence;
    pb.rev++;
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
      coHostKeys: [...this.coHostKeys],
      setlist: this.setlist,
      autoAdvance: this.autoAdvance,
      gapSeconds: this.gapSeconds,
      selectedSong: this.selectedSong,
      lastActive: this.members.size ? Date.now() : this.emptySince || Date.now(),
    };
  }

  static restore(data, onChange) {
    const room = new Room(data.code, data.setlist, onChange, data);
    for (const k of data.coHostKeys || []) if (cleanKey(k)) room.coHostKeys.add(k);
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

  publicState() {
    return {
      code: this.code,
      title: this.title,
      hostId: this.hostId,
      setlist: this.setlist,
      autoAdvance: this.autoAdvance,
      gapSeconds: this.gapSeconds,
      selectedSong: this.selectedSong,
      selectedSection: this.selectedSection,
      playback: this.playback,
      members: [...this.members.entries()].map(([id, m]) => ({
        id,
        name: m.name,
        role: id === this.hostId ? 'host' : this.isCoHost(id) ? 'cohost' : 'member',
      })),
    };
  }

  dispose() {
    clearTimeout(this.endTimer);
  }
}

export class RoomManager {
  constructor(onChange, onRemove = () => {}, { file = null } = {}) {
    this.rooms = new Map();
    this.onChange = onChange;
    this.onRemove = onRemove;
    this.file = file;
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
      fs.writeFileSync(tmp, JSON.stringify([...this.rooms.values()].map((r) => r.serialize())));
      fs.renameSync(tmp, this.file);
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
  create(setlist, { code, hostToken, title } = {}) {
    const wanted = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const useCode = ROOM_CODE.test(wanted) && !this.rooms.has(wanted) ? wanted : this.newCode();
    const room = new Room(useCode, setlist, this.onChange, {
      hostToken: useCode === wanted ? hostToken : null, title,
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
