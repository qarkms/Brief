// 홈 화면: 내 방 · 보관함(곡/셋리스트) · 내 정보
import {
  demoSong, makeId, normalizeSong, songDuration,
} from './timeline.js';
import { el, icon, sectionTone } from './ui.js';
import { formatDuration, openEditor } from './editor.js';
import {
  exportAll, importAll, loadLibrary, loadRooms, loadSetlists, putSetlist, putSong,
  removeFromLibrary, removeRoom, removeSetlist,
} from './library.js';
import { uploadSheetFile } from './sheets.js';

const $ = (id) => document.getElementById(id);
let api = null; // app.js가 넘겨주는 기능들
let roomStatus = {};
let pollTimer = null;

const songMeta = (song) => {
  const bars = song.sections.reduce((n, s) => n + s.bars, 0);
  return `${song.sections.length}파트 ${bars}마디 · ${song.bpm} BPM · ${song.beatsPerBar}/${song.beatUnit} · ${formatDuration(songDuration(song))}`;
};
const setlistMeta = (sl) => {
  const total = sl.songs.reduce((n, s) => n + songDuration(s), 0);
  return `${sl.songs.length}곡 · ${formatDuration(total)}`;
};
const ago = (ts) => {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
};

function partChips(song) {
  return el('div', { className: 'chips-mini' }, ...song.sections.slice(0, 10).map((sec) => {
    const c = el('span', { textContent: `${sec.name} ${sec.bars}` });
    c.dataset.tone = sectionTone(sec.name);
    return c;
  }), ...(song.sections.length > 10 ? [el('span', { textContent: '…' })] : []));
}

const iconBtn = (name, label, fn) => el('button', {
  type: 'button',
  className: 'icon-btn',
  title: label,
  ariaLabel: label,
  onclick: (e) => {
    e.stopPropagation();
    fn();
  },
}, icon(name));

