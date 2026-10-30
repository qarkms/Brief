// 공용 UI 도우미: 아이콘, 파트별 색상, 송폼 스트립
import { sectionMeter } from './timeline.js';

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const ICONS = {
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18 19 8 12l10-7z" fill="currentColor" stroke="none"/><path d="M5 5v14"/>',
  next: '<path d="m6 5 10 7-10 7z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  score: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><circle cx="10" cy="16.5" r="2"/><path d="M12 16.5V11l3 1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  speaker: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  crown: '<path d="m2 6 4 11h12l4-11-6 5-4-7-4 7z"/><path d="M6 21h12"/>',
  list: '<path d="M3 6h11M3 12h11M3 18h7"/><circle cx="18" cy="17" r="2.5"/><path d="M20.5 17V6l-3 1"/>',
  minus: '<path d="M5 12h14"/>',
  grip: '<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>',
  playOutline: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  skip: '<path d="m5 4 10 8-10 8z"/><path d="M19 5v14"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 8 2a6 6 0 0 0 3.6-1.2.5.5 0 0 1 .4.5V15a1 1 0 0 1-.4.8A6 6 0 0 1 16 17c-3 0-5-2-8-2a6 6 0 0 0-4 1.5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  note: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
  wand: '<path d="m15 4 5 5M3 21l9-9M13.5 2.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 13l.7 1.3L21 15l-1.3.7L19 17l-.7-1.3L17 15l1.3-.7z"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  share: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  tap: '<path d="M9 11V5a2 2 0 0 1 4 0v5"/><path d="M13 10V8a2 2 0 0 1 4 0v4"/><path d="M17 11a2 2 0 0 1 4 0v3a8 8 0 0 1-8 8h-1a8 8 0 0 1-6.5-3.3L3 15a2 2 0 0 1 3-2.6L9 15"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  door: '<path d="M14 3H6a1 1 0 0 0-1 1v17h14V8"/><path d="M14 3v5h5M3 21h18"/><circle cx="11" cy="13" r="1" fill="currentColor"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `i ${cls}`.trim();
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

/** HTML의 <span data-icon="..."> 자리에 아이콘을 채운다. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    node.replaceWith(icon(node.dataset.icon, node.className));
  });
}

/** 파트 이름 → 색상 그룹 */
export function sectionTone(name) {
  const raw = String(name).trim().toLowerCase();
  if (/^\d+\s*\/\s*\d+$/.test(raw)) return 'meter';
  const abbr = raw.replace(/[\s\d._-]/g, '');
  const short = {
    v: 'verse', c: 'chorus', ch: 'chorus', pc: 'pre', p: 'pre', b: 'bridge', i: 'intro', o: 'outro', t: 'tag',
  }[abbr];
  if (short) return short;
  const n = raw.replace(/[^a-z가-힣]/g, '');
  if (n.startsWith('pre') || n.includes('프리')) return 'pre';
  if (n.startsWith('post')) return 'post';
  if (n.includes('chorus') || n.includes('후렴') || n.includes('코러스') || n.includes('hook')) return 'chorus';
  if (n.includes('verse') || n.includes('벌스') || n.includes('버스') || /^\d*절/.test(n)) return 'verse';
  if (n.includes('intro') || n.includes('인트로')) return 'intro';
  if (n.includes('bridge') || n.includes('브릿지')) return 'bridge';
  if (n.includes('solo') || n.includes('솔로')) return 'solo';
  if (n.includes('interlude') || n.includes('간주')) return 'interlude';
  if (n.includes('break') || n.includes('브레이크')) return 'break';
  if (n.includes('tag') || n.includes('태그')) return 'tag';
  if (n.includes('outro') || n.includes('아웃트로')) return 'outro';
  if (n.includes('ending') || n.includes('엔딩')) return 'ending';
  return 'other';
}

/**
 * 송폼 스트립: 파트 길이에 비례한 색 막대.
 * segs: [{ key, name, bars, weight }]  (key로 현재/다음 파트를 표시)
 */
export function buildStrip(container, segs, { labels = true } = {}) {
  container.replaceChildren(...segs.map((sg) => {
    const seg = el('div', { className: 'seg' });
    seg.dataset.tone = sectionTone(sg.name);
    seg.dataset.key = sg.key;
    seg.style.flexGrow = String(sg.weight);
    seg.append(el('i', { className: 'seg-fill' }));
    if (labels) {
      seg.append(el('span', { className: 'seg-name', textContent: sg.name }), el('span', { className: 'seg-bars', textContent: sg.bars }));
    }
    return seg;
  }));
}

/** 곡의 기본 송폼 → 스트립 조각 */
export function songSegments(song) {
  return song.sections.map((sec, k) => {
    const m = sectionMeter(song, sec);
    return {
      key: k, name: sec.name, bars: sec.bars, weight: sec.bars * m.beats * (60 / m.bpm),
    };
  });
}

export function buildFormStrip(container, song, opts) {
  buildStrip(container, songSegments(song), opts);
}

/** current: 진행 중 조각 key, progress: 그 안의 진행률(0~1), next: 브리핑 중인 다음 조각 key */
export function updateFormStrip(container, current, progress, next) {
  let passed = current !== null && current !== undefined && current !== -1;
  let seen = false;
  for (const seg of container.children) {
    const key = seg.dataset.key;
    const isCur = passed && key === String(current);
    if (isCur) seen = true;
    const done = passed && !seen;
    seg.classList.toggle('done', done);
    seg.classList.toggle('current', isCur);
    seg.classList.toggle('next', next !== null && next !== undefined && key === String(next));
    seg.style.setProperty('--p', (done ? 1 : isCur ? progress : 0).toFixed(4));
  }
  if (passed && !seen) {
    // 현재 조각이 없으면(카운트인 등) 아무것도 지나지 않은 것으로
    for (const seg of container.children) {
      seg.classList.remove('done');
      seg.style.setProperty('--p', '0');
    }
  }
}
