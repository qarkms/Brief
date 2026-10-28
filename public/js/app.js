import { Connection } from './net.js';
import { DEFAULT_SETTINGS, Engine } from './engine.js';
import {
  buildPlan, findBarIndex, makeId, normalizeSetlist, normalizeSong, songDuration,
} from './timeline.js';
import {
  formatDuration, loadLibrary, openEditor, removeFromLibrary,
} from './editor.js';
import {
  buildFormStrip, el, hydrateIcons, icon, sectionTone, updateFormStrip,
} from './ui.js';
import {
  ensureSheets, preload, sheetUrl, uploadSheetFile,
} from './sheets.js';

const $ = (id) => document.getElementById(id);

// ---------- 저장소 ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* 무시 */ }
  },
};

const settings = { ...DEFAULT_SETTINGS, ...store.get('brief.settings', {}) };
const conn = new Connection();
const engine = new Engine(conn, settings);

const app = {
  me: null,
  code: null, // 현재(또는 재접속할) 방 코드
  state: null,
  plan: null,
  playId: null,
  pendingOnOpen: null,
  playingSong: null,
};

const isHost = () => !!app.state && app.state.hostId === app.me;
const hostTokenFor = (code) => store.get(`brief.host.${code}`, null);

// ---------- 토스트 ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------- 화면 전환 ----------
function showHome(error = '') {
  $('view-room').classList.add('hidden');
  $('view-home').classList.remove('hidden');
  $('audio-gate').classList.add('hidden');
  closeScore();
  $('home-error').textContent = error;
  document.body.classList.remove('host');
  releaseWakeLock();
}

function showRoom() {
  $('view-home').classList.add('hidden');
  $('view-room').classList.remove('hidden');
  updateAudioGate();
  requestWakeLock();
}

function updateAudioGate() {
  const inRoom = !$('view-room').classList.contains('hidden');
  $('audio-gate').classList.toggle('hidden', !inRoom || engine.unlocked);
}

// ---------- 연결 ----------
function sendWhenOpen(type, data) {
  if (conn.open) {
    conn.send(type, data);
  } else {
    app.pendingOnOpen = { type, data };
    conn.connect();
  }
}

conn.addEventListener('open', () => {
  $('conn-status').classList.add('ok');
  if (app.pendingOnOpen) {
    const { type, data } = app.pendingOnOpen;
    app.pendingOnOpen = null;
    conn.send(type, data);
  } else if (app.code) {
    // 재접속: 같은 방으로 다시 들어간다
    conn.send('join', { code: app.code, name: myName(), hostToken: hostTokenFor(app.code) });
  }
});
conn.addEventListener('close', () => $('conn-status').classList.remove('ok'));

conn.addEventListener('joined', ({ detail }) => {
  app.me = detail.you;
  app.code = detail.code;
  if (detail.hostToken) store.set(`brief.host.${detail.code}`, detail.hostToken);
  store.set('brief.session', { code: detail.code });
  $('room-code').textContent = detail.code;
  history.replaceState(null, '', `?room=${detail.code}`);
  showRoom();
});

conn.addEventListener('host', ({ detail }) => {
  store.set(`brief.host.${app.code}`, detail.hostToken);
  toast(detail.hostToken ? '이제 내가 방장이에요' : '방장을 넘겼어요');
});

conn.addEventListener('state', ({ detail }) => onState(detail.state));

conn.addEventListener('error', ({ detail }) => {
  if (detail.code === 'ROOM_NOT_FOUND') {
    leaveRoom();
    showHome(detail.message);
  } else {
    toast(detail.message || '오류가 발생했어요');
  }
});

conn.addEventListener('sync', ({ detail }) => {
  $('sync-info').textContent = `시계 동기화: 서버 왕복 ${Math.round(detail.rtt)}ms`;
});

function myName() {
  return $('home-name').value.trim() || store.get('brief.name', '') || '멤버';
}

