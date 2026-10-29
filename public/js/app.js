import { Connection } from './net.js';
import { DEFAULT_SETTINGS, Engine } from './engine.js';
import {
  buildPlan, findBarIndex, makeId, normalizeSetlist, normalizeSong, sectionMeter, songDuration,
} from './timeline.js';
import {
  bindStepper, formatDuration, loadLibrary, openEditor, removeFromLibrary, setChoice, subShort,
} from './editor.js';
import {
  buildStrip, el, hydrateIcons, icon, sectionTone, songSegments, updateFormStrip,
} from './ui.js';
import {
  ensureSheets, preload, sheetUrl, uploadSheetFile,
} from './sheets.js';
import { VOICES } from './voice.js';

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

// 이 기기를 구분하는 키 (부방장 권한이 재접속해도 유지되도록)
const clientKey = (() => {
  let k = store.get('brief.key', null);
  if (typeof k !== 'string' || !/^[a-f0-9]{32}$/.test(k)) {
    k = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
    store.set('brief.key', k);
  }
  return k;
})();

const settings = { ...DEFAULT_SETTINGS, ...store.get('brief.settings', {}) };
if (!VOICES[settings.voiceSet] && settings.voiceSet !== 'device') settings.voiceSet = 'female';
const conn = new Connection();
const engine = new Engine(conn, settings);

const app = {
  me: null,
  code: null, // 현재(또는 재접속할) 방 코드
  state: null,
  plan: null,
  playId: null,
  rev: null,
  pendingOnOpen: null,
};

const me = () => app.state?.members.find((m) => m.id === app.me);
const isOwner = () => !!app.state && app.state.hostId === app.me;
const canControl = () => isOwner() || me()?.role === 'cohost';
const hostTokenFor = (code) => store.get(`brief.host.${code}`, null);
const auth = () => ({ room: app.code, hostToken: hostTokenFor(app.code), key: clientKey });

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
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('home-error').textContent = error;
  document.body.classList.remove('ctl', 'owner', 'playing');
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
    conn.send('join', {
      code: app.code, name: myName(), hostToken: hostTokenFor(app.code), key: clientKey,
    });
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
  toast(detail.hostToken ? '이제 내가 방장이에요' : '방장을 넘겼어요. 이제 부방장이에요');
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
  app.rev = null;
  store.set('brief.session', null);
  history.replaceState(null, '', location.pathname);
}

// ---------- 방 상태 ----------
let ensureTimer;
let wasControl = null;
function onState(state) {
  app.state = state;
  const ctl = canControl();
  document.body.classList.toggle('ctl', ctl);
  document.body.classList.toggle('owner', isOwner());
  document.body.classList.toggle('playing', !!state.playback);
  $('play-label').textContent = state.playback ? '정지' : '브리핑 시작';
  if (wasControl !== null && ctl !== wasControl && !isOwner()) toast(ctl ? '부방장이 되었어요' : '부방장 권한이 해제됐어요');
  wasControl = ctl;

  const pb = state.playback;
  if ((pb && pb.playId) !== app.playId) {
    app.playId = pb ? pb.playId : null;
    app.rev = pb ? pb.rev : null;
    app.plan = pb ? buildPlan(pb) : null;
    if (pb && engine.unlocked) engine.start(app.plan, pb.startAt);
    else engine.stop();
  } else if (pb && pb.rev !== app.rev) {
    // 실시간 송폼 변경: 같은 재생을 이어가며 앞으로의 파트만 다시 예약
    app.rev = pb.rev;
    app.plan = buildPlan(pb);
    engine.update(app.plan);
  }

  if (ctl) {
    store.set('brief.setlist', state.setlist);
    // 서버가 재시작돼 악보가 사라졌으면 이 기기에 보관된 파일로 복구
    clearTimeout(ensureTimer);
    ensureTimer = setTimeout(() => {
      ensureSheets(state.setlist, auth()).then((n) => {
        if (!n) return;
        toast(`악보 ${n}장을 다시 올렸어요`);
        score.key = null;
      });
    }, 300);
  }

  $('member-count').textContent = state.members.length;
  renderMembers();
  if ($('dlg-setlist').open) renderSetlist();
  renderOptions();
  renderPills();
  view.songKey = null;
  view.liveKey = null;
  score.key = null;
}

