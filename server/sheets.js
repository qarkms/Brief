import fs from 'node:fs';
import path from 'node:path';
import { SHEET_ID } from '../public/js/timeline.js';

export const SHEET_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_SHEET_BYTES = 10 * 1024 * 1024;
const MAX_ROOM_BYTES = 400 * 1024 * 1024;

// 악보 이미지 저장소. 방이 사라지면 그 방의 악보도 지운다.
// 목록(index.json)을 함께 저장해서 서버를 다시 켜도 남는다.
export class SheetStore {
  constructor(dir) {
    this.dir = dir;
    this.index = new Map(); // id -> { room, type, size }
    fs.mkdirSync(dir, { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8'));
      for (const [id, meta] of Object.entries(saved)) {
        if (SHEET_ID.test(id) && fs.existsSync(this.file(id))) this.index.set(id, meta);
      }
    } catch { /* 처음 */ }
    // 목록에 없는 파일 정리
    for (const name of fs.readdirSync(dir)) {
      if (SHEET_ID.test(name) && !this.index.has(name)) fs.rmSync(this.file(name), { force: true });
    }
  }

  indexFile() {
    return path.join(this.dir, 'index.json');
  }

  saveIndex() {
    try {
      fs.writeFileSync(this.indexFile(), JSON.stringify(Object.fromEntries(this.index)));
    } catch { /* 무시 */ }
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
    this.saveIndex();
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
    this.saveIndex();
  }
}