// ---------- 탭 ----------
export function showHomeTab(name) {
  for (const t of ['home', 'library', 'me']) $(`tab-${t}`).classList.toggle('hidden', t !== name);
  document.querySelectorAll('.tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === 'home') refreshRooms();
}

// ---------- 내 방 ----------
async function fetchStatus(codes) {
  if (!codes.length) return {};
  try {
    const res = await fetch(`/api/rooms?codes=${codes.join(',')}`);
    return res.ok ? await res.json() : {};
  } catch {
    return null; // 연결 안 됨
  }
}

export async function refreshRooms() {
  renderRooms();
  const status = await fetchStatus(loadRooms().map((r) => r.code));
  if (status) {
    roomStatus = status;
    roomStatus.loaded = true;
  }
  renderRooms();
}

function renderRooms() {
  const rooms = loadRooms();
  const box = $('my-rooms');
  if (!rooms.length) {
    box.replaceChildren(el('li', { className: 'empty', innerHTML: '아직 들어간 방이 없어요.<br>새 방을 만들거나 코드로 입장해 보세요.' }));
    return;
  }
  box.replaceChildren(...rooms.map((r) => {
    const st = roomStatus[r.code];
    const host = !!api.hostTokenFor(r.code);
    const role = host ? '방장' : r.role === 'cohost' ? '부방장' : '멤버';
    let line;
    let cls = '';
    if (st) {
      cls = st.members ? 'live' : '';
      line = [
        el('span', { className: `dot${st.members ? ' on' : ''}` }),
        st.members ? `${st.members}명 접속 중` : '아무도 없어요',
        st.playing ? ` · ▶ ${st.song}` : ` · ${st.songs}곡`,
      ];
    } else if (roomStatus.loaded) {
      cls = 'closed';
      line = [host ? '닫힌 방 · 눌러서 다시 열기' : '닫힌 방 · 방장이 다시 열면 들어갈 수 있어요'];
    } else {
      line = [ago(r.lastVisited)];
    }
    const card = el(
      'button',
      { type: 'button', className: `room-card ${cls}` },
      el('span', { className: 'room-ic' }, icon('door')),
      el(
        'span',
        { className: 'room-info' },
        el('span', { className: 't' }, el('span', { textContent: r.title || `방 ${r.code}` }), el('span', { className: 'code', textContent: r.code }), el('span', { className: `role${role === '멤버' ? ' member' : ''}`, textContent: role })),
        el('span', { className: 's' }, ...line),
      ),
    );
    card.onclick = () => enterSavedRoom(r, st);
    const x = el('button', {
      type: 'button',
      className: 'row-x',
      title: '목록에서 지우기',
      onclick: () => {
        if (!confirm(`"${r.title || r.code}"을(를) 내 방 목록에서 지울까요?`)) return;
        removeRoom(r.code);
        renderRooms();
      },
    }, icon('close'));
    return el('li', { className: 'room-row' }, card, x);
  }));
}

function enterSavedRoom(r, st) {
  if (st || !roomStatus.loaded) {
    api.joinRoom(r.code);
    return;
  }
  const hostToken = api.hostTokenFor(r.code);
  if (hostToken) {
    api.createRoom({
      code: r.code, hostToken, title: r.title, setlist: r.setlist || [],
    });
  } else {
    api.toast('닫힌 방이에요. 방장이 다시 열면 들어갈 수 있어요');
  }
}

// ---------- 새 방 ----------
let newRoomChoice = null;
function openNewRoom(presetId = null) {
  const sets = loadSetlists();
  const last = api.lastSetlist();
  const choices = [
    ...sets.map((sl) => ({ id: sl.id, title: sl.name, sub: setlistMeta(sl), songs: sl.songs })),
    ...(last.length ? [{ id: 'last', title: '지난번 방의 셋리스트', sub: `${last.length}곡`, songs: last }] : []),
    { id: 'demo', title: '예시 곡으로 시작', sub: '방에서 곡을 추가·편집할 수 있어요', songs: [demoSong()] },
  ];
  newRoomChoice = choices.find((c) => c.id === presetId) || choices[0];
  const render = () => {
    $('new-room-choices').replaceChildren(...choices.map((c) => {
      const b = el(
        'button',
        { type: 'button', className: `choice${c === newRoomChoice ? ' on' : ''}` },
        el('span', { className: 'radio' }),
        el('span', {}, el('b', { textContent: c.title }), el('small', { textContent: c.sub })),
      );
      b.onclick = () => {
        newRoomChoice = c;
        render();
      };
      return b;
    }));
  };
  render();
  $('new-room-title').value = '';
  $('new-room-title').placeholder = `${api.getName() || '우리'} 팀 방`;
  $('dlg-new-room').showModal();
}

// ---------- 보관함: 곡 ----------
const localUpload = (file, onProgress) => uploadSheetFile(file, { onProgress });

function editLibrarySong(song, isNew = false) {
  openEditor(structuredClone(song), {
    isNew,
    toast: api.toast,
    upload: localUpload,
    onSave: (s) => {
      putSong({ ...s, id: song.id });
      api.toast(`"${s.title}" 저장됨`);
      renderLibrary();
    },
    onDelete: isNew ? null : () => {
      removeFromLibrary(song.id);
      renderLibrary();
    },
  });
}

function newSong(title = '새 곡') {
  return normalizeSong({
    id: makeId(),
    title,
    sections: [
      { name: 'Intro', bars: 4 }, { name: 'Verse 1', bars: 8 }, { name: 'Chorus', bars: 8 },
      { name: 'Verse 2', bars: 8 }, { name: 'Chorus', bars: 8 }, { name: 'Outro', bars: 4 },
    ],
  });
}

function songCard(song, acts) {
  const title = el('span', { className: 't' }, el('span', { textContent: song.title }));
  if (song.sheets.length) title.append(icon('score'), el('small', { className: 'count', textContent: `${song.sheets.length}장` }));
  const main = el('button', { type: 'button', className: 'lib-main' }, title, el('div', { className: 'm', textContent: songMeta(song) }), partChips(song));
  return { main, li: el('li', { className: 'lib-card' }, main, el('div', { className: 'lib-acts' }, ...acts)) };
}

function renderLibrary() {
  const q = $('lib-search').value.trim().toLowerCase();
  const songs = loadLibrary();
  const sets = loadSetlists();
  $('lib-count-songs').textContent = songs.length || '';
  $('lib-count-setlists').textContent = sets.length || '';

  const shown = songs.filter((s) => !q || s.title.toLowerCase().includes(q));
  $('lib-song-list').replaceChildren(...(shown.length ? shown.map((song) => {
    const { main, li } = songCard(song, [
      iconBtn('copy', '복제', () => {
        putSong({ ...structuredClone(song), id: makeId(), title: `${song.title} (복사본)` });
        renderLibrary();
      }),
      iconBtn('trash', '삭제', () => {
        if (!confirm(`"${song.title}"을(를) 보관함에서 지울까요?`)) return;
        removeFromLibrary(song.id);
        renderLibrary();
      }),
    ]);
    main.onclick = () => editLibrarySong(song);
    return li;
  }) : [el('li', { className: 'empty', innerHTML: q ? '찾는 곡이 없어요' : '저장된 곡이 없어요.<br>새 곡을 만들거나, 방에서 "보관함에 저장"을 눌러 보세요.' })]));

  const setCard = (sl) => {
    const main = el(
      'button',
      { type: 'button', className: 'lib-main' },
      el('span', { className: 't', textContent: sl.name }),
      el('div', { className: 'm', textContent: setlistMeta(sl) }),
      el('div', { className: 'chips-mini' }, ...sl.songs.slice(0, 6).map((s, i) => el('span', { textContent: `${i + 1}. ${s.title}` }))),
    );
    main.onclick = () => openSetlistEditor(sl);
    return el('li', { className: 'lib-card' }, main, el(
      'div',
      { className: 'lib-acts' },
      iconBtn('door', '이 셋리스트로 방 열기', () => openNewRoom(sl.id)),
    ));
  };
  $('lib-setlist-list').replaceChildren(...(sets.length ? sets.map(setCard) : [el('li', { className: 'empty', innerHTML: '저장된 셋리스트가 없어요.<br>곡들을 묶어 예배·공연 순서를 만들어 보세요.' })]));
  $('home-setlists').replaceChildren(...(sets.length ? sets.slice(0, 3).map(setCard) : [el('li', { className: 'empty', innerHTML: '셋리스트를 만들면 여기서 바로 방을 열 수 있어요' })]));
}

// ---------- 보관함: 셋리스트 편집 ----------
let editingSet = null;
function openSetlistEditor(sl = null) {
  editingSet = sl ? structuredClone(sl) : { id: null, name: '', songs: [] };
  $('sl-name').value = editingSet.name;
  $('sl-delete').classList.toggle('hidden', !editingSet.id);
  renderSetlistSongs();
  $('dlg-setlist-edit').showModal();
}

function renderSetlistSongs() {
  const list = editingSet.songs;
  $('sl-songs').replaceChildren(...(list.length ? list.map((song, i) => {
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      renderSetlistSongs();
    };
    const { main, li } = songCard(song, [
      iconBtn('up', '위로', () => move(-1)),
      iconBtn('down', '아래로', () => move(1)),
      iconBtn('close', '빼기', () => {
        list.splice(i, 1);
        renderSetlistSongs();
      }),
    ]);
    main.querySelector('.t').prepend(el('span', { className: 'count', textContent: `${i + 1}.` }));
    main.onclick = () => openEditor(structuredClone(song), {
      toast: api.toast,
      upload: localUpload,
      onSave: (s) => {
        list[i] = s;
        renderSetlistSongs();
      },
    });
    return li;
  }) : [el('li', { className: 'empty', textContent: '곡을 넣어 주세요' })]));
}