function renderOptions() {
  const ctl = canControl();
  $('opt-auto').checked = app.state.autoAdvance;
  $('opt-auto').disabled = !ctl;
  $('opt-gap-v').textContent = app.state.gapSeconds;
}

const countLabel = { none: '끔', beats: '1 2 3 4', and: '1 n 2 n' };
function renderPills() {
  const song = displaySong();
  if (song) {
    $('pill-count-v').textContent = song.countInBars ? `${song.countInBars}마디 · ${countLabel[song.countVoice]}` : '없음';
  }
  $('pill-volume-v').textContent = `클릭 ${settings.click ? Math.round(settings.clickVolume * 100) : '끔'} · 목소리 ${settings.voice ? Math.round(settings.voiceVolume * 100) : '끔'}`;
  $('pill-voice-v').textContent = settings.voiceSet === 'device' ? '기기 음성' : VOICES[settings.voiceSet].split(' ')[0];
}

function songMeta(song) {
  const bars = song.sections.reduce((n, s) => n + s.bars, 0);
  return `${song.sections.length}파트 ${bars}마디 · ${song.bpm} BPM · ${song.beatsPerBar}/${song.beatUnit}`;
}

function displaySongs() {
  return app.state.playback ? app.state.playback.songs : app.state.setlist;
}

function displaySong() {
  if (!app.state) return null;
  return displaySongs()[view.songIndex ?? app.state.selectedSong];
}

// ---------- 곡·셋리스트 시트 ----------
function renderSetlist() {
  const { setlist, selectedSong } = app.state;
  const ctl = canControl();
  const playingSong = app.state.playback ? view.songIndex : null;
  $('setlist').replaceChildren(...setlist.map((song, i) => {
    const title = el('div', { className: 'title' }, el('span', { className: 'num', textContent: `${i + 1}.` }), el('span', { textContent: song.title }));
    if (song.sheets.length) title.append(icon('score'));
    const strip = el('div', { className: 'form-strip mini' });
    buildStrip(strip, songSegments(song), { labels: false });
    const card = el(
      'button',
      { type: 'button', className: `set-card${i === selectedSong ? ' selected' : ''}${i === playingSong ? ' playing' : ''}` },
      title,
      el('div', { className: 'meta', textContent: `${songMeta(song)} · ${formatDuration(songDuration(song))}` }),
      strip,
    );
    card.onclick = () => {
      if (ctl) conn.send('select', { songIndex: i, sectionIndex: 0 });
    };
    const li = el('li', {}, card);
    if (ctl) {
      const act = (name, label, fn) => el('button', {
        type: 'button', className: 'icon-btn', title: label, ariaLabel: label, onclick: fn,
      }, icon(name));
      li.append(el(
        'div',
        { className: 'set-acts' },
        act('up', '위로', () => moveSong(i, -1)),
        act('edit', '편집', () => editSong(i)),
        act('copy', '복제', () => {
          const list = [...setlist];
          list.splice(i + 1, 0, { ...structuredClone(song), id: makeId(), title: `${song.title} (복사본)` });
          pushSetlist(list);
        }),
        act('close', '삭제', () => {
          if (setlist.length <= 1) return toast('마지막 곡은 지울 수 없어요');
          if (confirm(`"${song.title}"을(를) 셋리스트에서 삭제할까요?`)) pushSetlist(setlist.filter((_, k) => k !== i));
          return null;
        }),
      ));
    }
    return li;
  }));
}

function pushSetlist(setlist) {
  conn.send('setlist', { setlist });
}

