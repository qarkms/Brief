// 곡 편집 다이얼로그 + 이 기기에 저장되는 곡 보관함
import {
  makeId, normalizeSong, SECTION_PRESETS, songDuration,
} from './timeline.js';
import {
  buildFormStrip, el, icon, sectionTone,
} from './ui.js';
import { sheetUrl } from './sheets.js';

const $ = (id) => document.getElementById(id);
const LIBRARY_KEY = 'brief.library';

export function formatDuration(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function loadLibrary() {
  try {
    const list = JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]');
    return Array.isArray(list) ? list.map(normalizeSong) : [];
  } catch {
    return [];
  }
}

function saveLibrary(list) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
  } catch { /* 저장 공간 없음 */ }
}

/** 같은 제목의 곡이 있으면 덮어쓴다. */
export function saveToLibrary(song) {
  const list = loadLibrary().filter((s) => s.title !== song.title);
  list.push({ ...song, id: makeId() });
  list.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  saveLibrary(list);
}

export function removeFromLibrary(id) {
  saveLibrary(loadLibrary().filter((s) => s.id !== id));
}

let current = null; // { song, sheets, onSave, onDelete, upload, toast }

function readNum(input) {
  return input.value === '' ? null : Number(input.value);
}

function rows() {
  return [...$('ed-sections').querySelectorAll('.sec-row:not(.sec-head)')];
}

function collectRow(row) {
  return {
    name: row.querySelector('.name').value,
    bars: readNum(row.querySelector('.bars')),
    bpm: readNum(row.querySelector('.bpm')),
    beatsPerBar: readNum(row.querySelector('.beats')),
    cue: row.querySelector('.cue').value,
  };
}

function collect() {
  return normalizeSong({
    id: current.song.id,
    title: $('ed-title').value,
    bpm: readNum($('ed-bpm')),
    beatsPerBar: readNum($('ed-beats')),
    countInBars: readNum($('ed-countin')),
    sections: rows().map(collectRow),
    sheets: current.sheets,
  });
}

function refresh() {
  const song = collect();
  const bars = song.sections.reduce((n, s) => n + s.bars, 0);
  $('ed-total').textContent = `${bars}마디 · ${formatDuration(songDuration(song))}`;
  buildFormStrip($('ed-form'), song);
  rows().forEach((r, i) => {
    r.querySelector('.idx').textContent = i + 1;
    r.dataset.tone = sectionTone(r.querySelector('.name').value);
  });
}

function sectionRow(sec) {
  const row = el('div', { className: 'sec-row' });
  const move = (dir) => {
    const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sib || sib.classList.contains('sec-head')) return;
    if (dir < 0) sib.before(row);
    else sib.after(row);
    refresh();
  };
  const btn = (name, title, fn) => el('button', { type: 'button', title, onclick: fn }, icon(name));
  const num = (cls, value, attrs, unit) => el(
    'span',
    { className: `unit-wrap w-${cls}` },
    el('input', {
      className: cls, value: value ?? '', type: 'number', ...attrs,
    }),
    el('span', { className: 'unit', textContent: unit }),
  );
  const name = el('input', {
    className: 'name', value: sec.name, maxLength: 40, placeholder: '파트 이름', required: true,
  });
  name.setAttribute('list', 'section-presets');
  row.append(
    el('span', { className: 'idx' }),
    name,
    num('bars', sec.bars, {
      min: 1, max: 512, inputMode: 'numeric', placeholder: '마디', title: '마디 수', required: true,
    }, '마디'),
    num('bpm', sec.bpm, {
      min: 20, max: 400, step: 0.5, inputMode: 'decimal', placeholder: 'BPM', title: 'BPM (비우면 곡 기본값)',
    }, 'BPM'),
    num('beats', sec.beatsPerBar, {
      min: 1, max: 16, inputMode: 'numeric', placeholder: '박자', title: '마디당 박 수 (비우면 곡 기본값)',
    }, '박'),
    el('input', {
      className: 'cue', value: sec.cue, maxLength: 80, placeholder: '음성 문구 (선택)', title: '비우면 파트 이름을 읽어요',
    }),
    el(
      'div',
      { className: 'row-acts' },
      btn('up', '위로', () => move(-1)),
      btn('down', '아래로', () => move(1)),
      btn('copy', '복제', () => {
        row.after(sectionRow(collectRow(row)));
        refresh();
      }),
      btn('close', '삭제', () => {
        if (rows().length <= 1) return;
        row.remove();
        refresh();
      }),
    ),
  );
  return row;
}

