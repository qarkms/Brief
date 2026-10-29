// 곡 편집 시트 + 이 기기에 저장되는 곡 보관함
import {
  makeId, normalizeSong, SECTION_PRESETS, songDuration,
} from './timeline.js';
import {
  buildFormStrip, el, icon, sectionTone,
} from './ui.js';
import { sheetUrl } from './sheets.js';

const $ = (id) => document.getElementById(id);
const LIBRARY_KEY = 'brief.library';

export const METERS = ['2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '2/2', '3/2', '3/8', '5/8', '6/8', '7/8', '9/8', '12/8'];

/** 박 단위와 쪼개기로 음표 이름 */
export function subLabel(unit, sub) {
  if (sub === 1) return `${unit}분음표`;
  if (sub === 2) return `${unit * 2}분음표`;
  if (sub === 4) return `${unit * 4}분음표`;
  if (sub === 3) return '셋잇단음표';
  return `${unit * 2}분 셋잇단`;
}
const SUB_MARK = {
  1: '♩', 2: '♪', 3: '³', 4: '♬', 6: '⁶',
};
export const subShort = (unit, sub) => `${SUB_MARK[sub]} ${subLabel(unit, sub)}`;

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

// ---------- 공용: 스테퍼 (길게 누르면 계속) ----------
export function bindStepper(root, onStep) {
  root.querySelectorAll('.step-btn').forEach((b) => {
    let timer = null;
    const dir = Number(b.dataset.step);
    const stopRepeat = () => {
      clearTimeout(timer);
      clearInterval(timer);
      timer = null;
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onStep(dir);
      timer = setTimeout(() => { timer = setInterval(() => onStep(dir), 70); }, 380);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stopRepeat);
    b.addEventListener('click', (e) => e.preventDefault());
  });
}

export function setChoice(box, value) {
  box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === value));
}

let current = null; // { song, sheets, onSave, onDelete, upload, toast, countVoice, countIn }

const meterOf = (beats, unit) => `${beats}/${unit}`;
function fillMeterSelect(select, value, withDefault) {
  const list = METERS.includes(value) || !value ? METERS : [...METERS, value];
  select.replaceChildren(
    ...(withDefault ? [el('option', { value: '', textContent: '박자: 곡 기본' })] : []),
    ...list.map((m) => el('option', { value: m, textContent: m })),
  );
  select.value = value || '';
}
function fillSubSelect(select, unit, value, withDefault) {
  select.replaceChildren(
    ...(withDefault ? [el('option', { value: '', textContent: '음표: 곡 기본' })] : []),
    ...[1, 2, 3, 4, 6].map((s) => el('option', { value: String(s), textContent: subShort(unit, s) })),
  );
  select.value = value ? String(value) : '';
}

function songMeterParts() {
  const [b, u] = $('ed-meter').value.split('/').map(Number);
  return { beats: b, unit: u };
}

function rows() {
  return [...$('ed-sections').querySelectorAll('.sec-row')];
}

function collectRow(row) {
  const q = (c) => row.querySelector(c);
  const meter = q('.d-meter').value;
  const [beats, unit] = meter ? meter.split('/').map(Number) : [null, null];
  return {
    name: q('.name').value,
    bars: Number(q('.bars-v').textContent),
    bpm: q('.d-bpm').value === '' ? null : Number(q('.d-bpm').value),
    beatsPerBar: beats,
    beatUnit: unit,
    subdivision: q('.d-sub').value ? Number(q('.d-sub').value) : null,
    cue: q('.d-cue').value,
    announce: q('.d-announce').checked,
  };
}

function collect() {
  const { beats, unit } = songMeterParts();
  return normalizeSong({
    id: current.song.id,
    title: $('ed-title').value,
    bpm: Number($('ed-bpm').value),
    beatsPerBar: beats,
    beatUnit: unit,
    subdivision: Number($('ed-sub').value),
    countInBars: current.countIn,
    countVoice: current.countVoice,
    sections: rows().map(collectRow),
    sheets: current.sheets,
  });
}

function refresh() {
  const song = collect();
  const bars = song.sections.reduce((n, s) => n + s.bars, 0);
  $('ed-total').textContent = `· ${song.sections.length}파트 ${bars}마디 · ${formatDuration(songDuration(song))}`;
  buildFormStrip($('ed-form'), song, { labels: false });
  $('ed-countin-v').textContent = current.countIn;
  rows().forEach((r, i) => {
    r.querySelector('.idx').textContent = i + 1;
    const sec = collectRow(r);
    r.querySelector('.part-pill').dataset.tone = sectionTone(sec.name);
    const badges = [];
    if (sec.beatsPerBar) badges.push(meterOf(sec.beatsPerBar, sec.beatUnit));
    if (sec.bpm) badges.push(`${sec.bpm}`);
    if (sec.subdivision) badges.push(SUB_MARK[sec.subdivision]);
    const box = r.querySelector('.badges');
    box.replaceChildren(...badges.map((b) => el('span', { className: 'bdg', textContent: b })));
    if (!sec.announce) box.append(el('span', { className: 'bdg off', textContent: '말 안 함' }));
  });
}