function uploader(file, onProgress) {
  return uploadSheetFile(file, { ...auth(), onProgress });
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
      if (app.state.playback) toast('저장했어요. 지금 재생에는 다음 시작부터 반영돼요');
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
    beatUnit: last ? last.beatUnit : 4,
    countInBars: 1,
    sections: [
      { name: 'Intro', bars: 4 },
      { name: 'Verse 1', bars: 8 },
      { name: 'Chorus', bars: 8 },
      { name: 'Verse 2', bars: 8 },
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
  return app.state.playback ? (view.songIndex ?? app.state.playback.startSongIndex) : app.state.selectedSong;
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
  const owner = isOwner();
  $('member-list').replaceChildren(...app.state.members.map((m) => {
    const li = el(
      'li',
      {},
      el('span', { className: 'avatar', textContent: [...m.name][0] || '?' }),
      el('span', { className: 'name', textContent: m.name }),
    );
    if (m.role === 'host') li.append(el('span', { className: 'badge' }, icon('crown'), '방장'));
    if (m.role === 'cohost') li.append(el('span', { className: 'badge co' }, icon('userCheck'), '부방장'));
    if (m.id === app.me) li.append(el('span', { className: 'badge me', textContent: '나' }));
    if (owner && m.id !== app.me) {
      const check = el('input', { type: 'checkbox', checked: m.role === 'cohost' });
      check.onchange = () => conn.send('cohost', { to: m.id, on: check.checked });
      li.append(el(
        'div',
        { className: 'member-acts' },
        el('label', { className: 'toggle' }, el('span', { textContent: '부방장으로 임명' }), check, el('span', { className: 'toggle-ui' })),
        el('button', {
          type: 'button',
          className: 'btn ghost sm',
          textContent: '방장 넘기기',
          onclick: () => {
            if (confirm(`${m.name}님에게 방장을 넘길까요? 나는 부방장이 돼요.`)) conn.send('transfer', { to: m.id });
          },
        }),
      ));
    }
    return li;
  }));
}

// ---------- 보관함 ----------
function renderLibrary() {
  const songs = loadLibrary();
  const list = $('library-list');
  if (!songs.length) {
    list.replaceChildren(el('li', { className: 'hint', textContent: '저장된 곡이 없어요. 곡 편집에서 "보관함에 저장"을 누르세요.' }));
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
      className: 'btn ghost sm danger',
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
/** 지금 이 순간 무엇이 연주되고 있는지 */
function position() {
  const { state, plan } = app;
  const pb = state.playback;
  if (!pb || !plan || !plan.items.length) {
    const si = state.selectedSong;
    return {
      mode: 'idle', songIndex: si, song: state.setlist[si], sectionIndex: state.selectedSection, time: 0,
    };
  }
  const t = (conn.serverNow() - pb.startAt) / 1000;
  const firstSong = plan.items[0].songIndex;
  if (t < 0) return { mode: 'pre', songIndex: firstSong, song: pb.songs[firstSong], wait: -t, time: t };
  const idx = findBarIndex(plan, t);
  if (idx === -1) {
    const upcoming = plan.songs.find((s) => s.start > t);
    if (!upcoming) {
      const lastSong = plan.songs[plan.songs.length - 1].songIndex;
      return {
        mode: 'end', songIndex: lastSong, song: pb.songs[lastSong], time: t,
      };
    }
    return {
      mode: 'gap', songIndex: upcoming.songIndex, song: pb.songs[upcoming.songIndex], wait: upcoming.start - t, time: t,
    };
  }
  const bar = plan.bars[idx];
  const into = (t - bar.t) / bar.dur;
  const itemIdx = bar.seq >= 0 ? plan.items.findIndex((it) => it.seq === bar.seq) : -1;
  let next = null;
  if (bar.seq < 0) {
    // 카운트인: 다음은 이 곡의 첫 파트
    const first = plan.items.find((it) => it.t >= bar.t);
    if (first) next = { item: first, barsUntil: bar.barsInSection - bar.bar + 1 };
  } else if (itemIdx >= 0 && plan.items[itemIdx + 1]) {
    next = { item: plan.items[itemIdx + 1], barsUntil: bar.barsInSection - bar.bar + 1 };
  }
  return {
    mode: 'play',
    idx,
    bar,
    time: t,
    songIndex: bar.songIndex,
    song: pb.songs[bar.songIndex],
    sectionIndex: bar.sectionIndex,
    seq: bar.seq,
    beat: Math.min(bar.beats - 1, Math.floor((t - bar.t) / bar.beatDur)),
    sectionProgress: (bar.bar - 1 + into) / bar.barsInSection,
    next,
  };
}

const sectionName = (pos) => (pos.sectionIndex < 0 ? '카운트' : pos.song.sections[pos.sectionIndex].name);
const sectionToneOf = (pos) => (pos.sectionIndex < 0 ? 'count' : sectionTone(sectionName(pos)));
const nextName = (pos) => {
  const { item } = pos.next;
  return app.state.playback.songs[item.songIndex].sections[item.sectionIndex].name;
};

/** 화면에 보여줄 송폼 조각: 재생 중이면 실제 진행 순서(실시간 변경 포함), 아니면 곡의 기본 송폼 */
function segmentsFor(songIndex) {
  const pb = app.state.playback;
  if (pb && app.plan) {
    const song = pb.songs[songIndex];
    return app.plan.items.filter((it) => it.songIndex === songIndex).map((it) => {
      const sec = song.sections[it.sectionIndex];
      return {
        key: it.seq, name: sec.name, bars: sec.bars, weight: it.end - it.t, silent: !sec.announce, sectionIndex: it.sectionIndex,
      };
    });
  }
  const song = app.state.setlist[songIndex];
  return songSegments(song).map((sg, k) => ({ ...sg, silent: !song.sections[k].announce, sectionIndex: k }));
}

// ---------- 화면 (매 프레임) ----------
const view = {
  songIndex: null, songKey: null, liveKey: null, chipKey: null,
};
let lastBeatKey = null;
let lastBarHtml = null;

function setText(id, text) {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
}

function renderBeats(box, beats, active, group = 0) {
  if (box.childElementCount !== beats || box.dataset.group !== String(group)) {
    box.dataset.group = group;
    box.replaceChildren(...Array.from({ length: beats }, (_, i) => el('span', {
      className: `beat${i === 0 ? ' first' : ''}${group && i && i % group === 0 ? ' group' : ''}`,
    })));
  }
  for (let i = 0; i < beats; i++) box.children[i].classList.toggle('on', i === active);
}

function setBarHtml(html) {
  if (lastBarHtml === html) return;
  lastBarHtml = html;
  $('stage-bar').innerHTML = html;
}

/** 곡이 바뀌거나 송폼이 바뀌면 카드 머리·칩·스트립을 다시 만든다 */
function renderSongCard(pos) {
  const pb = app.state.playback;
  const key = `${pos.songIndex}:${app.playId}:${app.rev}:${app.state.selectedSection}:${JSON.stringify(pos.song.sections).length}:${pos.song.title}`;
  if (view.songKey === key) return;
  view.songKey = key;
  view.songIndex = pos.songIndex;
  view.chipKey = null;
  const { song } = pos;
  setText('song-title', `${pos.songIndex + 1}. ${song.title}`);
  setText('song-meta', `${songMeta(song)} · ${subShort(song.beatUnit, song.subdivision)}`);
  const segs = segmentsFor(pos.songIndex);
  buildStrip($('stage-form'), segs, { labels: false });
  const ctl = canControl();
  $('structure').replaceChildren(...segs.map((sg) => {
    const chip = el(
      'button',
      { type: 'button', className: `chip${sg.silent ? ' silent' : ''}` },
      el('span', { className: 'n', textContent: sg.name }),
      el('span', { className: 'b', textContent: sg.bars }),
    );
    chip.dataset.key = sg.key;
    chip.dataset.tone = sectionTone(sg.name);
    if (!pb && sg.key === app.state.selectedSection && sg.key > 0) chip.classList.add('selected');
    chip.onclick = () => {
      if (!ctl) return;
      if (!pb) conn.send('select', { songIndex: pos.songIndex, sectionIndex: sg.sectionIndex });
      else toast('재생 중에는 아래 "실시간 송폼"에서 바꿀 수 있어요');
    };
    return chip;
  }));
  $('structure-hint').textContent = pb ? '아래 실시간 송폼에서 파트를 추가·취소할 수 있어요' : '파트를 누르면 거기부터 시작해요';
  renderPills();
  if ($('dlg-setlist').open) renderSetlist();
}

function highlightChips(cur, next) {
  const key = `${cur}:${next}`;
  if (view.chipKey === key) return;
  view.chipKey = key;
  let currentChip = null;
  $('structure').querySelectorAll('.chip').forEach((c) => {
    const isCur = c.dataset.key === String(cur);
    c.classList.toggle('current', isCur);
    c.classList.toggle('next', c.dataset.key === String(next));
    if (isCur) currentChip = c;
  });
  if (currentChip) {
    const row = $('structure');
    row.scrollTo({ left: Math.max(0, currentChip.offsetLeft - row.clientWidth / 3), behavior: 'smooth' });
  }
}

function renderStage(pos) {
  renderSongCard(pos);
  const stage = $('stage');
  const { song } = pos;
  let soon = false;
  let nextKey = null;
  if (pos.mode === 'play') {
    const { bar } = pos;
    stage.dataset.tone = sectionToneOf(pos);
    setText('stage-status', `${Math.round(bar.bpm * 10) / 10} BPM · ${bar.beats}/${bar.unit}`);
    setText('stage-section', sectionName(pos));
    setBarHtml(`마디 <b>${bar.bar}</b> / ${bar.barsInSection}`);
    renderBeats($('beat-dots'), bar.beats, pos.beat, groupOf(bar));

    const { next } = pos;
    if (!next) {
      setText('stage-next', bar.bar === bar.barsInSection ? '마지막 마디' : '마지막 파트');
    } else if (next.item.songIndex !== pos.songIndex) {
      setText('stage-next', `다음 곡 · ${app.state.playback.songs[next.item.songIndex].title}`);
    } else {
      soon = next.barsUntil === 1;
      nextKey = next.item.seq;
      setText('stage-next', soon ? `▸ ${nextName(pos)}` : `다음 ${nextName(pos)} · ${next.barsUntil}마디 후`);
    }
    updateFormStrip($('stage-form'), pos.seq, pos.sectionProgress, soon ? nextKey : null);
    highlightChips(pos.seq, nextKey);

    const beatKey = `${pos.idx}:${pos.beat}`;
    if (beatKey !== lastBeatKey) {
      lastBeatKey = beatKey;
      if (pos.beat === 0) {
        stage.classList.add('flash');
        setTimeout(() => stage.classList.remove('flash'), 110);
      }
    }
  } else {
    const m = sectionMeter(song, song.sections[pos.mode === 'idle' ? pos.sectionIndex : 0]);
    renderBeats($('beat-dots'), m.beats, -1, groupOf(m));
    updateFormStrip($('stage-form'), null, 0, null);
    highlightChips(null, null);
    if (pos.mode === 'idle') {
      const sec = song.sections[pos.sectionIndex];
      stage.dataset.tone = sectionTone(sec.name);
      setText('stage-status', canControl() ? '시작을 누르면 모두 함께 시작해요' : '방장의 시작을 기다리는 중');
      setText('stage-section', sec.name);
      setBarHtml(`${pos.sectionIndex > 0 ? `${pos.sectionIndex + 1}번째 파트부터 · ` : ''}${formatDuration(songDuration(song))}`);
      setText('stage-next', ' ');
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
}

const groupOf = (m) => (m.unit >= 8 && m.beats > 3 && m.beats % 3 === 0 ? 3 : 0);

// ---------- 실시간 송폼 (방장·부방장) ----------
function liveSend(op, extra = {}, msg = '') {
  conn.send('live', { op, rev: app.rev, ...extra });
  if (msg) toast(msg);
}

function renderLive(pos, container) {
  const pb = app.state.playback;
  const plan = app.plan;
  // 지금 곡의 파트 중 지금부터 남은 것
  const songIndex = pos.songIndex;
  const song = pb.songs[songIndex];
  const time = pos.time ?? 0;
  const items = plan.items.filter((it) => it.songIndex === songIndex && it.end > time);
  const curSeq = pos.mode === 'play' ? pos.seq : -1;
  const nextItem = items.find((it) => it.seq !== curSeq);

  const queue = el('div', { className: 'live-queue' });
  items.slice(0, 7).forEach((it) => {
    const sec = song.sections[it.sectionIndex];
    const isNow = it.seq === curSeq;
    const isNext = nextItem && it.seq === nextItem.seq;
    const row = el(
      'div',
      { className: `q-item${isNow ? ' now' : ''}${isNext ? ' next' : ''}` },
      el('span', { className: 'q-name', textContent: sec.name }),
      el('span', { className: 'q-bars', textContent: `${sec.bars}마디` }),
    );
    row.dataset.tone = sectionTone(sec.name);
    if (isNow) row.append(el('span', { className: 'q-tag', textContent: '지금' }));
    else if (isNext) row.append(el('span', { className: 'q-tag', textContent: '다음' }));
    if (!isNow && it.t > time + 0.3) {
      row.append(el('button', {
        type: 'button',
        className: 'q-x',
        title: '이 파트 취소',
        onclick: () => liveSend('remove', { seq: it.seq }, `${sec.name} 취소`),
      }, icon('close')));
    }
    queue.append(row);
  });
  if (items.length > 7) queue.append(el('div', { className: 'q-more', textContent: `+ ${items.length - 7}개 더` }));
  if (!items.length) queue.append(el('div', { className: 'q-more', textContent: '이 곡의 남은 파트가 없어요' }));

  const action = (name, label, fn, disabled) => el('button', {
    type: 'button', className: 'btn soft', onclick: fn, disabled,
  }, icon(name), label);
  const curName = curSeq >= 0 ? song.sections[pos.sectionIndex].name : null;
  const nextName2 = nextItem ? song.sections[nextItem.sectionIndex].name : null;

  // 이 곡의 파트 종류(이름 기준 첫 번째) → "다음에 넣기"
  const seen = new Set();
  const kinds = [];
  song.sections.forEach((sec, k) => {
    if (seen.has(sec.name)) return;
    seen.add(sec.name);
    kinds.push({ sec, k });
  });
  const insert = el('div', { className: 'live-insert' }, ...kinds.map(({ sec, k }) => {
    const c = el('button', { type: 'button', className: 'chip' }, el('span', { className: 'n', textContent: `+ ${sec.name}` }), el('span', { className: 'b', textContent: sec.bars }));
    c.dataset.tone = sectionTone(sec.name);
    c.onclick = () => liveSend('insert', { sectionIndex: k }, `다음에 ${sec.name} 추가`);
    return c;
  }));

  container.replaceChildren(
    el('div', { className: 'live-head' }, el('h2', { textContent: '실시간 송폼' }), el('span', { className: 'live-badge', textContent: 'LIVE' })),
    el('p', { className: 'hint', textContent: `${song.title} · 바꾸면 모든 기기에 바로 반영돼요` }),
    queue,
    el(
      'div',
      { className: 'live-actions' },
      action('repeat', curName ? `${curName}\n한 번 더` : '지금 파트\n한 번 더', () => liveSend('repeat', {}, `${curName} 한 번 더`), !curName),
      action('skip', nextName2 ? `${nextName2}\n건너뛰기` : '다음 파트\n건너뛰기', () => liveSend('skipNext', {}, `${nextName2} 건너뜀`), !nextName2),
      action('flag', '이 파트 후\n곡 끝내기', () => liveSend('endSong', {}, '이 파트가 끝나면 곡을 마쳐요'), !nextItem),
    ),
    el('div', { className: 'live-insert-title', textContent: '다음 파트로 넣기' }),
    insert,
  );
}

function renderLivePanels(pos) {
  const show = !!app.state.playback && canControl() && pos.mode !== 'end';
  $('live-card').classList.toggle('hidden', !show);
  const sheetOpen = $('dlg-live').open;
  if (!show) {
    if (sheetOpen) $('dlg-live').close();
    return;
  }
  // 파트가 바뀌거나 송폼이 바뀔 때만 다시 그린다
  const editableCut = app.plan.items.find((it) => it.t > (pos.time ?? 0) + 0.3);
  const key = `${app.playId}:${app.rev}:${pos.songIndex}:${pos.seq ?? -1}:${editableCut ? editableCut.seq : -1}`;
  if (view.liveKey === key) return;
  view.liveKey = key;
  renderLive(pos, $('live-panel'));
  if (sheetOpen) renderLive(pos, $('live-panel-sheet'));
}

// ---------- 악보 보기 ----------
const score = {
  open: false, key: null, songIndex: null, page: 0,
};

function openScore() {
  score.open = true;
  score.key = null;
  $('view-score').classList.remove('hidden');
  $('tab-score').classList.add('active');
  $('tab-brief').classList.remove('active');
}

function closeScore() {
  score.open = false;
  $('view-score').classList.add('hidden');
  $('tab-score').classList.remove('active');
  $('tab-brief').classList.add('active');
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
  const key = `${pos.songIndex}:${song.id}:${song.sheets.map((p) => p.id).join(',')}:${app.rev}`;
  if (score.key !== key) {
    // 곡이 바뀌면(자동 다음 곡 포함) 그 곡의 악보 첫 페이지로
    const songChanged = score.songIndex !== pos.songIndex;
    if (songChanged) score.page = 0;
    score.key = key;
    score.songIndex = pos.songIndex;
    setText('score-title', `${pos.songIndex + 1}. ${song.title}`);
    buildStrip($('score-form'), segmentsFor(pos.songIndex));
    renderScorePages(song);
    const nextSong = displaySongs()[pos.songIndex + 1];
    if (nextSong) preload(nextSong.sheets.slice(0, 2));
  }

  const bar = $('view-score').querySelector('.score-bar');
  let brief = '';
  if (pos.mode === 'play') {
    bar.dataset.tone = sectionToneOf(pos);
    setText('score-pos', `${sectionName(pos)} ${pos.bar.bar}/${pos.bar.barsInSection}`);
    renderBeats($('score-beats'), pos.bar.beats, pos.beat, groupOf(pos.bar));
    const { next } = pos;
    const soon = next && next.barsUntil === 1 && next.item.songIndex === pos.songIndex;
    if (soon) brief = `▸ ${nextName(pos)}`;
    updateFormStrip($('score-form'), pos.seq, pos.sectionProgress, soon ? next.item.seq : null);
  } else {
    bar.dataset.tone = 'count';
    let label = '대기';
    if (pos.mode === 'pre') label = `시작 ${pos.wait.toFixed(1)}초 전`;
    else if (pos.mode === 'gap') label = `다음 곡 ${Math.ceil(pos.wait)}초 전`;
    else if (pos.mode === 'end') label = '끝';
    setText('score-pos', label);
    renderBeats($('score-beats'), song.beatsPerBar, -1);
    updateFormStrip($('score-form'), null, 0, null);
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
  $('tab-score').onclick = openScore;
  $('tab-brief').onclick = closeScore;
  $('btn-score-close').onclick = closeScore;
  $('score-live').onclick = () => {
    view.liveKey = null;
    $('dlg-live').showModal();
  };
  $('score-play').onclick = togglePlay;
  // 블루투스 페이지 넘김 페달은 보통 화살표/PageDown 키를 보낸다
  document.addEventListener('keydown', (e) => {
    if (!score.open || document.querySelector('dialog[open]')) return;
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
    renderStage(pos);
    renderLivePanels(pos);
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
  renderPills();
}

function populateVoices() {
  const select = $('set-voice-uri');
  const voices = engine.voices();
  select.replaceChildren(
    el('option', { value: '', textContent: '자동' }),
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
  bind('set-sub-vol', 'subVolume');
  bind('set-voice', 'voice', { type: 'checked' });
  bind('set-voice-uri', 'voiceURI', { parse: String });
  bind('set-voice-vol', 'voiceVolume');
  bind('set-latency', 'latencyMs', { out: 'set-latency-out' });
  bind('set-lead', 'speechLeadMs', { out: 'set-lead-out' });
  bind('set-wake', 'wakeLock', { type: 'checked' });
  $('set-wake').addEventListener('change', () => (settings.wakeLock ? requestWakeLock() : releaseWakeLock()));

  const voiceSet = $('set-voice-set');
  const showVoiceSet = () => {
    setChoice(voiceSet, settings.voiceSet);
    document.body.classList.toggle('device-voice', settings.voiceSet === 'device');
  };
  showVoiceSet();
  voiceSet.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.voiceSet = b.dataset.v;
    showVoiceSet();
    saveSettings();
    engine.loadVoice();
  });
  const showAuto = () => { $('speech-auto').textContent = settings.speechAutoMs; };
  showAuto();
  engine.onSettingsLearned = () => {
    showAuto();
    store.set('brief.settings', settings);
  };

  populateVoices();
  if (window.speechSynthesis) window.speechSynthesis.addEventListener?.('voiceschanged', populateVoices);
  $('btn-test-voice').onclick = () => {
    engine.unlock();
    engine.loadVoice();
    const say = () => engine.preview('Chorus 2');
    if (settings.voiceSet === 'device') say();
    else engine.voice.loading?.then(say);
  };
}

// ---------- 이벤트 바인딩 ----------
function enterWithAudio(type, data) {
  const name = $('home-name').value.trim();
  store.set('brief.name', name);
  engine.unlock().then(updateAudioGate, () => {});
  sendWhenOpen(type, { ...data, name: name || '멤버', key: clientKey });
}

function togglePlay() {
  if (!engine.unlocked) engine.unlock().then(updateAudioGate, () => {});
  if (app.state.playback) conn.send('stop');
  else conn.send('play', {});
}

function bindRoom() {
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
  $('pill-volume').onclick = () => $('dlg-settings').showModal();
  $('pill-voice').onclick = () => $('dlg-settings').showModal();
  $('pill-count').onclick = () => { if (canControl()) editSong(currentSongIndex()); };
  $('btn-setlist').onclick = () => {
    renderSetlist();
    $('dlg-setlist').showModal();
  };
  $('btn-edit-song').onclick = () => editSong(currentSongIndex());
  $('btn-library').onclick = () => {
    renderLibrary();
    $('dlg-library').showModal();
  };
  $('btn-add-song').onclick = addSong;

  $('btn-play').onclick = togglePlay;
  $('btn-prev').onclick = () => stepSong(-1);
  $('btn-next').onclick = () => stepSong(1);

  $('opt-auto').onchange = () => conn.send('settings', { autoAdvance: $('opt-auto').checked });
  bindStepper(document.querySelector('[data-stepper="gap"]'), (d) => {
    if (!canControl()) return;
    const v = Math.min(120, Math.max(0, app.state.gapSeconds + d));
    $('opt-gap-v').textContent = v;
    app.state.gapSeconds = v;
    clearTimeout(bindRoom.gapTimer);
    bindRoom.gapTimer = setTimeout(() => conn.send('settings', { gapSeconds: v }), 250);
  });

  $('btn-export').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'brief', version: 2, setlist: app.state.setlist }, null, 2)], { type: 'application/json' });
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

  // 시트: 닫기 버튼, 바깥(어두운 곳) 누르면 닫기
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  });
  $('dlg-live').addEventListener('close', () => { view.liveKey = null; });
  const liveObserver = new MutationObserver(() => {
    if ($('dlg-live').open) view.liveKey = null;
  });
  liveObserver.observe($('dlg-live'), { attributes: true, attributeFilter: ['open'] });
}

// ---------- 시작 ----------
function boot() {
  hydrateIcons();
  $('home-name').value = store.get('brief.name', '');
  bindSettings();
  bindRoom();
  setupScoreInput();
  renderPills();
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