function leaveRoom() {
  conn.send('leave');
  engine.stop();
  app.code = null;
  app.state = null;
  app.plan = null;
  app.playId = null;
  app.playingSong = null;
  store.set('brief.session', null);
  history.replaceState(null, '', location.pathname);
}

// ---------- 방 상태 ----------
let ensureTimer;
function onState(state) {
  app.state = state;
  document.body.classList.toggle('host', isHost());

  const pb = state.playback;
  if ((pb && pb.playId) !== app.playId) {
    app.playId = pb ? pb.playId : null;
    app.plan = pb ? buildPlan(pb) : null;
    app.playingSong = pb ? pb.startSongIndex : null;
    if (pb && engine.unlocked) engine.start(app.plan, pb.startAt);
    else engine.stop();
  }

  if (isHost()) {
    store.set('brief.setlist', state.setlist);
    // 서버가 재시작돼 악보가 사라졌으면 이 기기에 보관된 파일로 복구
    clearTimeout(ensureTimer);
    ensureTimer = setTimeout(() => {
      ensureSheets(state.setlist, { room: app.code, hostToken: hostTokenFor(app.code) })
        .then((n) => {
          if (!n) return;
          toast(`악보 ${n}장을 다시 올렸어요`);
          score.key = null;
        });
    }, 300);
  }

  $('member-count').textContent = state.members.length;
  renderMembers();
  renderSetlist();
  renderStructure();
  renderOptions();
  renderTransport();
  stageFormSong = null;
  score.key = null;
}

function renderOptions() {
  const host = isHost();
  $('opt-auto').checked = app.state.autoAdvance;
  $('opt-auto').disabled = !host;
  if (document.activeElement !== $('opt-gap')) $('opt-gap').value = app.state.gapSeconds;
  $('opt-gap').disabled = !host;
}

function renderTransport() {
  const playing = !!app.state.playback;
  $('btn-play').classList.toggle('stop', playing);
  $('play-label').textContent = playing ? '정지' : '시작';
}

function songMeta(song) {
  return `${song.bpm} BPM · ${song.beatsPerBar}박 · ${formatDuration(songDuration(song))}`;
}

function renderSetlist() {
  const { setlist, selectedSong } = app.state;
  const host = isHost();
  $('setlist').replaceChildren(...setlist.map((song, i) => {
    const title = el('div', { className: 'title' }, el('span', { textContent: song.title }));
    if (song.sheets.length) title.append(icon('score'));
    const form = el('div', { className: 'form-strip mini-form' });
    buildFormStrip(form, song, { labels: false });
    const li = el(
      'li',
      { className: i === selectedSong ? 'selected' : '' },
      el('span', { className: 'num', textContent: i + 1 }),
      el('div', { className: 'info' }, title, el('div', { className: 'meta', textContent: songMeta(song) }), form),
    );
    li.dataset.index = i;
    if (host) {
      const act = (name, label, fn) => el('button', {
        type: 'button',
        title: label,
        ariaLabel: label,
        onclick: (e) => {
          e.stopPropagation();
          fn();
        },
      }, icon(name));
      li.append(el(
        'div',
        { className: 'acts' },
        act('up', '위로', () => moveSong(i, -1)),
        act('down', '아래로', () => moveSong(i, 1)),
        act('edit', '편집', () => editSong(i)),
      ));
      li.onclick = () => conn.send('select', { songIndex: i, sectionIndex: 0 });
    }
    return li;
  }));
  lastPlayingLi = undefined;
}

function displaySongs() {
  return app.state.playback ? app.state.playback.songs : app.state.setlist;
}

