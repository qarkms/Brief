import { Connection } from './net.js';
import { DEFAULT_SETTINGS, Engine } from './engine.js';
import {
  buildPlan, findBarIndex, makeId, normalizeSetlist, normalizeSong, songDuration,
} from './timeline.js';
import {
  formatDuration, loadLibrary, openEditor, removeFromLibrary,
} from './editor.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

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
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- 화면 전환 ----------
function showHome(error = '') {
  $('view-room').classList.add('hidden');
  $('view-home').classList.remove('hidden');
  $('audio-gate').classList.add('hidden');
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
  store.set('brief.session', null);
  history.replaceState(null, '', location.pathname);
}

// ---------- 방 상태 ----------
function onState(state) {
  app.state = state;
  document.body.classList.toggle('host', isHost());
  if (isHost()) store.set('brief.setlist', state.setlist);

  const pb = state.playback;
  if ((pb && pb.playId) !== app.playId) {
    app.playId = pb ? pb.playId : null;
    app.plan = pb ? buildPlan(pb) : null;
    app.playingSong = pb ? pb.startSongIndex : null;
    if (pb && engine.unlocked) engine.start(app.plan, pb.startAt);
    else engine.stop();
  }

  $('member-count').textContent = state.members.length;
  renderMembers();
  renderSetlist();
  renderStructure();
  renderOptions();
  renderTransport();
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
  const btn = $('btn-play');
  btn.textContent = playing ? '■ 정지' : '▶ 시작';
  btn.classList.toggle('stop', playing);
}

function songMeta(song) {
  return `${song.bpm} BPM · ${song.beatsPerBar}박 · ${song.sections.length}파트 · ${formatDuration(songDuration(song))}`;
}

function renderSetlist() {
  const { setlist, selectedSong } = app.state;
  const host = isHost();
  const list = $('setlist');
  list.replaceChildren(...setlist.map((song, i) => {
    const li = el(
      'li',
      { className: i === selectedSong ? 'selected' : '' },
      el('span', { className: 'num', textContent: i + 1 }),
      el(
        'div',
        { className: 'info' },
        el('div', { className: 'title', textContent: song.title }),
        el('div', { className: 'meta', textContent: songMeta(song) }),
      ),
    );
    li.dataset.index = i;
    if (host) {
      const act = (label, title, fn) => el('button', {
        type: 'button',
        textContent: label,
        title,
        onclick: (e) => {
          e.stopPropagation();
          fn();
        },
      });
      li.append(el(
        'div',
        { className: 'acts' },
        act('↑', '위로', () => moveSong(i, -1)),
        act('↓', '아래로', () => moveSong(i, 1)),
        act('✎', '편집', () => editSong(i)),
      ));
      li.onclick = () => conn.send('select', { songIndex: i, sectionIndex: 0 });
    }
    return li;
  }));
  app.lastPlayingSong = null;
}

function structureSongIndex() {
  return app.playingSong ?? app.state.selectedSong;
}

function renderStructure() {
  if (!app.state) return;
  const si = structureSongIndex();
  const songs = app.state.playback ? app.state.playback.songs : app.state.setlist;
  const song = songs[si];
  const box = $('structure');
  if (!song) {
    box.replaceChildren();
    return;
  }
  const selectable = isHost() && !app.state.playback;
  box.replaceChildren(...song.sections.map((sec, k) => {
    const chip = el(
      'button',
      { type: 'button', className: 'chip' },
      el('span', { className: 'n', textContent: sec.name }),
      el('span', {
        className: 'b',
        textContent: `${sec.bars}마디${sec.bpm ? ` · ${sec.bpm}` : ''}${sec.beatsPerBar ? ` · ${sec.beatsPerBar}박` : ''}`,
      }),
    );
    chip.dataset.k = k;
    if (!app.state.playback && k === app.state.selectedSection && si === app.state.selectedSong) {
      chip.classList.add('selected');
    }
    chip.onclick = () => {
      if (selectable) conn.send('select', { songIndex: si, sectionIndex: k });
      else if (isHost()) toast('정지한 뒤 시작할 파트를 고를 수 있어요');
    };
    return chip;
  }));
  app.lastChipKey = null;
}