function openPickSongs() {
  const songs = loadLibrary();
  if (!songs.length) {
    api.toast('보관함에 곡이 없어요. "새 곡 만들기"로 만들어 보세요');
    return;
  }
  const picked = new Set();
  $('pick-songs').replaceChildren(...songs.map((song) => {
    const li = el('li', {}, el('span', { className: 'check' }, icon('right')), el('span', { className: 'name' }, el('div', { textContent: song.title }), el('div', { className: 'hint', textContent: songMeta(song) })));
    li.onclick = () => {
      if (picked.has(song)) picked.delete(song);
      else picked.add(song);
      li.classList.toggle('on', picked.has(song));
    };
    return li;
  }));
  $('pick-songs-ok').onclick = () => {
    for (const s of songs) if (picked.has(s)) editingSet.songs.push({ ...structuredClone(s), id: makeId() });
    $('dlg-pick-songs').close();
    renderSetlistSongs();
  };
  $('dlg-pick-songs').showModal();
}

function saveEditingSet() {
  editingSet.name = $('sl-name').value.trim() || `셋리스트 ${new Date().toLocaleDateString('ko-KR')}`;
  const saved = putSetlist(editingSet);
  editingSet.id = saved.id;
  renderLibrary();
  return saved;
}

// ---------- 이름 ----------
let afterName = null;
export function askName(then) {
  afterName = then;
  $('name-input').value = api.getName();
  $('dlg-name').showModal();
  setTimeout(() => $('name-input').focus(), 50);
}

export function renderHello() {
  const name = api.getName();
  $('hello-name').textContent = name ? `${name}님` : '이름을 정해 주세요';
  if (document.activeElement !== $('me-name')) $('me-name').value = name;
}

