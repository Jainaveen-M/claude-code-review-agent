// DOM helpers, icons, formatters and small shared components.
// Everything from the server is inserted as text, never as HTML: review content
// comes from a model that read untrusted code.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

/** Replace an element's children, skipping null/false (the DOM would print them as text). */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** h('div', { class: 'x', onclick }, 'text', childNode, [more]) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG counterpart of h(). */
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Stroke icons on a 24px grid. "c:x,y,r" is a circle, "d:x,y" a filled dot.
const ICONS = {
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  branch: ['M6 3v12', 'c:18,6,3', 'c:6,18,3', 'M18 9a9 9 0 0 1-9 9'],
  commit: ['c:12,12,3', 'M3 12h6', 'M15 12h6'],
  swap: ['M7 4 3 8l4 4', 'M3 8h14', 'm17 20 4-4-4-4', 'M21 16H7'],
  'arrow-right': ['M5 12h14', 'm13 6 6 6-6 6'],
  'arrow-left': ['M19 12H5', 'm11 18-6-6 6-6'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  bug: ['M9 8h6a3 3 0 0 1 3 3v3a6 6 0 0 1-12 0v-3a3 3 0 0 1 3-3z', 'M9 8V7a3 3 0 0 1 6 0v1', 'M3 13h3', 'M18 13h3', 'm4 7 2.5 2', 'm20 7-2.5 2', 'm4 19 2.5-2', 'm20 19-2.5-2'],
  sparkles: ['m12 3 1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z', 'm19 15 .8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z'],
  layers: ['M12 3 3 8l9 5 9-5z', 'm3 13 9 5 9-5'],
  dots: ['d:5,12', 'd:12,12', 'd:19,12'],
  doc: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6', 'M9 17h6'],
  upload: ['M12 15V4', 'm7 9 5-5 5 5', 'M5 20h14'],
  paste: ['M9 4h6v3H9z', 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2'],
  skip: ['m5 5 7 7-7 7', 'm13 5 7 7-7 7'],
  play: ['M7 4v16l13-8z'],
  search: ['c:11,11,7', 'm21 21-4.3-4.3'],
  'chevron-right': ['m9 6 6 6-6 6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  external: ['M14 4h6v6', 'M20 4 10 14', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  download: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'm6 7 1 13h10l1-13', 'M9 7V4h6v3'],
  alert: ['M12 3 2 21h20z', 'M12 10v5', 'M12 18h.01'],
  info: ['c:12,12,9', 'M12 11v5', 'M12 8h.01'],
  clock: ['c:12,12,9', 'M12 7v5l3 2'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'c:12,12,3'],
  terminal: ['m5 8 4 4-4 4', 'M12 16h7'],
  message: ['M4 5h16v11H8l-4 4z'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  code: ['m8 6-6 6 6 6', 'm16 6 6 6-6 6'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M2 20h20'],
  list: ['M10 6h10', 'M10 12h10', 'M10 18h10', 'm3 6 1.5 1.5L7 5', 'm3 12 1.5 1.5L7 11', 'm3 18 1.5 1.5L7 17'],
};

export function icon(name, size = 16) {
  const parts = (ICONS[name] ?? ICONS.dots).map((d) => {
    if (d.startsWith('c:')) {
      const [cx, cy, r] = d.slice(2).split(',');
      return s('circle', { cx, cy, r });
    }
    if (d.startsWith('d:')) {
      const [cx, cy] = d.slice(2).split(',');
      return s('circle', { cx, cy, r: 1.6, fill: 'currentColor', stroke: 'none' });
    }
    return s('path', { d });
  });
  return s('svg', {
    class: 'icon', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  }, parts);
}

// ---------- Labels ----------

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const PRIORITY_LABEL = { P0: 'Critical', P1: 'Major', P2: 'Minor', P3: 'Suggestion' };
export const VERDICTS = ['APPROVE', 'NEEDS_DISCUSSION', 'REQUEST_CHANGES'];
export const VERDICT_LABEL = { APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes', NEEDS_DISCUSSION: 'Needs discussion' };
export const TYPE_LABEL = { bugfix: 'Bug fix', feature: 'Feature', refactor: 'Refactor', other: 'Other' };
export const STATUS_LABEL = { implemented: 'Implemented', partial: 'Partial', missing: 'Missing', not_verifiable: 'Not verifiable' };
export const ANSWER = { yes: 'Yes', partial: 'Partially', no: 'No', unclear: 'Unclear', not_applicable: 'Not applicable' };

// ---------- Formatting ----------

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function formatDate(iso) {
  const date = new Date(iso);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', year, hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return plural(days, 'day') + ' ago';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

// Claude Code reports an API-equivalent cost; on a subscription it is an estimate, not a charge.
export const formatCost = (usd) => (usd == null ? '' : `≈ $${usd.toFixed(2)}`);

export const modelLabel = (model) => (model === 'default' ? 'Claude Code default model' : model);

export const shortSha = (sha) => String(sha ?? '').slice(0, 7);

export const findingLocation = (f) => (f.line ? `${f.file}:${f.line}` : f.file);

// ---------- Components ----------

export const verdictBadge = (verdict, big = false) => h('span', { class: `verdict ${verdict}${big ? ' big' : ''}` }, VERDICT_LABEL[verdict] ?? verdict);

export const priorityChip = (priority, text = priority) => h('span', { class: `prio ${priority}`, title: PRIORITY_LABEL[priority] }, text);

export function countChips(counts) {
  return h('span', { class: 'counts' }, PRIORITIES.map((p) =>
    h('span', { class: `prio ${p}${counts[p] ? '' : ' zero'}`, title: `${PRIORITY_LABEL[p]}: ${counts[p]}` }, `${p} ${counts[p]}`)));
}

export const statusBadge = (status) => h('span', { class: `status ${status}` }, STATUS_LABEL[status] ?? status);

export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, icon(iconName, 36), h('strong', {}, title), text ? h('p', {}, text) : null, action ?? null);
}

let toastTimer = null;
export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/** Confirm dialog. Resolves true when the user confirms. */
export function confirmDialog({ title, text, confirm = 'Delete' }) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = confirm;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}