function renderStructure() {
  if (!app.state) return;
  const si = app.playingSong ?? app.state.selectedSong;
  const song = displaySongs()[si];
  const box = $('structure');
  if (!song) {
    box.replaceChildren();
    return;
  }
  const selectable = isHost() && !app.state.playback;
  box.replaceChildren(...song.sections.map((sec, k) => {
    const extra = [sec.bpm ? `${sec.bpm} BPM` : '', sec.beatsPerBar ? `${sec.beatsPerBar}박` : ''].filter(Boolean).join(' · ');
    const chip = el(
      'button',
      { type: 'button', className: 'chip' },
      el('span', { className: 'n', textContent: sec.name }),
      el('span', { className: 'b', textContent: `${sec.bars}마디${extra ? ` · ${extra}` : ''}` }),
    );
    chip.dataset.k = k;
    chip.dataset.tone = sectionTone(sec.name);
    if (!app.state.playback && k === app.state.selectedSection && si === app.state.selectedSong && k > 0) {
      chip.classList.add('selected');
    }
    chip.onclick = () => {
      if (selectable) conn.send('select', { songIndex: si, sectionIndex: k });
      else if (isHost()) toast('정지한 뒤 시작할 파트를 고를 수 있어요');
    };
    return chip;
  }));
  lastChipKey = null;
}

// ---------- 방장 동작 ----------
function pushSetlist(setlist) {
  conn.send('setlist', { setlist });
}

function uploader(file, onProgress) {
  return uploadSheetFile(file, { room: app.code, hostToken: hostTokenFor(app.code), onProgress });
}

function moveSong(i, dir) {
  const list = [...app.state.setlist];
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  pushSetlist(list);
  if (app.state.selectedSong === i) conn.send('select', { songIndex: j });
}

function editSong(i) {
  const song = app.state.setlist[i];
  openEditor(structuredClone(song), {
    toast,
    upload: uploader,
    onSave: (s) => {
      const list = [...app.state.setlist];
      list[i] = s;
      pushSetlist(list);
    },
    onDelete: app.state.setlist.length > 1 ? () => {
      pushSetlist(app.state.setlist.filter((_, k) => k !== i));
    } : null,
  });
}

function addSong() {
  const last = app.state.setlist[app.state.setlist.length - 1];
  const song = normalizeSong({
    id: makeId(),
    title: `새 곡 ${app.state.setlist.length + 1}`,
    bpm: last ? last.bpm : 120,
    beatsPerBar: last ? last.beatsPerBar : 4,
    countInBars: 1,
    sections: [
      { name: 'Intro', bars: 4 },
      { name: 'Verse', bars: 8 },
      { name: 'Chorus', bars: 8 },
      { name: 'Outro', bars: 4 },
    ],
  });
  openEditor(song, {
    isNew: true,
    toast,
    upload: uploader,
    onSave: (s) => {
      pushSetlist([...app.state.setlist, s]);
      conn.send('select', { songIndex: app.state.setlist.length });
    },
  });
}

function currentSongIndex() {
  return app.state.playback ? (app.playingSong ?? app.state.playback.startSongIndex) : app.state.selectedSong;
}

function stepSong(dir) {
  const n = app.state.setlist.length;
  const target = currentSongIndex() + dir;
  if (target < 0 || target >= n) return;
  if (app.state.playback) conn.send('play', { songIndex: target, sectionIndex: 0 });
  else conn.send('select', { songIndex: target, sectionIndex: 0 });
}

// ---------- 참가자 ----------
function renderMembers() {
  const host = isHost();
  $('member-list').replaceChildren(...app.state.members.map((m) => {
    const li = el(
      'li',
      {},
      el('span', { className: 'avatar', textContent: [...m.name][0] || '?' }),
      el('span', { className: 'name', textContent: m.name }),
    );
    if (m.isHost) li.append(el('span', { className: 'badge' }, icon('crown'), '방장'));
    if (m.id === app.me) li.append(el('span', { className: 'badge me', textContent: '나' }));
    if (host && m.id !== app.me) {
      li.append(el('button', {
        type: 'button',
        className: 'btn ghost sm',
        textContent: '방장 넘기기',
        onclick: () => {
          if (confirm(`${m.name}님에게 방장을 넘길까요?`)) conn.send('transfer', { to: m.id });
        },
      }));
    }
    return li;
  }));
}