// ---------- 방장 동작 ----------
function pushSetlist(setlist) {
  conn.send('setlist', { setlist });
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
    const li = el('li', {}, el('span', { className: 'name', textContent: m.name }));
    if (m.isHost) li.append(el('span', { className: 'badge', textContent: '방장' }));
    if (m.id === app.me) li.append(el('span', { className: 'badge me', textContent: '나' }));
    if (host && m.id !== app.me) {
      li.append(el('button', {
        type: 'button',
        className: 'btn small',
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
      className: 'name',
      onclick: () => {
        pushSetlist([...app.state.setlist, { ...song, id: makeId() }]);
        toast(`"${song.title}" 추가됨`);
      },
    }, el('strong', { textContent: song.title }), el('div', { className: 'hint', textContent: songMeta(song) })),
    el('button', {
      type: 'button',
      className: 'btn small danger',
      textContent: '삭제',
      onclick: () => {
        if (!confirm(`보관함에서 "${song.title}" 삭제?`)) return;
        removeFromLibrary(song.id);
        renderLibrary();
      },
    }),
  )));
}

// ---------- 무대 화면 (매 프레임) ----------
let lastBeatKey = null;
let lastDots = null;
let lastBarHtml = null;

function setText(id, text) {
  if (id === 'stage-bar') lastBarHtml = null;
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
}

function renderDots(beats, active) {
  const box = $('beat-dots');
  if (lastDots !== beats) {
    box.replaceChildren(...Array.from({ length: beats }, (_, i) => el('span', { className: i === 0 ? 'dot first' : 'dot' })));
    lastDots = beats;
  }
  [...box.children].forEach((d, i) => d.classList.toggle('on', i === active));
}

function nextSectionInfo(plan, idx) {
  const bar = plan.bars[idx];
  for (let j = idx + 1; j < plan.bars.length; j++) {
    const b = plan.bars[j];
    if (b.songIndex !== bar.songIndex) return { song: b.songIndex, barsUntil: null };
    if (b.sectionIndex !== bar.sectionIndex) return { sectionIndex: b.sectionIndex, barsUntil: j - idx };
  }
  return null;
}

function renderIdle() {
  const { setlist, selectedSong, selectedSection } = app.state;
  const song = setlist[selectedSong];
  setPlayingSong(null);
  setText('stage-song-title', `${selectedSong + 1}. ${song.title}`);
  setText('stage-bpm', `${song.bpm} BPM`);
  setText('stage-status', isHost() ? '시작 버튼을 누르면 모두 함께 시작해요' : '방장의 시작을 기다리는 중');
  setText('stage-section', song.sections[selectedSection].name);
  $('stage-section').classList.remove('countin');
  const bars = song.sections.reduce((n, s) => n + s.bars, 0);
  setText('stage-bar', `${bars}마디 · ${formatDuration(songDuration(song))}`);
  setText('stage-next', selectedSection > 0 ? `${selectedSection + 1}번째 파트부터 시작` : ' ');
  $('stage-next').classList.remove('soon');
  $('stage').classList.remove('briefing');
  $('stage-progress').style.width = '0%';
  renderDots(song.beatsPerBar, -1);
}

function setPlayingSong(si) {
  if (app.playingSong === si) return;
  app.playingSong = si;
  renderStructure();
}

function highlight(si, sectionIndex, nextIndex) {
  const key = `${si}:${sectionIndex}:${nextIndex}`;
  if (app.lastChipKey === key) return;
  app.lastChipKey = key;
  $('structure').querySelectorAll('.chip').forEach((c) => {
    const k = Number(c.dataset.k);
    c.classList.toggle('current', k === sectionIndex);
    c.classList.toggle('next', k === nextIndex);
  });
  const playingSong = app.state.playback ? si : null;
  if (app.lastPlayingSong !== playingSong) {
    app.lastPlayingSong = playingSong;
    $('setlist').querySelectorAll('li').forEach((li) => {
      li.classList.toggle('playing', Number(li.dataset.index) === playingSong);
    });
  }
}

