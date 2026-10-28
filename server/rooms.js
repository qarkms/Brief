import crypto from 'node:crypto';
import {
  buildPlan, clamp, demoSong, LIMITS, normalizeSetlist,
} from '../public/js/timeline.js';

// 방장이 시작을 누른 뒤 실제 재생까지의 여유. 모든 기기가 메시지를 받고
// 오디오를 예약할 시간을 확보해서 동시에 시작하도록 한다.
export const START_LEAD_MS = 1500;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const token = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

const toInt = (v, max, fallback) => {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(0, n), Math.max(0, max));
};

export class Room {
  constructor(code, setlist, onChange = () => {}) {
    this.code = code;
    this.hostToken = token();
    this.hostId = null;
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

  addMember(client, name, hostToken) {
    const isHost = typeof hostToken === 'string' && hostToken === this.hostToken;
    if (isHost) this.hostId = client.id;
    this.members.set(client.id, { client, name });
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

  transferHost(toId) {
    if (!this.members.has(toId)) return null;
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
    const pb = {
      playId: token(6),
      startAt: now + START_LEAD_MS,
      songs: structuredClone(this.setlist),
      startSongIndex: this.selectedSong,
      startSectionIndex: this.selectedSection,
      autoAdvance: this.autoAdvance,
      gapSeconds: this.gapSeconds,
    };
    const plan = buildPlan(pb);
    pb.duration = plan.duration;
    pb.endSongIndex = plan.songs.length ? plan.songs[plan.songs.length - 1].songIndex : pb.startSongIndex;
    this.playback = pb;

    clearTimeout(this.endTimer);
    const ms = pb.startAt + pb.duration * 1000 - now + 300;
    this.endTimer = setTimeout(() => {
      if (this.finish(pb.playId)) this.onChange(this);
    }, ms);
    this.endTimer.unref?.();
    return pb;
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

  publicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      setlist: this.setlist,
      autoAdvance: this.autoAdvance,
      gapSeconds: this.gapSeconds,
      selectedSong: this.selectedSong,
      selectedSection: this.selectedSection,
      playback: this.playback,
      members: [...this.members.entries()].map(([id, m]) => ({
        id, name: m.name, isHost: id === this.hostId,
      })),
    };
  }

  dispose() {
    clearTimeout(this.endTimer);
  }
}

export class RoomManager {
  constructor(onChange) {
    this.rooms = new Map();
    this.onChange = onChange;
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  create(setlist) {
    const room = new Room(this.newCode(), setlist, this.onChange);
    this.rooms.set(room.code, room);
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
      }
    }
  }
}
