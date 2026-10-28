// 공용 UI 도우미: 아이콘, 파트별 색상, 송폼 스트립

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
  const n = String(name).toLowerCase().replace(/[^a-z가-힣]/g, '');
  if (n.startsWith('pre') || n.includes('프리')) return 'pre';
  if (n.startsWith('post')) return 'post';
  if (n.includes('chorus') || n.includes('후렴') || n.includes('코러스') || n.includes('hook')) return 'chorus';
  if (n.includes('verse') || n.includes('벌스') || /^\d*절/.test(n)) return 'verse';
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
 * labels=true면 파트 이름·마디 수를 표시한다.
 */
export function buildFormStrip(container, song, { labels = true } = {}) {
  container.replaceChildren(...song.sections.map((sec, k) => {
    const beats = sec.beatsPerBar ?? song.beatsPerBar;
    const bpm = sec.bpm ?? song.bpm;
    const seg = el('div', { className: 'seg' });
    seg.dataset.tone = sectionTone(sec.name);
    seg.dataset.k = k;
    seg.style.flexGrow = String(sec.bars * beats * (60 / bpm));
    seg.append(el('i', { className: 'seg-fill' }));
    if (labels) {
      seg.append(el('span', { className: 'seg-name', textContent: sec.name }), el('span', { className: 'seg-bars', textContent: sec.bars }));
    }
    return seg;
  }));
  container.dataset.song = song.id;
}

/** current: 진행 중 파트, progress: 그 파트 안의 진행률(0~1), next: 브리핑 중인 다음 파트 */
export function updateFormStrip(container, current, progress, next) {
  for (const seg of container.children) {
    const k = Number(seg.dataset.k);
    seg.classList.toggle('done', current >= 0 && k < current);
    seg.classList.toggle('current', k === current);
    seg.classList.toggle('next', k === next);
    const fill = k < current ? 1 : k === current ? progress : 0;
    seg.style.setProperty('--p', fill.toFixed(4));
  }
}