// ---------- 시작 ----------
export function initHome(a) {
  api = a;
  document.querySelectorAll('.tabbar .tab').forEach((b) => { b.onclick = () => showHomeTab(b.dataset.tab); });
  document.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => showHomeTab(b.dataset.goto); });

  $('btn-hello').onclick = () => askName(null);
  $('name-ok').onclick = () => {
    const name = $('name-input').value.trim();
    if (!name) {
      $('name-input').focus();
      return;
    }
    api.setName(name);
    renderHello();
    $('dlg-name').close();
    const then = afterName;
    afterName = null;
    then?.();
  };
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('name-ok').click(); });
  $('me-name').addEventListener('change', () => {
    api.setName($('me-name').value.trim());
    renderHello();
  });
  $('btn-me-settings').onclick = api.openSettings;
  $('btn-home-settings').onclick = api.openSettings;

  $('btn-new-room').onclick = () => openNewRoom();
  $('btn-create').onclick = () => {
    const title = $('new-room-title').value.trim() || $('new-room-title').placeholder;
    $('dlg-new-room').close();
    api.createRoom({ title, setlist: newRoomChoice.songs });
  };
  $('btn-join-code').onclick = () => {
    $('home-error').textContent = '';
    $('dlg-join').showModal();
    setTimeout(() => $('home-code').focus(), 50);
  };
  $('btn-join').onclick = () => {
    const code = $('home-code').value.trim().toUpperCase();
    if (code.length !== 4) {
      $('home-error').textContent = '4자리 방 코드를 입력하세요.';
      return;
    }
    $('dlg-join').close();
    api.joinRoom(code);
  };
  $('home-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('btn-refresh-rooms').onclick = refreshRooms;

  // 보관함
  const libTab = (songs) => {
    $('lib-tab-songs').classList.toggle('active', songs);
    $('lib-tab-setlists').classList.toggle('active', !songs);
    $('lib-songs').classList.toggle('hidden', !songs);
    $('lib-setlists').classList.toggle('hidden', songs);
  };
  $('lib-tab-songs').onclick = () => libTab(true);
  $('lib-tab-setlists').onclick = () => libTab(false);
  $('lib-search').addEventListener('input', renderLibrary);
  $('btn-lib-new-song').onclick = () => editLibrarySong(newSong(), true);
  $('btn-lib-new-setlist').onclick = () => openSetlistEditor();
  $('sl-add-lib').onclick = openPickSongs;
  $('sl-add-new').onclick = () => {
    const song = newSong(`새 곡 ${editingSet.songs.length + 1}`);
    openEditor(song, {
      isNew: true,
      toast: api.toast,
      upload: localUpload,
      onSave: (s) => {
        editingSet.songs.push(s);
        putSong({ ...s, id: makeId() }); // 새 곡은 보관함에도 저장
        renderSetlistSongs();
        renderLibrary();
      },
    });
  };
  $('sl-save').onclick = () => {
    saveEditingSet();
    $('dlg-setlist-edit').close();
    api.toast('셋리스트를 저장했어요');
  };
  $('sl-open-room').onclick = () => {
    if (!editingSet.songs.length) {
      api.toast('곡을 먼저 넣어 주세요');
      return;
    }
    const saved = saveEditingSet();
    $('dlg-setlist-edit').close();
    openNewRoom(saved.id);
  };
  $('sl-delete').onclick = () => {
    if (!confirm('이 셋리스트를 지울까요? (곡은 보관함에 그대로 남아요)')) return;
    removeSetlist(editingSet.id);
    $('dlg-setlist-edit').close();
    renderLibrary();
  };

  $('btn-lib-export').onclick = () => {
    const blob = new Blob([JSON.stringify(exportAll(), null, 2)], { type: 'application/json' });
    const a2 = el('a', { href: URL.createObjectURL(blob), download: `brief-보관함-${new Date().toISOString().slice(0, 10)}.json` });
    a2.click();
    setTimeout(() => URL.revokeObjectURL(a2.href), 1000);
  };
  $('lib-import').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      // 방에서 내보낸 셋리스트 파일도 셋리스트로 받는다
      const res = data.kind === 'library' ? importAll(data) : importAll({ setlists: [{ name: file.name.replace(/\.json$/, ''), songs: data.setlist || data }] });
      api.toast(`곡 ${res.songs}개 · 셋리스트 ${res.setlists}개를 불러왔어요`);
      renderLibrary();
    } catch {
      api.toast('올바른 백업 파일이 아니에요');
    }
  };

  renderHello();
  renderLibrary();
}

/** 홈이 보일 때 */
export function onHomeShown() {
  renderHello();
  renderLibrary();
  refreshRooms();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!$('view-home').classList.contains('hidden') && document.visibilityState === 'visible') refreshRooms();
  }, 15000);
}

export function onHomeHidden() {
  clearInterval(pollTimer);
}