function headRow() {
  const row = el('div', { className: 'sec-row sec-head' });
  for (const t of ['#', '파트', '마디', 'BPM', '박자', '음성 문구', '']) row.append(el('span', { textContent: t }));
  return row;
}

// ---------- 악보 ----------
function renderSheets() {
  const box = $('ed-sheets');
  const pages = current.sheets;
  box.replaceChildren(...pages.map((p, i) => {
    const swap = (j) => {
      if (j < 0 || j >= pages.length) return;
      [pages[i], pages[j]] = [pages[j], pages[i]];
      renderSheets();
    };
    const b = (name, title, fn) => el('button', { type: 'button', title, onclick: fn }, icon(name));
    return el(
      'div',
      { className: 'thumb' },
      el('img', { src: sheetUrl(p.id), alt: `${i + 1}쪽`, loading: 'lazy' }),
      el('span', { className: 'pg', textContent: i + 1 }),
      el(
        'div',
        { className: 't-acts' },
        b('left', '앞으로', () => swap(i - 1)),
        b('right', '뒤로', () => swap(i + 1)),
        b('trash', '삭제', () => {
          pages.splice(i, 1);
          renderSheets();
        }),
      ),
    );
  }));
}

async function onSheetFiles(files) {
  const status = $('ed-sheet-status');
  const save = $('ed-save');
  save.disabled = true;
  try {
    for (const file of files) {
      const pages = await current.upload(file, (msg) => { status.textContent = `${file.name}: ${msg}`; });
      current.sheets.push(...pages);
      renderSheets();
    }
    status.textContent = '';
  } catch (e) {
    status.textContent = e.message || '업로드 실패';
  } finally {
    save.disabled = false;
  }
}

let initialized = false;
function init() {
  if (initialized) return;
  initialized = true;
  const dl = el('datalist', { id: 'section-presets' });
  for (const p of SECTION_PRESETS) dl.append(el('option', { value: p }));
  document.body.append(dl);

  for (const p of SECTION_PRESETS) {
    const b = el('button', {
      type: 'button',
      className: 'preset',
      textContent: p,
      onclick: () => {
        const short = ['Intro', 'Outro', 'Tag', 'Break', 'Ending'].includes(p);
        $('ed-sections').append(sectionRow({ name: p, bars: short ? (p === 'Tag' || p === 'Break' ? 2 : 4) : 8, cue: '' }));
        refresh();
      },
    });
    b.dataset.tone = sectionTone(p);
    $('ed-presets').append(b);
  }
  $('ed-sections').addEventListener('input', refresh);
  for (const id of ['ed-bpm', 'ed-beats', 'ed-countin']) $(id).addEventListener('input', refresh);

  $('ed-sheet-file').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) onSheetFiles(files);
  });

  const dlg = $('dlg-editor');
  $('ed-save').onclick = () => {
    if (!$('editor-form').reportValidity()) return;
    current.onSave(collect());
    dlg.close();
  };
  $('ed-delete').onclick = () => {
    if (!current.onDelete || !confirm(`"${current.song.title}"을(를) 셋리스트에서 삭제할까요?`)) return;
    current.onDelete();
    dlg.close();
  };
  $('ed-save-library').onclick = () => {
    const song = collect();
    saveToLibrary(song);
    current.toast?.(`보관함에 "${song.title}" 저장됨`);
  };
}

export function openEditor(song, {
  onSave, onDelete, isNew, toast, upload,
}) {
  init();
  current = {
    song, sheets: [...(song.sheets || [])], onSave, onDelete, toast, upload,
  };
  $('editor-title').textContent = isNew ? '새 곡' : '곡 편집';
  $('ed-title').value = song.title;
  $('ed-bpm').value = song.bpm;
  $('ed-beats').value = song.beatsPerBar;
  $('ed-countin').value = song.countInBars;
  $('ed-delete').classList.toggle('hidden', !onDelete);
  $('ed-sheet-status').textContent = '';
  $('ed-sections').replaceChildren(headRow(), ...song.sections.map(sectionRow));
  renderSheets();
  refresh();
  $('dlg-editor').showModal();
}