// ---------- 보관함 ----------
function renderLibrary() {
  const songs = loadLibrary();
  const list = $('library-list');
  if (!songs.length) {
    list.replaceChildren(el('li', { className: 'hint', textContent: '저장된 곡이 없어요. 곡 편집 화면에서 "보관함에 저장"을 누르세요.' }));
    return;
  }
  list.replaceChildren(...songs.map((song) => el(
    'li',
    {},
    el('span', {
      className: 'name clickable',
      onclick: () => {
        pushSetlist([...app.state.setlist, { ...song, id: makeId() }]);
        toast(`"${song.title}" 추가됨`);
      },
    }, el('div', { textContent: song.title }), el('div', { className: 'hint', textContent: songMeta(song) })),
    el('button', {
      type: 'button',
      className: 'btn danger-ghost sm',
      textContent: '삭제',
      onclick: () => {
        if (!confirm(`보관함에서 "${song.title}" 삭제?`)) return;
        removeFromLibrary(song.id);
        renderLibrary();
      },
    }),
  )));
}

// ---------- 현재 위치 계산 ----------
function nextSectionInfo(plan, idx) {
  const bar = plan.bars[idx];
  for (let j = idx + 1; j < plan.bars.length; j++) {
    const b = plan.bars[j];
    if (b.songIndex !== bar.songIndex) return { song: b.songIndex };
    if (b.sectionIndex !== bar.sectionIndex) return { sectionIndex: b.sectionIndex, barsUntil: j - idx };
  }
  return null;
}

/** 지금 이 순간 무엇이 연주되고 있는지 */
function position() {
  const { state, plan } = app;
  const pb = state.playback;
  if (!pb || !plan) {
    const si = state.selectedSong;
    return {
      mode: 'idle', songIndex: si, song: state.setlist[si], sectionIndex: state.selectedSection,
    };
  }
  const t = (conn.serverNow() - pb.startAt) / 1000;
  if (t < 0) return { mode: 'pre', songIndex: pb.startSongIndex, song: pb.songs[pb.startSongIndex], wait: -t };
  const idx = findBarIndex(plan, t);
  if (idx === -1) {
    const upcoming = plan.songs.find((s) => s.start > t);
    if (!upcoming) {
      const lastSong = plan.songs[plan.songs.length - 1].songIndex;
      return { mode: 'end', songIndex: lastSong, song: pb.songs[lastSong] };
    }
    return {
      mode: 'gap', songIndex: upcoming.songIndex, song: pb.songs[upcoming.songIndex], wait: upcoming.start - t,
    };
  }
  const bar = plan.bars[idx];
  const into = (t - bar.t) / bar.dur;
  const meta = plan.songs.find((s) => s.songIndex === bar.songIndex);
  return {
    mode: 'play',
    idx,
    bar,
    songIndex: bar.songIndex,
    song: pb.songs[bar.songIndex],
    sectionIndex: bar.sectionIndex,
    beat: Math.min(bar.beats - 1, Math.floor((t - bar.t) / bar.beatDur)),
    sectionProgress: (bar.bar - 1 + into) / bar.barsInSection,
    songProgress: meta ? (t - meta.start) / (meta.end - meta.start) : 0,
    next: nextSectionInfo(plan, idx),
  };
}

const sectionName = (pos) => (pos.sectionIndex < 0 ? '카운트' : pos.song.sections[pos.sectionIndex].name);
const sectionToneOf = (pos) => (pos.sectionIndex < 0 ? 'count' : sectionTone(sectionName(pos)));

// ---------- 무대 화면 (매 프레임) ----------
let lastBeatKey = null;
let lastBarHtml = null;
let lastChipKey = null;
let lastPlayingLi;
let stageFormSong = null;

function setText(id, text) {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
}

function renderBeats(box, beats, active) {
  if (box.childElementCount !== beats) {
    box.replaceChildren(...Array.from({ length: beats }, (_, i) => el('span', { className: i === 0 ? 'beat first' : 'beat' })));
  }
  for (let i = 0; i < beats; i++) box.children[i].classList.toggle('on', i === active);
}

