// 악보 업로드: 이미지는 적당한 크기로 줄이고, PDF는 페이지마다 이미지로 바꿔 올린다.
// 올린 파일은 이 기기(IndexedDB)에도 보관해서, 서버가 재시작돼 악보가 사라져도
// 방장이 다시 방을 만들면 자동으로 다시 올린다.

const MAX_EDGE = 2400;
const JPEG_QUALITY = 0.86;

export const sheetUrl = (id) => `/sheets/${id}`;

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- IndexedDB ----------
let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('brief', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sheets');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('sheets', mode);
    const req = fn(tx.objectStore('sheets'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const cachePut = (id, blob) => idb('readwrite', (s) => s.put(blob, id)).catch(() => {});
const cacheGet = (id) => idb('readonly', (s) => s.get(id)).catch(() => undefined);

// ---------- 변환 ----------
function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', JPEG_QUALITY);
  });
}

function drawScaled(source, w, h) {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 투명 PNG도 종이처럼 보이게
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function imagePages(file) {
  const bmp = await createImageBitmap(file);
  const canvas = drawScaled(bmp, bmp.width, bmp.height);
  bmp.close?.();
  return [{ blob: await canvasToBlob(canvas), w: canvas.width, h: canvas.height }];
}

let pdfjsPromise;
function loadPdfJs() {
  pdfjsPromise ??= import('/vendor/pdf.min.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
    return pdfjs;
  }, () => {
    pdfjsPromise = null;
    throw new Error('PDF 변환기를 불러오지 못했어요');
  });
  return pdfjsPromise;
}

async function pdfPages(file, onProgress) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress?.(`PDF ${n}/${pdf.numPages}쪽 변환 중`);
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: MAX_EDGE / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push({ blob: await canvasToBlob(canvas), w: canvas.width, h: canvas.height });
    page.cleanup();
  }
  pdf.destroy();
  return pages;
}

// ---------- 업로드 ----------
async function put(id, blob, { room, hostToken, key }) {
  const res = await fetch(`/api/sheets/${id}?room=${encodeURIComponent(room)}`, {
    method: 'PUT',
    headers: {
      'content-type': blob.type || 'image/jpeg',
      'x-host-token': hostToken || '',
      'x-client-key': key || '',
    },
    body: blob,
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    const msg = {
      NOT_HOST: '방장·부방장만 악보를 올릴 수 있어요',
      TOO_LARGE: '파일이 너무 커요',
      ROOM_FULL: '이 방의 악보 저장 공간이 가득 찼어요',
    }[error];
    throw new Error(msg || '악보 업로드에 실패했어요');
  }
}

/** 파일 하나(이미지 또는 PDF)를 올리고 페이지 목록 [{id,w,h}]을 돌려준다. */
export async function uploadSheetFile(file, { onProgress, ...auth }) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const pages = isPdf ? await pdfPages(file, onProgress) : await imagePages(file);
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(`업로드 중 ${i + 1}/${pages.length}`);
    const id = newId();
    await put(id, pages[i].blob, auth);
    await cachePut(id, pages[i].blob);
    out.push({ id, w: pages[i].w, h: pages[i].h });
  }
  return out;
}

/** 방장 기기: 셋리스트의 악보가 서버에 없으면 기기에 보관된 파일로 다시 올린다. */
const verified = new Set();
export async function ensureSheets(setlist, auth) {
  const { room } = auth;
  const key = (id) => `${room}:${id}`;
  const ids = setlist.flatMap((s) => s.sheets.map((p) => p.id)).filter((id) => !verified.has(key(id)));
  let restored = 0;
  for (const id of ids) {
    verified.add(key(id));
    try {
      const head = await fetch(sheetUrl(id), { method: 'HEAD' });
      if (head.ok) continue;
      const blob = await cacheGet(id);
      if (blob) {
        await put(id, blob, auth);
        restored++;
      }
    } catch {
      verified.delete(key(id));
    }
  }
  return restored;
}

/** 다음에 볼 악보를 미리 받아 둔다. */
export function preload(sheets) {
  for (const p of sheets) {
    const img = new Image();
    img.decoding = 'async';
    img.src = sheetUrl(p.id);
  }
}