function renderPlaying() {
  const pb = app.state.playback;
  const plan = app.plan;
  const t = (conn.serverNow() - pb.startAt) / 1000;
  const stage = $('stage');

  if (t < 0) {
    const song = pb.songs[pb.startSongIndex];
    setPlayingSong(pb.startSongIndex);
    setText('stage-song-title', `${pb.startSongIndex + 1}. ${song.title}`);
    setText('stage-status', `시작까지 ${(-t).toFixed(1)}초`);
    setText('stage-section', '준비');
    setText('stage-bar', ' ');
    setText('stage-next', ' ');
    renderDots(song.beatsPerBar, -1);
    return;
  }

  const idx = findBarIndex(plan, t);
  if (idx === -1) {
    // 곡 사이 간격 또는 종료
    const upcoming = plan.songs.find((s) => s.start > t);
    stage.classList.remove('briefing');
    $('stage-section').classList.remove('countin');
    if (upcoming) {
      const song = pb.songs[upcoming.songIndex];
      setPlayingSong(upcoming.songIndex);
      highlight(upcoming.songIndex, -1, 0);
      setText('stage-song-title', `${upcoming.songIndex + 1}. ${song.title}`);
      setText('stage-bpm', `${song.bpm} BPM`);
      setText('stage-status', `다음 곡까지 ${Math.ceil(upcoming.start - t)}초`);
      setText('stage-section', song.title);
      setText('stage-bar', ' ');
      setText('stage-next', '다음 곡');
      renderDots(song.beatsPerBar, -1);
    } else {
      setText('stage-status', '끝');
      setText('stage-section', '끝');
      setText('stage-next', ' ');
      renderDots(lastDots || 4, -1);
    }
    return;
  }

  const bar = plan.bars[idx];
  const song = pb.songs[bar.songIndex];
  const beat = Math.min(bar.beats - 1, Math.floor((t - bar.t) / bar.beatDur));
  setPlayingSong(bar.songIndex);
  setText('stage-song-title', `${bar.songIndex + 1}. ${song.title}`);
  setText('stage-bpm', `${Math.round(bar.bpm * 10) / 10} BPM`);
  setText('stage-status', '재생 중');

  const countIn = bar.sectionIndex < 0;
  setText('stage-section', countIn ? '카운트' : song.sections[bar.sectionIndex].name);
  $('stage-section').classList.toggle('countin', countIn);
  const barHtml = `마디 <b>${bar.bar}</b> / ${bar.barsInSection}`;
  if (lastBarHtml !== barHtml) {
    lastBarHtml = barHtml;
    $('stage-bar').innerHTML = barHtml;
  }
  renderDots(bar.beats, beat);

  const next = nextSectionInfo(plan, idx);
  const nextEl = $('stage-next');
  let soon = false;
  let nextIdx = -1;
  if (!next) {
    setText('stage-next', bar.bar === bar.barsInSection ? '마지막 마디' : '곡의 마지막 파트');
  } else if (next.barsUntil === null) {
    const s = pb.songs[next.song];
    setText('stage-next', `다음 곡: ${s.title}`);
  } else {
    const name = song.sections[next.sectionIndex].name;
    nextIdx = next.sectionIndex;
    soon = next.barsUntil === 1;
    setText('stage-next', soon ? `▶ ${name}` : `다음: ${name} · ${next.barsUntil}마디 후`);
  }
  nextEl.classList.toggle('soon', soon);
  stage.classList.toggle('briefing', soon);
  highlight(bar.songIndex, bar.sectionIndex, nextIdx);

  const meta = plan.songs.find((s) => s.songIndex === bar.songIndex);
  const pct = meta ? ((t - meta.start) / (meta.end - meta.start)) * 100 : 0;
  $('stage-progress').style.width = `${Math.max(0, Math.min(100, pct))}%`;

  const beatKey = `${idx}:${beat}`;
  if (beatKey !== lastBeatKey) {
    lastBeatKey = beatKey;
    if (beat === 0) {
      stage.classList.add('flash');
      setTimeout(() => stage.classList.remove('flash'), 90);
    }
  }
}

function frame() {
  if (app.state && !$('view-room').classList.contains('hidden')) {
    if (app.state.playback && app.plan) renderPlaying();
    else {
      renderIdle();
      highlight(null, -1, -1);
    }
  }
  requestAnimationFrame(frame);
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
  $('home-name').value = store.get('brief.name', '');
  bindSettings();
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