function setBarHtml(html) {
  if (lastBarHtml === html) return;
  lastBarHtml = html;
  $('stage-bar').innerHTML = html;
}

function setPlayingSong(si) {
  if (app.playingSong === si) return;
  app.playingSong = si;
  renderStructure();
}

function highlight(pos) {
  const playing = pos.mode === 'play';
  const cur = playing ? pos.sectionIndex : -1;
  const next = playing && pos.next && pos.next.barsUntil ? pos.next.sectionIndex : -1;
  const key = `${pos.songIndex}:${cur}:${next}`;
  if (lastChipKey !== key) {
    lastChipKey = key;
    $('structure').querySelectorAll('.chip').forEach((c) => {
      const k = Number(c.dataset.k);
      c.classList.toggle('current', k === cur);
      c.classList.toggle('next', k === next);
    });
  }
  const playingSong = app.state.playback ? pos.songIndex : null;
  if (lastPlayingLi !== playingSong) {
    lastPlayingLi = playingSong;
    $('setlist').querySelectorAll('li').forEach((li) => {
      li.classList.toggle('playing', Number(li.dataset.index) === playingSong);
    });
  }
}

function renderStage(pos) {
  const stage = $('stage');
  const { song } = pos;
  setText('stage-song-title', `${pos.songIndex + 1}. ${song.title}`);

  if (stageFormSong !== song) {
    stageFormSong = song;
    buildFormStrip($('stage-form'), song, { labels: false });
  }

  let soon = false;
  if (pos.mode === 'play') {
    const { bar } = pos;
    stage.dataset.tone = sectionToneOf(pos);
    setText('stage-bpm', `${Math.round(bar.bpm * 10) / 10} BPM`);
    setText('stage-status', '재생 중');
    setText('stage-section', sectionName(pos));
    setBarHtml(`마디 <b>${bar.bar}</b> / ${bar.barsInSection}`);
    renderBeats($('beat-dots'), bar.beats, pos.beat);

    const { next } = pos;
    if (!next) {
      setText('stage-next', bar.bar === bar.barsInSection ? '마지막 마디' : '마지막 파트');
    } else if (next.barsUntil === undefined) {
      setText('stage-next', `다음 곡 · ${app.state.playback.songs[next.song].title}`);
    } else {
      const name = song.sections[next.sectionIndex].name;
      soon = next.barsUntil === 1;
      setText('stage-next', soon ? `▸ ${name}` : `다음 ${name} · ${next.barsUntil}마디 후`);
    }
    updateFormStrip($('stage-form'), pos.sectionIndex, pos.sectionProgress, soon ? next.sectionIndex : -1);

    const beatKey = `${pos.idx}:${pos.beat}`;
    if (beatKey !== lastBeatKey) {
      lastBeatKey = beatKey;
      if (pos.beat === 0) {
        stage.classList.add('flash');
        setTimeout(() => stage.classList.remove('flash'), 90);
      }
    }
  } else {
    setText('stage-bpm', `${song.bpm} BPM`);
    renderBeats($('beat-dots'), song.beatsPerBar, -1);
    updateFormStrip($('stage-form'), -1, 0, -1);
    if (pos.mode === 'idle') {
      const sec = song.sections[pos.sectionIndex];
      stage.dataset.tone = sectionTone(sec.name);
      setText('stage-status', isHost() ? '시작을 누르면 모두 함께 시작해요' : '방장의 시작을 기다리는 중');
      setText('stage-section', sec.name);
      const bars = song.sections.reduce((n, s) => n + s.bars, 0);
      setBarHtml(`${bars}마디 · ${formatDuration(songDuration(song))}`);
      setText('stage-next', pos.sectionIndex > 0 ? `${pos.sectionIndex + 1}번째 파트부터 시작` : ' ');
    } else if (pos.mode === 'pre') {
      stage.dataset.tone = 'count';
      setText('stage-status', `시작까지 ${pos.wait.toFixed(1)}초`);
      setText('stage-section', '준비');
      setBarHtml('&nbsp;');
      setText('stage-next', ' ');
    } else if (pos.mode === 'gap') {
      stage.dataset.tone = 'count';
      setText('stage-status', `다음 곡까지 ${Math.ceil(pos.wait)}초`);
      setText('stage-section', song.title);
      setBarHtml('&nbsp;');
      setText('stage-next', '다음 곡');
    } else {
      stage.dataset.tone = 'count';
      setText('stage-status', ' ');
      setText('stage-section', '끝');
      setBarHtml('&nbsp;');
      setText('stage-next', ' ');
    }
  }
  $('stage-next').classList.toggle('soon', soon);
  stage.classList.toggle('briefing', soon);
  highlight(pos);
}