function insertLine() {
  const line = el('div', { className: 'insert-line' });
  line.append(el('button', {
    type: 'button',
    title: '여기에 파트 넣기',
    onclick: () => openPicker((sec) => {
      line.after(sectionRow(sec));
      refresh();
    }),
  }, icon('plus')));
  return line;
}

function sectionRow(sec) {
  const row = el('div', { className: 'sec-row' });
  const name = el('input', {
    className: 'name', value: sec.name, maxLength: 40, placeholder: '파트 이름', required: true,
  });
  name.setAttribute('list', 'section-presets');
  const barsV = el('b', { className: 'bars-v', textContent: sec.bars });
  const stepper = el(
    'div',
    { className: 'stepper' },
    el('button', { type: 'button', className: 'step-btn', ariaLabel: '마디 줄이기' }, icon('minus')),
    el('span', { className: 'step-val' }, barsV, '마디'),
    el('button', { type: 'button', className: 'step-btn', ariaLabel: '마디 늘리기' }, icon('plus')),
  );
  stepper.children[0].dataset.step = '-1';
  stepper.children[2].dataset.step = '1';
  bindStepper(stepper, (d) => {
    barsV.textContent = Math.min(512, Math.max(1, Number(barsV.textContent) + d));
    refresh();
  });

  const { unit } = songMeterParts();
  const dMeter = el('select', { className: 'd-meter' });
  fillMeterSelect(dMeter, sec.beatsPerBar ? meterOf(sec.beatsPerBar, sec.beatUnit ?? unit) : '', true);
  const dSub = el('select', { className: 'd-sub' });
  fillSubSelect(dSub, sec.beatUnit ?? unit, sec.subdivision, true);
  dMeter.addEventListener('change', () => {
    const u = dMeter.value ? Number(dMeter.value.split('/')[1]) : songMeterParts().unit;
    fillSubSelect(dSub, u, dSub.value, true);
  });
  const announce = el('input', { type: 'checkbox', className: 'd-announce', checked: sec.announce !== false });
  const grip = el('div', { className: 'grip', title: '끌어서 순서 바꾸기' }, icon('grip'), el('span', { className: 'idx' }));

  row.append(
    el(
      'div',
      { className: 'sec-main' },
      grip,
      el(
        'div',
        { className: 'part-pill' },
        name,
        el('span', { className: 'badges' }),
        el('button', {
          type: 'button', className: 'more', title: '세부 설정', onclick: () => row.classList.toggle('open'),
        }, icon('chevron')),
      ),
      stepper,
      el('button', {
        type: 'button',
        className: 'x-btn',
        title: '삭제',
        onclick: () => {
          if (rows().length <= 1) return;
          row.nextElementSibling?.classList.contains('insert-line') && row.nextElementSibling.remove();
          row.remove();
          refresh();
        },
      }, icon('close')),
    ),
    el(
      'div',
      { className: 'sec-detail' },
      el('label', { className: 'field' }, el('span', { className: 'field-label', textContent: 'BPM (비우면 곡 기본)' }), el('input', {
        className: 'input d-bpm', type: 'number', min: 20, max: 400, inputMode: 'numeric', value: sec.bpm ?? '', placeholder: '곡 기본',
      })),
      el('label', { className: 'field' }, el('span', { className: 'field-label', textContent: '박자' }), el('span', { className: 'select-box' }, dMeter, icon('chevron'))),
      el('label', { className: 'field' }, el('span', { className: 'field-label', textContent: '음표' }), el('span', { className: 'select-box' }, dSub, icon('chevron'))),
      el('label', { className: 'field' }, el('span', { className: 'field-label', textContent: '음성 문구 (비우면 파트 이름)' }), el('input', {
        className: 'input d-cue', maxLength: 80, value: sec.cue || '', placeholder: '예: Last Chorus',
      })),
      el('label', { className: 'toggle full' }, el('span', { textContent: '이 파트 시작 전에 브리핑' }), announce, el('span', { className: 'toggle-ui' })),
      el('div', { className: 'row full' }, el('button', {
        type: 'button',
        className: 'btn soft sm',
        onclick: () => {
          const copy = sectionRow(collectRow(row));
          const line = row.nextElementSibling;
          (line && line.classList.contains('insert-line') ? line : row).after(copy);
          refresh();
        },
      }, icon('copy'), '이 파트 복제')),
    ),
  );
  setupDrag(row, grip);
  // 파트 행과 그 아래 "+" 줄을 한 묶음으로 다룬다
  row._line = insertLine();
  queueMicrotask(() => row.after(row._line));
  return row;
}

