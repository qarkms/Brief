// 곡 편집 다이얼로그 + 이 기기에 저장되는 곡 보관함
import {
  makeId, normalizeSong, SECTION_PRESETS, songDuration,
} from './timeline.js';

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

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

let current = null; // { song, onSave, onDelete }

function readNum(input) {
  return input.value === '' ? null : Number(input.value);
}

function collect() {
  const rows = [...$('ed-sections').querySelectorAll('.sec-row:not(.sec-head)')];
  return normalizeSong({
    id: current.song.id,
    title: $('ed-title').value,
    bpm: readNum($('ed-bpm')),
    beatsPerBar: readNum($('ed-beats')),
    countInBars: readNum($('ed-countin')),
    sections: rows.map((r) => ({
      name: r.querySelector('.name').value,
      bars: readNum(r.querySelector('.bars')),
      bpm: readNum(r.querySelector('.bpm')),
      beatsPerBar: readNum(r.querySelector('.beats')),
      cue: r.querySelector('.cue').value,
    })),
  });
}

function updateTotal() {
  const song = collect();
  const bars = song.sections.reduce((n, s) => n + s.bars, 0);
  $('ed-total').textContent = `${bars}마디 · ${formatDuration(songDuration(song))}`;
}

function nameInput(value) {
  const node = el('input', {
    className: 'name', value, maxLength: 40, placeholder: '파트 이름', required: true,
  });
  node.setAttribute('list', 'section-presets');
  return node;
}

function sectionRow(sec) {
  const input = (cls, attrs) => el('input', { className: cls, ...attrs });
  const row = el('div', { className: 'sec-row' });
  const move = (dir) => {
    const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sib || sib.classList.contains('sec-head')) return;
    if (dir < 0) sib.before(row);
    else sib.after(row);
    renumber();
  };
  const btn = (label, title, fn) => el('button', { type: 'button', textContent: label, title, onclick: fn });
  row.append(
    el('span', { className: 'idx' }),
    nameInput(sec.name),
    input('bars', {
      value: sec.bars, type: 'number', min: 1, max: 512, inputMode: 'numeric', placeholder: '마디', title: '마디 수', required: true,
    }),
    input('bpm', {
      value: sec.bpm ?? '', type: 'number', min: 20, max: 400, step: 0.5, inputMode: 'decimal', placeholder: 'BPM', title: 'BPM (비우면 곡 기본값)',
    }),
    input('beats', {
      value: sec.beatsPerBar ?? '', type: 'number', min: 1, max: 16, inputMode: 'numeric', placeholder: '박자', title: '한 마디 박 수 (비우면 곡 기본값)',
    }),
    input('cue', { value: sec.cue, maxLength: 80, placeholder: '음성 문구 (선택)', title: '비우면 파트 이름을 읽어요' }),
    el(
      'div',
      { className: 'row-acts' },
      btn('↑', '위로', () => move(-1)),
      btn('↓', '아래로', () => move(1)),
      btn('⧉', '복제', () => {
        const copy = sectionRow(collectRow(row));
        row.after(copy);
        renumber();
      }),
      btn('✕', '삭제', () => {
        if ($('ed-sections').querySelectorAll('.sec-row:not(.sec-head)').length <= 1) return;
        row.remove();
        renumber();
      }),
    ),
  );
  return row;
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

function renumber() {
  $('ed-sections').querySelectorAll('.sec-row:not(.sec-head)').forEach((r, i) => {
    r.querySelector('.idx').textContent = i + 1;
  });
  updateTotal();
}

function headRow() {
  const row = el('div', { className: 'sec-row sec-head' });
  for (const t of ['#', '파트', '마디', 'BPM', '박자', '음성 문구', '']) row.append(el('span', { textContent: t }));
  return row;
}

let initialized = false;
function init() {
  if (initialized) return;
  initialized = true;
  const dl = el('datalist', { id: 'section-presets' });
  for (const p of SECTION_PRESETS) dl.append(el('option', { value: p }));
  document.body.append(dl);

  for (const p of SECTION_PRESETS) {
    $('ed-presets').append(el('button', {
      type: 'button',
      className: 'btn small',
      textContent: `+ ${p}`,
      onclick: () => {
        $('ed-sections').append(sectionRow({ name: p, bars: p === 'Intro' || p === 'Outro' ? 4 : 8, cue: '' }));
        renumber();
      },
    }));
  }
  $('ed-sections').addEventListener('input', updateTotal);
  for (const id of ['ed-bpm', 'ed-beats', 'ed-countin']) $(id).addEventListener('input', updateTotal);

  const dlg = $('dlg-editor');
  $('ed-save').onclick = () => {
    if (!$('editor-form').reportValidity()) return;
    const song = collect();
    current.onSave(song);
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

export function openEditor(song, { onSave, onDelete, isNew, toast }) {
  init();
  current = { song, onSave, onDelete, toast };
  $('editor-title').textContent = isNew ? '새 곡' : '곡 편집';
  $('ed-title').value = song.title;
  $('ed-bpm').value = song.bpm;
  $('ed-beats').value = song.beatsPerBar;
  $('ed-countin').value = song.countInBars;
  $('ed-delete').classList.toggle('hidden', !onDelete);
  const box = $('ed-sections');
  box.replaceChildren(headRow(), ...song.sections.map(sectionRow));
  renumber();
  $('dlg-editor').showModal();
}