// ---------- 악보 보기 ----------
const score = { open: false, key: null, songIndex: null, page: 0 };

function openScore() {
  score.open = true;
  score.key = null;
  $('view-score').classList.remove('hidden');
}

function closeScore() {
  score.open = false;
  $('view-score').classList.add('hidden');
}

function pagesPerView(sheets) {
  return sheets.length > 1 && innerWidth > innerHeight * 1.15 ? 2 : 1;
}

function renderScorePages(song) {
  const { sheets } = song;
  const box = $('score-pages');
  const empty = !sheets.length;
  box.classList.toggle('hidden', empty);
  $('score-empty').classList.toggle('hidden', !empty);
  $('view-score').querySelector('.score-nav').classList.toggle('hidden', sheets.length < 2);
  if (empty) {
    box.replaceChildren();
    return;
  }
  const per = pagesPerView(sheets);
  score.page = Math.max(0, Math.min(score.page, sheets.length - 1));
  score.page -= score.page % per;
  const shown = sheets.slice(score.page, score.page + per);
  box.classList.toggle('spread', shown.length > 1);
  box.replaceChildren(...shown.map((p, i) => el('img', {
    src: sheetUrl(p.id), alt: `${score.page + i + 1}쪽`, draggable: false, decoding: 'async',
  })));
  const last = score.page + shown.length;
  setText('score-page', `${shown.length > 1 ? `${score.page + 1}–${last}` : score.page + 1} / ${sheets.length}`);
  // 다음 페이지 미리 받기
  preload(sheets.slice(last, last + per));
}

function turnPage(dir) {
  if (!score.open || !app.state) return;
  const song = displaySongs()[score.songIndex];
  if (!song || !song.sheets.length) return;
  const per = pagesPerView(song.sheets);
  const page = score.page + dir * per;
  if (page < 0 || page >= song.sheets.length) return;
  score.page = page;
  renderScorePages(song);
}

function renderScore(pos) {
  const { song } = pos;
  const key = `${pos.songIndex}:${song.id}:${song.sheets.map((p) => p.id).join(',')}`;
  if (score.key !== key) {
    // 곡이 바뀌면(자동 다음 곡 포함) 그 곡의 악보 첫 페이지로
    if (score.songIndex !== pos.songIndex) score.page = 0;
    score.key = key;
    score.songIndex = pos.songIndex;
    setText('score-title', `${pos.songIndex + 1}. ${song.title}`);
    buildFormStrip($('score-form'), song);
    renderScorePages(song);
    const nextSong = displaySongs()[pos.songIndex + 1];
    if (nextSong) preload(nextSong.sheets.slice(0, 2));
  }

  const bar = $('view-score').querySelector('.score-bar');
  let brief = '';
  if (pos.mode === 'play') {
    bar.dataset.tone = sectionToneOf(pos);
    setText('score-pos', `${sectionName(pos)} ${pos.bar.bar}/${pos.bar.barsInSection}`);
    renderBeats($('score-beats'), pos.bar.beats, pos.beat);
    const { next } = pos;
    const soon = next && next.barsUntil === 1;
    if (soon) brief = `▸ ${song.sections[next.sectionIndex].name}`;
    updateFormStrip($('score-form'), pos.sectionIndex, pos.sectionProgress, soon ? next.sectionIndex : -1);
  } else {
    bar.dataset.tone = 'count';
    let label = '대기';
    if (pos.mode === 'pre') label = `시작 ${pos.wait.toFixed(1)}초 전`;
    else if (pos.mode === 'gap') label = `다음 곡 ${Math.ceil(pos.wait)}초 전`;
    else if (pos.mode === 'end') label = '끝';
    setText('score-pos', label);
    renderBeats($('score-beats'), song.beatsPerBar, -1);
    updateFormStrip($('score-form'), -1, 0, -1);
  }
  setText('score-brief', brief);
}