// ---------- 끌어서 순서 바꾸기 ----------
function setupDrag(row, grip) {
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    row.classList.add('dragging');
    const box = $('ed-sections');
    const move = (ev) => {
      const others = rows().filter((r) => r !== row);
      let target = null;
      for (const r of others) {
        const rect = r.getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          target = r;
          break;
        }
      }
      const line = row._line;
      if (target) {
        if (target.previousElementSibling !== line || row.nextElementSibling !== line) target.before(row, line);
      } else if (box.lastElementChild !== line) {
        box.append(row, line);
      }
    };
    const up = () => {
      row.classList.remove('dragging');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      refresh();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
}

// ---------- 파트 고르기 ----------
export const METER_CHANGE = {
  name: '2/4', bars: 1, beatsPerBar: 2, beatUnit: 4, announce: false, cue: '',
};
const presetBars = (p) => (['Intro', 'Outro', 'Ending'].includes(p) ? 4 : ['Tag', 'Break'].includes(p) ? 2 : 8);

function presetChips(onPick) {
  const chips = SECTION_PRESETS.map((p) => {
    const c = el('button', { type: 'button', className: 'chip' }, el('span', { className: 'n', textContent: `+ ${p}` }));
    c.dataset.tone = sectionTone(p);
    c.onclick = () => onPick({ name: p, bars: presetBars(p), cue: '' });
    return c;
  });
  const meter = el('button', { type: 'button', className: 'chip' }, el('span', { className: 'n', textContent: '+ 박자 변경 마디' }));
  meter.dataset.tone = 'meter';
  meter.onclick = () => onPick({ ...METER_CHANGE });
  return [...chips, meter];
}

function openPicker(onPick) {
  const dlg = $('dlg-pick');
  $('pick-list').replaceChildren(...presetChips((sec) => {
    dlg.close();
    onPick(sec);
  }));
  dlg.showModal();
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

  $('ed-sections').addEventListener('input', refresh);
  $('ed-sections').addEventListener('change', refresh);
  $('ed-meter').addEventListener('change', () => {
    fillSubSelect($('ed-sub'), songMeterParts().unit, $('ed-sub').value || '1', false);
    refresh();
  });
  $('ed-sub').addEventListener('change', refresh);
  $('ed-bpm').addEventListener('input', refresh);
  bindStepper(document.querySelector('[data-stepper="bpm"]'), (d) => {
    const v = Math.min(400, Math.max(20, Math.round(Number($('ed-bpm').value) || 120) + d));
    $('ed-bpm').value = v;
    refresh();
  });
  bindStepper(document.querySelector('[data-stepper="countin"]'), (d) => {
    current.countIn = Math.min(8, Math.max(0, current.countIn + d));
    refresh();
  });
  $('ed-countvoice').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    current.countVoice = b.dataset.v;
    setChoice($('ed-countvoice'), current.countVoice);
  });

  $('ed-presets').replaceChildren(...presetChips((sec) => {
    $('ed-sections').append(sectionRow(sec));
    refresh();
  }));

  $('ed-sheet-file').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) onSheetFiles(files);
  });

  const dlg = $('dlg-editor');
  $('ed-save').onclick = () => {
    // 새 곡 제목을 비워 두면 기본 이름을 쓴다
    if (!$('ed-title').value.trim() && current.defaultTitle) $('ed-title').value = current.defaultTitle;
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
    song,
    sheets: [...(song.sheets || [])],
    onSave,
    onDelete,
    toast,
    upload,
    countIn: song.countInBars,
    countVoice: song.countVoice,
    defaultTitle: isNew ? song.title : null,
  };
  $('editor-title').textContent = isNew ? '새 곡 만들기' : '곡 구조 브리핑';
  $('ed-title').value = isNew ? '' : song.title;
  $('ed-title').placeholder = isNew ? song.title : '곡 제목';
  $('ed-bpm').value = song.bpm;
  fillMeterSelect($('ed-meter'), meterOf(song.beatsPerBar, song.beatUnit), false);
  fillSubSelect($('ed-sub'), song.beatUnit, song.subdivision, false);
  setChoice($('ed-countvoice'), song.countVoice);
  $('ed-delete').classList.toggle('hidden', !onDelete);
  $('ed-sheet-status').textContent = '';
  $('ed-sections').replaceChildren(...song.sections.map(sectionRow));
  renderSheets();
  $('dlg-editor').showModal();
  queueMicrotask(refresh);
}
