import fs from 'node:fs';
import path from 'node:path';
import { SHEET_ID } from '../public/js/timeline.js';

export const SHEET_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_SHEET_BYTES = 10 * 1024 * 1024;
const MAX_ROOM_BYTES = 400 * 1024 * 1024;

// 악보 이미지 저장소. 방이 사라지면 그 방의 악보도 지운다.
// 방 정보가 메모리에만 있으므로 서버 시작 시 이전 파일은 비운다.
export class SheetStore {
  constructor(dir) {
    this.dir = dir;
    this.index = new Map(); // id -> { room, type, size }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    return path.join(this.dir, id);
  }

  roomBytes(room) {
    let n = 0;
    for (const meta of this.index.values()) if (meta.room === room) n += meta.size;
    return n;
  }

  /** 저장 실패 사유를 문자열로 돌려준다. 성공하면 null. */
  put(id, room, type, buf) {
    if (!SHEET_ID.test(id)) return 'BAD_ID';
    if (!SHEET_TYPES.has(type)) return 'BAD_TYPE';
    const existing = this.index.get(id);
    if (existing && existing.room !== room) return 'TAKEN';
    if (this.roomBytes(room) - (existing ? existing.size : 0) + buf.length > MAX_ROOM_BYTES) return 'ROOM_FULL';
    fs.writeFileSync(this.file(id), buf);
    this.index.set(id, { room, type, size: buf.length });
    return null;
  }

  get(id) {
    return SHEET_ID.test(id) ? this.index.get(id) : undefined;
  }

  removeRoom(room) {
    for (const [id, meta] of this.index) {
      if (meta.room !== room) continue;
      this.index.delete(id);
      fs.rm(this.file(id), { force: true }, () => {});
    }
  }
}