function setupScoreInput() {
  const pages = $('score-pages');
  let downX = null;
  let downY = null;
  pages.addEventListener('pointerdown', (e) => {
    downX = e.clientX;
    downY = e.clientY;
  });
  pages.addEventListener('pointerup', (e) => {
    if (downX === null) return;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    downX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      turnPage(dx < 0 ? 1 : -1);
    } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      // 탭: 왼쪽 40%는 이전, 나머지는 다음 페이지
      const r = pages.getBoundingClientRect();
      turnPage(e.clientX - r.left < r.width * 0.4 ? -1 : 1);
    }
  });
  $('score-prev').onclick = () => turnPage(-1);
  $('score-next').onclick = () => turnPage(1);
  $('btn-score').onclick = openScore;
  $('btn-score-close').onclick = closeScore;
  // 블루투스 페이지 넘김 페달은 보통 화살표/PageDown 키를 보낸다
  document.addEventListener('keydown', (e) => {
    if (!score.open) return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) turnPage(1);
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) turnPage(-1);
    else if (e.key === 'Escape') closeScore();
    else return;
    e.preventDefault();
  });
  addEventListener('resize', () => { score.key = null; });
}

function frame() {
  // 화면 오류가 나도 다음 프레임은 계속 그린다
  requestAnimationFrame(frame);
  if (app.state && !$('view-room').classList.contains('hidden')) {
    const pos = position();
    if (app.state.playback) setPlayingSong(pos.songIndex);
    else setPlayingSong(null);
    renderStage(pos);
    if (score.open) renderScore(pos);
  }
}

// ---------- 화면 꺼짐 방지 ----------
let wakeLock = null;
async function requestWakeLock() {
  if (!settings.wakeLock || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* 권한 없음 */ }
}
function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.code) {
    requestWakeLock();
    updateAudioGate();
  }
});

// ---------- 설정 ----------
function saveSettings() {
  store.set('brief.settings', settings);
}

function populateVoices() {
  const select = $('set-voice-uri');
  const voices = engine.voices();
  select.replaceChildren(
    el('option', { value: '', textContent: '기본 (영어)' }),
    ...voices.map((v) => el('option', { value: v.voiceURI, textContent: `${v.name} (${v.lang})` })),
  );
  select.value = settings.voiceURI;
}

function bindSettings() {
  const bind = (id, key, { type = 'value', parse = Number, out } = {}) => {
    const input = $(id);
    const show = () => { if (out) $(out).textContent = settings[key]; };
    if (type === 'checked') input.checked = settings[key];
    else input.value = settings[key];
    show();
    input.addEventListener('input', () => {
      settings[key] = type === 'checked' ? input.checked : parse(input.value);
      show();
      saveSettings();
    });
  };
  bind('set-click', 'click', { type: 'checked' });
  bind('set-click-vol', 'clickVolume');
  bind('set-voice', 'voice', { type: 'checked' });
  bind('set-voice-uri', 'voiceURI', { parse: String });
  bind('set-voice-vol', 'voiceVolume');
  bind('set-voice-rate', 'voiceRate');
  bind('set-voice-pitch', 'voicePitch');
  bind('set-latency', 'latencyMs', { out: 'set-latency-out' });
  bind('set-lead', 'speechLeadMs', { out: 'set-lead-out' });
  bind('set-wake', 'wakeLock', { type: 'checked' });
  $('set-wake').addEventListener('change', () => (settings.wakeLock ? requestWakeLock() : releaseWakeLock()));

  populateVoices();
  if (window.speechSynthesis) window.speechSynthesis.addEventListener?.('voiceschanged', populateVoices);
  $('btn-test-voice').onclick = () => {
    engine.unlock();
    engine.speak('Chorus');
  };
}

