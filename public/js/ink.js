// 악보 필기: 각 기기에만 저장되어 나만 보인다. 악보 장마다 따로 저장.
// 좌표는 악보 그림 기준 0~1 비율로 저장해서 화면 크기·방향이 바뀌어도 같은 자리에 그려진다.

const KEY = (id) => `brief.ink.${id}`;
const WIDTH = { pen: 0.0028, marker: 0.016 }; // 그림 폭 대비 굵기
const ERASE_R = 14; // 지우개 반경(px)

export const ink = {
  on: false,
  tool: 'pen', // pen | marker | eraser
  color: '#e5484d',
  penSeen: false, // 애플펜슬을 한 번이라도 쓰면 손가락 터치는 그리지 않는다 (손바닥 오입력 방지)
};
const undo = []; // { id, strokes(이전 상태) }
const layers = new Set();

function load(id) {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(id)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(id, strokes) {
  try {
    if (strokes.length) localStorage.setItem(KEY(id), JSON.stringify(strokes));
    else localStorage.removeItem(KEY(id));
  } catch { /* 저장 공간 부족 */ }
}

/** object-fit: contain 으로 그려진 그림이 실제로 차지하는 영역 (page 기준 px) */
function contentRect(img, align) {
  const bw = img.clientWidth;
  const bh = img.clientHeight;
  const nw = img.naturalWidth || bw;
  const nh = img.naturalHeight || bh;
  const s = Math.min(bw / nw, bh / nh);
  const w = nw * s;
  const h = nh * s;
  const x = align === 'right' ? bw - w : align === 'left' ? 0 : (bw - w) / 2;
  return {
    x, y: (bh - h) / 2, w, h,
  };
}

/** 악보 한 장 위에 필기 층을 붙인다. align: 두 장 펼침일 때 그림이 붙는 쪽 */
export function attachInk(page, img, sheetId, align = 'center') {
  const canvas = document.createElement('canvas');
  canvas.className = 'ink-canvas';
  page.append(canvas);
  const layer = {
    id: sheetId, strokes: load(sheetId), canvas, img, page, align, draw: null,
  };
  const g = canvas.getContext('2d');

  const draw = () => {
    if (!page.isConnected) {
      layers.delete(layer);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const cw = page.clientWidth;
    const ch = page.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const r = contentRect(img, align);
    for (const st of layer.strokes) {
      const p = st.p;
      if (p.length < 2) continue;
      g.globalAlpha = st.t === 'marker' ? 0.32 : 1;
      g.strokeStyle = st.c;
      g.lineWidth = Math.max(1, st.w * r.w);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(r.x + p[0] * r.w, r.y + p[1] * r.h);
      if (p.length === 2) g.lineTo(r.x + p[0] * r.w + 0.1, r.y + p[1] * r.h);
      for (let i = 2; i < p.length; i += 2) g.lineTo(r.x + p[i] * r.w, r.y + p[i + 1] * r.h);
      g.stroke();
    }
    g.globalAlpha = 1;
  };
  layer.draw = draw;
  layers.add(layer);
  if (img.complete) draw();
  img.addEventListener('load', draw);

  // ---------- 그리기 ----------
  let current = null;
  let before = null;
  const toNorm = (e) => {
    const box = page.getBoundingClientRect();
    const r = contentRect(img, align);
    return [(e.clientX - box.left - r.x) / r.w, (e.clientY - box.top - r.y) / r.h];
  };
  const eraseAt = (e) => {
    const box = page.getBoundingClientRect();
    const r = contentRect(img, align);
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    const keep = layer.strokes.filter((st) => {
      for (let i = 0; i < st.p.length; i += 2) {
        const dx = r.x + st.p[i] * r.w - px;
        const dy = r.y + st.p[i + 1] * r.h - py;
        if (dx * dx + dy * dy < ERASE_R * ERASE_R) return false;
      }
      return true;
    });
    if (keep.length !== layer.strokes.length) {
      layer.strokes = keep;
      draw();
    }
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!ink.on) return;
    if (e.pointerType === 'pen') ink.penSeen = true;
    else if (e.pointerType === 'touch' && ink.penSeen) return; // 펜을 쓰는 중엔 손가락은 무시
    e.preventDefault();
    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);
    before = layer.strokes.slice();
    if (ink.tool === 'eraser') {
      current = { eraser: true };
      eraseAt(e);
      return;
    }
    current = {
      t: ink.tool, c: ink.tool === 'marker' ? '#ffd23f' : ink.color, w: WIDTH[ink.tool], p: toNorm(e).map((v) => Math.round(v * 10000) / 10000),
    };
    layer.strokes.push(current);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      if (current.eraser) eraseAt(ev);
      else current.p.push(...toNorm(ev).map((v) => Math.round(v * 10000) / 10000));
    }
    if (!current.eraser) draw();
  });
  const end = () => {
    if (!current) return;
    current = null;
    const changed = before && (before.length !== layer.strokes.length || before.some((s, i) => s !== layer.strokes[i]));
    if (changed) {
      undo.push({ id: layer.id, strokes: before });
      if (undo.length > 100) undo.shift();
      save(layer.id, layer.strokes);
      syncSame(layer);
    }
    before = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  return layer;
}

/** 같은 악보가 두 칸에 떠 있을 수는 없지만, 저장 후 다른 층이 있으면 다시 읽는다 */
function syncSame(src) {
  for (const l of layers) {
    if (l !== src && l.id === src.id) {
      l.strokes = load(l.id);
      l.draw();
    }
  }
}

export function redrawInk() {
  for (const l of layers) l.draw();
}

export function undoInk() {
  const last = undo.pop();
  if (!last) return false;
  save(last.id, last.strokes);
  for (const l of layers) {
    if (l.id === last.id) {
      l.strokes = last.strokes.slice();
      l.draw();
    }
  }
  return true;
}

/** 지금 보이는 악보들의 필기 지우기 */
export function clearVisibleInk() {
  for (const l of layers) {
    if (!l.page.isConnected || !l.strokes.length) continue;
    undo.push({ id: l.id, strokes: l.strokes.slice() });
    l.strokes = [];
    save(l.id, []);
    l.draw();
  }
}

export function hasInk(id) {
  return load(id).length > 0;
}