// ---------- 이벤트 바인딩 ----------
function enterWithAudio(type, data) {
  const name = $('home-name').value.trim();
  store.set('brief.name', name);
  engine.unlock().then(updateAudioGate, () => {});
  sendWhenOpen(type, { ...data, name: name || '멤버' });
}

$('btn-create').onclick = () => {
  enterWithAudio('create', { setlist: normalizeSetlist(store.get('brief.setlist', [])) });
};

$('btn-join').onclick = () => {
  const code = $('home-code').value.trim().toUpperCase();
  if (code.length !== 4) {
    $('home-error').textContent = '4자리 방 코드를 입력하세요.';
    return;
  }
  app.code = code;
  enterWithAudio('join', { code, hostToken: hostTokenFor(code) });
};
$('home-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });

$('btn-unlock').onclick = () => {
  engine.unlock().then(() => {
    updateAudioGate();
    const pb = app.state?.playback;
    if (pb && app.plan) engine.start(app.plan, pb.startAt);
  }, () => toast('오디오를 켤 수 없어요'));
};

$('btn-leave').onclick = () => {
  if (!confirm('방에서 나갈까요?')) return;
  leaveRoom();
  showHome();
};

$('btn-share').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${app.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Brief 방 초대', text: `방 코드 ${app.code}`, url });
    else {
      await navigator.clipboard.writeText(url);
      toast('초대 링크를 복사했어요');
    }
  } catch { /* 취소 */ }
};

$('btn-members').onclick = () => $('dlg-members').showModal();
$('btn-settings').onclick = () => $('dlg-settings').showModal();
$('btn-library').onclick = () => {
  renderLibrary();
  $('dlg-library').showModal();
};
$('btn-add-song').onclick = addSong;

$('btn-play').onclick = () => {
  if (!engine.unlocked) engine.unlock().then(updateAudioGate, () => {});
  if (app.state.playback) conn.send('stop');
  else conn.send('play', {});
};
$('btn-prev').onclick = () => stepSong(-1);
$('btn-next').onclick = () => stepSong(1);

$('opt-auto').onchange = () => conn.send('settings', { autoAdvance: $('opt-auto').checked });
$('opt-gap').onchange = () => conn.send('settings', { gapSeconds: Number($('opt-gap').value) });

$('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'brief', version: 1, setlist: app.state.setlist }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `setlist-${app.code}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('file-import').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = normalizeSetlist(Array.isArray(data) ? data : data.setlist);
    if (!list.length) throw new Error('empty');
    if (confirm(`${list.length}곡으로 셋리스트를 바꿀까요?`)) pushSetlist(list);
  } catch {
    toast('올바른 셋리스트 파일이 아니에요');
  }
};

// ---------- 시작 ----------
function boot() {
  hydrateIcons();
  $('home-name').value = store.get('brief.name', '');
  bindSettings();
  setupScoreInput();
  const params = new URLSearchParams(location.search);
  const urlCode = (params.get('room') || '').toUpperCase();
  const session = store.get('brief.session', null);
  if (urlCode) $('home-code').value = urlCode;

  // 새로고침했거나 초대 링크로 다시 들어온 경우 자동으로 재입장 (소리는 탭 한 번 필요)
  if (session && (!urlCode || urlCode === session.code)) {
    app.code = session.code;
    conn.connect();
  }
  requestAnimationFrame(frame);
}

boot();
