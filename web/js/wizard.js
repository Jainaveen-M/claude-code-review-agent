// New review: a step-by-step wizard. Project -> Branches -> What changed -> BRD -> Review.
import { api } from './api.js';
import { TYPE_LABEL, $, fill, formatCost, h, icon, modelLabel, plural, relativeTime, shortSha } from './dom.js';
import { openFolderDialog } from './folders.js';
import { openSettings } from './settings.js';
import { canRun, loadRecentRepos, state } from './store.js';

const MAX_BRD_BYTES = 20 * 1024 * 1024;
const MAX_BRANCHES_SHOWN = 200;
const STEPS = [
  { id: 'project', label: 'Project' },
  { id: 'branches', label: 'Branches' },
  { id: 'change', label: 'What changed' },
  { id: 'brd', label: 'BRD' },
  { id: 'confirm', label: 'Review' },
];
const TYPES = [
  { id: 'bugfix', icon: 'bug', title: 'Bug fix', text: 'Something was broken and you fixed it' },
  { id: 'feature', icon: 'sparkles', title: 'Feature', text: 'New behaviour, optionally checked against a BRD' },
  { id: 'refactor', icon: 'layers', title: 'Refactor', text: 'Same behaviour, better code' },
  { id: 'other', icon: 'dots', title: 'Other', text: 'Config, dependencies, docs and the rest' },
];
const TIPS = {
  bugfix: ['What was broken, and how did it show up?', 'What caused it?', 'How does your change fix it? Did you add a test?'],
  feature: ['What does the feature do for users?', 'Which parts of the code did you touch?', 'Anything deliberately left out?'],
  refactor: ['What did you restructure, and why?', 'What should behave exactly as before?'],
  other: ['What changed, and why?', 'Anything reviewers should double-check?'],
};
const PLACEHOLDER = {
  bugfix: 'e.g. Customers were charged twice when the payment retry fired after a timeout. The retry reused a new idempotency key; it now reuses the original one. Added a regression test.',
  feature: 'e.g. Adds coupon codes at checkout: a coupon field, server-side validation (expiry and usage limits) and percentage or fixed discounts.',
  refactor: 'e.g. Split the 900-line OrderService into pricing, payment and fulfilment modules. No behaviour change intended.',
  other: 'e.g. Upgraded the ORM from v5 to v6 and updated the deprecated query calls.',
};

const draft = {
  step: 0,
  repo: null,
  repoLoading: false,
  repoError: null,
  source: null,
  dest: null,
  filter: { source: '', dest: '' },
  fetch: true,
  preview: null,
  previewKey: null,
  previewError: null,
  previewLoading: false,
  changeType: null,
  description: '',
  brdMode: 'none',
  brdFile: null,
  brdText: '',
  starting: false,
  startError: null,
};
let root = null;
let previewTimer = null;

// ---------- Step logic ----------

// The BRD step only applies to features; until a type is chosen it's simply upcoming.
const brdSkipped = () => draft.changeType != null && draft.changeType !== 'feature';
const stepSkipped = (i) => STEPS[i].id === 'brd' && brdSkipped();

function stepValid(i) {
  switch (STEPS[i].id) {
    case 'project': return Boolean(draft.repo) && !draft.repoLoading;
    case 'branches': return Boolean(draft.source && draft.dest && draft.source !== draft.dest && draft.preview && !draft.previewError && !draft.previewLoading);
    case 'change': return Boolean(draft.changeType && draft.description.trim());
    case 'brd': return brdSkipped() || draft.brdMode === 'none' || (draft.brdMode === 'file' && Boolean(draft.brdFile)) || (draft.brdMode === 'text' && Boolean(draft.brdText.trim()));
    default: return canRun();
  }
}

/** Furthest step the user may jump to: every step before it is valid. */
function reachable(i) {
  for (let j = 0; j < i; j += 1) if (!stepSkipped(j) && !stepValid(j)) return false;
  return true;
}

function goTo(i, direction = 1) {
  let target = i;
  while (stepSkipped(target)) target += direction;
  draft.step = Math.max(0, Math.min(STEPS.length - 1, target));
  draw();
  if (STEPS[draft.step].id === 'branches') schedulePreview();
  root?.querySelector('.wizard-card')?.scrollIntoView({ block: 'nearest' });
}

export function resetForNewReview() {
  Object.assign(draft, { step: 0, changeType: null, description: '', brdMode: 'none', brdFile: null, brdText: '', startError: null, starting: false });
}

// ---------- Data ----------

async function loadRepo(path, { fetch = false } = {}) {
  draft.repoLoading = true;
  draft.repoError = null;
  draw();
  try {
    const data = await api(`/api/branches?repo=${encodeURIComponent(path)}${fetch ? '&fetch=1' : ''}`);
    const sameRepo = draft.repo?.repoPath === data.repoPath;
    draft.repo = data;
    const names = new Set(data.branches.map((b) => b.name));
    if (!sameRepo || !names.has(draft.dest)) draft.dest = data.defaultDest ?? data.branches[0]?.name ?? null;
    if (!sameRepo || !names.has(draft.source)) {
      draft.source = data.current && data.current !== draft.dest ? data.current : data.branches.find((b) => b.name !== draft.dest)?.name ?? null;
    }
    draft.previewKey = null;
  } catch (error) {
    draft.repoError = error.message;
    if (!draft.repo || draft.repo.repoPath !== path) draft.repo = null;
  } finally {
    draft.repoLoading = false;
    draw();
    if (STEPS[draft.step].id === 'branches') schedulePreview();
  }
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(loadPreview, 120);
}

async function loadPreview() {
  if (!draft.repo || !draft.source || !draft.dest) return;
  const key = `${draft.repo.repoPath}|${draft.source}|${draft.dest}`;
  if (key === draft.previewKey && (draft.preview || draft.previewError)) return;
  draft.previewKey = key;
  if (draft.source === draft.dest) {
    draft.preview = null;
    draft.previewError = 'Pick two different branches.';
    refreshPreview();
    return;
  }
  draft.previewLoading = true;
  refreshPreview();
  try {
    const params = new URLSearchParams({ repo: draft.repo.repoPath, source: draft.source, dest: draft.dest });
    const preview = await api(`/api/preview?${params}`);
    if (draft.previewKey !== key) return;
    draft.preview = preview;
    draft.previewError = null;
  } catch (error) {
    if (draft.previewKey !== key) return;
    draft.preview = null;
    draft.previewError = error.message;
  } finally {
    if (draft.previewKey === key) {
      draft.previewLoading = false;
      refreshPreview();
    }
  }
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

async function takeBrdFile(file) {
  const ext = file.name.toLowerCase().match(/\.[a-z]+$/)?.[0] ?? '';
  if (!['.pdf', '.docx', '.md', '.markdown', '.txt'].includes(ext)) {
    draft.brdFile = null;
    draft.brdError = `Unsupported file type "${ext || file.name}". Use PDF, Word (.docx), Markdown or text.`;
  } else if (file.size > MAX_BRD_BYTES) {
    draft.brdError = 'The file is larger than 20 MB.';
  } else {
    const isText = ['.md', '.markdown', '.txt'].includes(ext);
    draft.brdFile = { name: file.name, size: file.size, ext, base64: await readFile(file), preview: isText ? (await file.text()).slice(0, 2000) : null };
    draft.brdError = null;
  }
  draw();
}

async function start() {
  draft.starting = true;
  draft.startError = null;
  draw();
  try {
    const body = {
      repoPath: draft.repo.repoPath,
      source: draft.source,
      dest: draft.dest,
      changeType: draft.changeType,
      description: draft.description.trim(),
      fetch: draft.fetch,
    };
    if (draft.changeType === 'feature' && draft.brdMode === 'file') body.brd = { name: draft.brdFile.name, base64: draft.brdFile.base64 };
    if (draft.changeType === 'feature' && draft.brdMode === 'text') body.brd = { text: draft.brdText };
    const { runId } = await api('/api/reviews', { method: 'POST', body });
    draft.starting = false;
    loadRecentRepos().catch(() => {});
    location.hash = `#/run/${runId}`;
  } catch (error) {
    draft.starting = false;
    draft.startError = error.message;
    draw();
  }
}

// ---------- Rendering ----------

function stepper() {
  return h('ol', { class: 'stepper' }, STEPS.map((step, i) => {
    const skipped = stepSkipped(i);
    const cls = skipped ? 'skipped' : i === draft.step ? 'current' : i < draft.step && stepValid(i) ? 'done' : '';
    return h('li', { class: cls },
      h('button', {
        type: 'button',
        class: 'step-btn',
        disabled: skipped || i === draft.step || !reachable(i),
        'aria-current': i === draft.step ? 'step' : null,
        title: skipped ? 'Only for features' : step.label,
        onclick: () => goTo(i),
      },
      h('span', { class: 'step-dot' }, cls === 'done' ? icon('check', 15) : String(i + 1)),
      h('span', { class: 'step-label' }, step.label)));
  }));
}

function stepHead(title, text) {
  return h('div', { class: 'step-head' }, h('h2', {}, title), text ? h('p', {}, text) : null);
}

// Step 1
function projectStep() {
  const { repo } = draft;
  const browse = () => openFolderDialog({ current: repo?.repoPath, onSelect: (path) => loadRepo(path) });
  let current;
  if (draft.repoLoading) {
    current = h('div', { class: 'repo-current empty-state' }, h('span', { class: 'spinner' }), h('div', { class: 'repo-info' }, 'Loading branches...'));
  } else if (repo) {
    current = h('div', { class: 'repo-current' },
      h('span', { class: 'repo-avatar' }, icon('folder', 20)),
      h('div', { class: 'repo-info' },
        h('div', { class: 'repo-name' }, repo.repo),
        h('div', { class: 'repo-path' }, repo.repoPath),
        h('div', { class: 'repo-meta' },
          h('span', {}, icon('branch', 14), plural(repo.branches.length, 'branch', 'branches')),
          repo.current ? h('span', {}, icon('check', 14), `on ${repo.current}`) : null,
          repo.warning ? h('span', { class: 'error' }, repo.warning) : null)),
      h('button', { type: 'button', class: 'btn', onclick: browse }, 'Change…'));
  } else {
    current = h('div', { class: 'repo-current empty-state' },
      h('span', { class: 'repo-avatar' }, icon('folder', 20)),
      h('div', { class: 'repo-info' }, h('div', { class: 'repo-name' }, 'No project selected'), h('div', { class: 'hint' }, 'Pick a git repository to review.')),
      h('button', { type: 'button', class: 'btn primary', onclick: browse }, icon('search', 15), 'Browse folders…'));
  }

  const recent = state.recentRepos.filter((r) => r.repoPath !== repo?.repoPath).slice(0, 6);
  const pathInput = h('input', { type: 'text', placeholder: '/absolute/path/to/repo', spellcheck: 'false', value: repo?.repoPath ?? '', 'aria-label': 'Repository path' });
  const openPath = () => pathInput.value.trim() && loadRepo(pathInput.value.trim());
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openPath(); } });

  return [
    stepHead('Which project?', 'Choose the git repository that has your changes.'),
    current,
    draft.repoError ? h('p', { class: 'error', style: { marginTop: '8px' } }, draft.repoError) : null,
    recent.length ? h('div', { class: 'section-label' }, 'Recent projects') : null,
    recent.length ? h('div', { class: 'repo-grid' }, recent.map((r) => h('button', { type: 'button', class: 'repo-card', title: r.repoPath, onclick: () => loadRepo(r.repoPath) },
      h('span', { class: 'repo-avatar' }, icon('folder', 16)),
      h('span', { class: 'repo-info' }, h('div', { class: 'name' }, r.repo), h('div', { class: 'sub' }, `Reviewed ${relativeTime(r.lastReviewed)}`))))) : null,
    h('div', { class: 'section-label' }, 'Or'),
    h('div', { class: 'chips' },
      h('button', { type: 'button', class: 'btn outline-accent', onclick: browse }, icon('folder', 15), 'Browse folders…')),
    h('div', { class: 'path-row' }, pathInput, h('button', { type: 'button', class: 'btn', onclick: openPath }, 'Open path')),
  ];
}

// Step 2
function branchColumn(side) {
  const other = side === 'source' ? draft.dest : draft.source;
  const selected = draft[side];
  const search = h('input', { type: 'search', placeholder: 'Filter branches', value: draft.filter[side], 'aria-label': `Filter ${side} branches` });
  const list = h('ul', { class: 'branch-list', role: 'listbox', 'aria-label': side === 'source' ? 'Source branch' : 'Destination branch' });
  const drawList = () => {
    const needle = draft.filter[side].trim().toLowerCase();
    const matches = draft.repo.branches.filter((b) => !needle || b.name.toLowerCase().includes(needle));
    if (matches.length === 0) {
      fill(list, h('li', { class: 'none' }, 'No branches match.'));
      return;
    }
    fill(list, ...matches.slice(0, MAX_BRANCHES_SHOWN).map((b) => h('li', {},
      h('button', {
        type: 'button',
        class: 'branch-item',
        'aria-pressed': b.name === selected ? 'true' : 'false',
        disabled: b.name === other,
        title: b.name === other ? `Already chosen as the ${side === 'source' ? 'destination' : 'source'}` : b.name,
        onclick: () => { draft[side] = b.name; draw(); schedulePreview(); },
      },
      h('span', { class: 'bname' }, h('span', {}, b.name),
        b.kind === 'remote' ? h('span', { class: 'tag' }, 'remote') : null,
        b.name === draft.repo.current ? h('span', { class: 'tag accent' }, 'current') : null),
      b.subject ? h('span', { class: 'bsub' }, b.subject) : null,
      h('span', { class: 'bmeta' }, [b.author, b.date ? relativeTime(b.date) : null].filter(Boolean).join(' · '))))),
    matches.length > MAX_BRANCHES_SHOWN ? h('li', { class: 'none' }, `${matches.length - MAX_BRANCHES_SHOWN} more: type to filter`) : null);
  };
  search.addEventListener('input', () => { draft.filter[side] = search.value; drawList(); });
  drawList();
  queueMicrotask(() => list.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' }));
  return h('div', { class: 'branch-col' },
    h('div', { class: 'branch-col-head' },
      h('div', { class: 'title' },
        h('strong', {}, side === 'source' ? 'Your changes' : 'Merging into'),
        h('span', { class: 'hint mono' }, selected ?? '')),
      search),
    list);
}

function previewPanel() {
  const panel = h('div', { class: `preview${draft.previewLoading ? ' is-loading' : ''}${draft.previewError ? ' is-error' : ''}`, id: 'branch-preview', 'aria-live': 'polite' });
  if (draft.previewError) {
    fill(panel, h('div', { class: 'preview-head' }, icon('alert', 16), draft.previewError));
    return panel;
  }
  const p = draft.preview;
  if (!p) {
    fill(panel, h('div', { class: 'preview-head' }, h('span', { class: 'spinner' }), 'Comparing branches...'));
    return panel;
  }
  const maxLines = Math.max(...p.filesChanged.map((f) => f.insertions + f.deletions), 1);
  const files = [...p.filesChanged].sort((a, b) => (b.insertions + b.deletions) - (a.insertions + a.deletions));
  fill(panel, 
    h('div', { class: 'preview-head' }, icon('eye', 16), `What will be reviewed`, draft.previewLoading ? h('span', { class: 'spinner' }) : null),
    h('div', { class: 'preview-stats' },
      h('div', { class: 'stat' }, h('span', { class: 'value' }, String(p.commitCount)), h('span', { class: 'label' }, p.commitCount === 1 ? 'commit' : 'commits')),
      h('div', { class: 'stat' }, h('span', { class: 'value' }, String(p.stats.files)), h('span', { class: 'label' }, p.stats.files === 1 ? 'file changed' : 'files changed')),
      h('div', { class: 'stat' }, h('span', { class: 'value' }, h('span', { class: 'add' }, `+${p.stats.insertions}`), ' ', h('span', { class: 'del' }, `−${p.stats.deletions}`)), h('span', { class: 'label' }, 'lines'))),
    h('div', { class: 'preview-grid' },
      h('div', {},
        h('div', { class: 'mini-head' }, 'Commits'),
        h('ul', { class: 'commit-list' }, p.commits.slice(0, 8).map((c) => h('li', {}, h('span', { class: 'sha' }, shortSha(c.sha)), h('span', { class: 'subj', title: c.subject }, c.subject)))),
        p.commitCount > 8 ? h('div', { class: 'more' }, `+ ${p.commitCount - 8} more`) : null),
      h('div', {},
        h('div', { class: 'mini-head' }, 'Files'),
        h('ul', { class: 'file-bars' }, files.slice(0, 10).map((f) => h('li', {},
          h('span', { class: 'fpath', title: f.path }, `‎${f.path}`),
          h('span', { class: 'fbar', 'aria-hidden': 'true' },
            f.insertions ? h('span', { class: 'a', style: { flexGrow: String(f.insertions), maxWidth: `${(f.insertions / maxLines) * 100}%` } }) : null,
            f.deletions ? h('span', { class: 'd', style: { flexGrow: String(f.deletions), maxWidth: `${(f.deletions / maxLines) * 100}%` } }) : null),
          h('span', { class: 'fnum' }, f.binary ? 'binary' : [h('span', { class: 'a' }, `+${f.insertions}`), ' ', h('span', { class: 'd' }, `−${f.deletions}`)])))),
        files.length > 10 ? h('div', { class: 'more' }, `+ ${files.length - 10} more files`) : null)),
    p.behind > 0 ? h('div', { class: 'notice' }, icon('info', 15), `${draft.dest} has ${plural(p.behind, 'commit')} that ${draft.source} doesn't. The review only covers your branch's own changes, but you may want to rebase or merge first.`) : null,
  );
  return panel;
}

function refreshPreview() {
  const old = root?.querySelector('#branch-preview');
  if (old) old.replaceWith(previewPanel());
  refreshActions();
}

function branchesStep() {
  if (!draft.repo) return [stepHead('Which branches?'), h('p', { class: 'error' }, 'Choose a project first.')];
  const swap = () => {
    [draft.source, draft.dest] = [draft.dest, draft.source];
    draw();
    schedulePreview();
  };
  return [
    stepHead('Which branches?', `Pick the branch with your changes and the branch it will be merged into. The review covers what a pull request would show.`),
    h('div', { class: 'branch-cols' },
      branchColumn('source'),
      h('div', { class: 'swap' }, h('button', { type: 'button', class: 'btn', title: 'Swap branches', 'aria-label': 'Swap branches', onclick: swap }, icon('swap', 16))),
      branchColumn('dest')),
    h('div', { class: 'branch-tools' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: draft.fetch, onchange: (e) => { draft.fetch = e.target.checked; } }),
        'Fetch remotes before the review'),
      h('button', { type: 'button', class: 'link', onclick: () => loadRepo(draft.repo.repoPath, { fetch: true }) }, 'Fetch now and refresh branches')),
    previewPanel(),
  ];
}

// Step 3
function changeStep() {
  const textarea = h('textarea', { id: 'description', rows: 6, placeholder: PLACEHOLDER[draft.changeType ?? 'bugfix'] });
  textarea.value = draft.description;
  const counter = h('span', { class: 'hint' }, `${draft.description.trim().length} characters`);
  textarea.addEventListener('input', () => {
    draft.description = textarea.value;
    counter.textContent = `${draft.description.trim().length} characters`;
    refreshActions();
  });
  const commits = draft.preview?.commits ?? [];
  const useCommits = () => {
    const lines = commits.map((c) => `- ${c.subject}`).join('\n');
    draft.description = draft.description.trim() ? `${draft.description.trim()}\n${lines}` : lines;
    textarea.value = draft.description;
    textarea.dispatchEvent(new Event('input'));
    textarea.focus();
  };
  return [
    stepHead('What did you change?', 'The review checks the code against what you say here, so the more specific, the better.'),
    h('div', { class: 'type-grid', role: 'radiogroup', 'aria-label': 'Type of change' }, TYPES.map((t) => h('button', {
      type: 'button',
      class: 'type-card',
      role: 'radio',
      'aria-checked': draft.changeType === t.id ? 'true' : 'false',
      onclick: () => { draft.changeType = t.id; draw(); root.querySelector('#description')?.focus(); },
    }, h('span', { class: 'ticon' }, icon(t.icon, 18)), h('strong', {}, t.title), h('span', {}, t.text)))),
    draft.changeType ? h('div', { class: 'describe' },
      h('div', { class: 'describe-head' },
        h('label', { for: 'description' }, draft.changeType === 'bugfix' ? 'What did you fix?' : 'What did you change?'),
        commits.length ? h('button', { type: 'button', class: 'btn small', onclick: useCommits }, icon('commit', 14), 'Use commit messages') : null),
      textarea,
      h('div', { class: 'describe-head' }, h('ul', { class: 'tips' }, TIPS[draft.changeType].map((tip) => h('li', {}, tip))), counter)) : null,
  ];
}

// Step 4
function brdStep() {
  const option = (mode, iconName, title, text) => h('button', {
    type: 'button',
    class: 'type-card',
    role: 'radio',
    'aria-checked': draft.brdMode === mode ? 'true' : 'false',
    onclick: () => { draft.brdMode = mode; draw(); },
  }, h('span', { class: 'ticon' }, icon(iconName, 18)), h('strong', {}, title), h('span', {}, text));

  let body = null;
  if (draft.brdMode === 'file') {
    if (draft.brdFile) {
      const f = draft.brdFile;
      body = h('div', {},
        h('div', { class: 'file-chip' },
          h('span', { class: 'repo-avatar' }, icon('doc', 18)),
          h('div', { class: 'info' }, h('div', { class: 'name' }, f.name), h('div', { class: 'hint' }, `${(f.size / 1024).toFixed(0)} KB · ${f.ext.slice(1).toUpperCase()}`)),
          h('button', { type: 'button', class: 'btn small danger-ghost', onclick: () => { draft.brdFile = null; draw(); } }, icon('x', 14), 'Remove')),
        f.preview ? h('div', { class: 'brd-preview' }, f.preview) : null);
    } else {
      const input = h('input', { type: 'file', accept: '.pdf,.docx,.md,.markdown,.txt', class: 'visually-hidden', onchange: (e) => e.target.files[0] && takeBrdFile(e.target.files[0]) });
      const zone = h('label', { class: 'dropzone' },
        input, icon('upload', 30), h('strong', {}, 'Drop the BRD here, or click to choose'), h('span', { class: 'hint' }, 'PDF, Word (.docx), Markdown or text, up to 20 MB'));
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
        if (e.dataTransfer.files[0]) takeBrdFile(e.dataTransfer.files[0]);
      });
      body = zone;
    }
  } else if (draft.brdMode === 'text') {
    const textarea = h('textarea', { placeholder: 'Paste the BRD, or just its requirements' });
    textarea.value = draft.brdText;
    const detected = h('span', { class: 'hint' });
    const count = () => {
      const lines = draft.brdText.split('\n').filter((l) => /^\s*(REQ[-\s]?\d+|FR[-\s]?\d+|\d+[.)]|[-*•])\s+\S/i.test(l)).length;
      detected.textContent = lines ? `${plural(lines, 'line')} look like requirements` : `${draft.brdText.trim().length} characters`;
    };
    textarea.addEventListener('input', () => { draft.brdText = textarea.value; count(); refreshActions(); });
    count();
    body = h('div', { class: 'paste-box' }, textarea, detected);
  }

  return [
    stepHead('Is there a BRD?', 'With a BRD, every requirement is checked against the code: implemented, partial, missing or not verifiable.'),
    h('div', { class: 'option-grid', role: 'radiogroup', 'aria-label': 'BRD' },
      option('file', 'upload', 'Upload a file', 'PDF, Word, Markdown or text'),
      option('text', 'paste', 'Paste text', 'Paste the requirements'),
      option('none', 'skip', 'No BRD', 'Review against your description only')),
    draft.brdError ? h('p', { class: 'error', style: { marginTop: '10px' } }, draft.brdError) : null,
    body,
  ];
}

// Step 5
function confirmStep() {
  const { config, claude } = state.status;
  const p = draft.preview;
  const row = (label, value, step, action) => h('div', {},
    h('dt', {}, label), h('dd', {}, value),
    h('button', { type: 'button', class: 'link', onclick: action ?? (() => goTo(step)) }, step === 'settings' ? 'Change' : 'Edit'));
  const brdValue = draft.brdMode === 'file' ? draft.brdFile?.name : draft.brdMode === 'text' ? `Pasted text (${draft.brdText.trim().length} characters)` : 'None';
  const plan = claude.subscriptionType ? ` (${claude.subscriptionType})` : '';
  return [
    stepHead('Ready to review', 'Check your choices, then start. You can watch the review live.'),
    h('dl', { class: 'summary-list' },
      row('Project', [h('strong', {}, draft.repo.repo), h('div', { class: 'repo-path' }, draft.repo.repoPath)], 0),
      row('Branches', [h('span', { class: 'mono' }, `${draft.source} → ${draft.dest}`), p ? h('div', { class: 'hint' }, `${plural(p.commitCount, 'commit')}, ${plural(p.stats.files, 'file')}, +${p.stats.insertions} −${p.stats.deletions}`) : null], 1),
      row('Type', TYPE_LABEL[draft.changeType], 2),
      row('What changed', draft.description.trim().length > 500 ? `${draft.description.trim().slice(0, 500)}…` : draft.description.trim(), 2),
      draft.changeType === 'feature' ? row('BRD', brdValue, 3) : null,
      row('Model', `${modelLabel(config.model)}, ${config.effort} effort${config.maxBudgetUsd ? `, stops above ${formatCost(config.maxBudgetUsd)}` : ''}`, 'settings', () => openSettings(draw))),
    h('div', { class: 'start-box' },
      h('span', { class: 'repo-avatar' }, icon('play', 18)),
      h('div', { class: 'grow' },
        h('strong', {}, canRun() ? `Runs on your Claude Code session${plan}` : 'Claude Code is not ready'),
        h('span', { class: 'hint' }, canRun() ? 'Usually takes 1–5 minutes, depending on the size of the change. Counts toward your plan\'s usage.' : state.status.claude.error)),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: draft.fetch, onchange: (e) => { draft.fetch = e.target.checked; } }),
        'Fetch remotes first')),
  ];
}

const RENDER = { project: projectStep, branches: branchesStep, change: changeStep, brd: brdStep, confirm: confirmStep };

function actions() {
  const isLast = draft.step === STEPS.length - 1;
  let next = draft.step + 1;
  while (next < STEPS.length && stepSkipped(next)) next += 1;
  return h('div', { class: 'wizard-actions' },
    draft.step > 0 ? h('button', { type: 'button', class: 'btn', onclick: () => goTo(draft.step - 1, -1) }, icon('arrow-left', 15), 'Back') : null,
    h('span', { class: 'spacer' }),
    draft.startError ? h('p', { class: 'error' }, draft.startError) : null,
    isLast
      ? h('button', { type: 'button', class: 'btn primary big', id: 'start-btn', disabled: !stepValid(draft.step) || draft.starting, onclick: start },
        draft.starting ? h('span', { class: 'spinner' }) : icon('play', 16), draft.starting ? 'Starting…' : 'Start review')
      : h('button', { type: 'button', class: 'btn primary', id: 'next-btn', disabled: !stepValid(draft.step), onclick: () => goTo(next) },
        `Next: ${STEPS[next].label}`, icon('arrow-right', 15)));
}

function refreshActions() {
  const old = root?.querySelector('.wizard-actions');
  if (old) old.replaceWith(actions());
  const oldStepper = root?.querySelector('.stepper');
  if (oldStepper) oldStepper.replaceWith(stepper());
}

function draw() {
  if (!root) return;
  fill(root, 
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'New review'), h('p', {}, 'Review what a branch adds before you merge it.'))),
    stepper(),
    h('section', { class: 'card wizard-card', 'aria-label': STEPS[draft.step].label }, RENDER[STEPS[draft.step].id](), actions()),
  );
}

export function render(container) {
  root = container;
  if (!draft.repo && !draft.repoLoading && !draft.repoError) {
    const start = state.status?.launchRepo ?? state.recentRepos[0]?.repoPath;
    if (start) loadRepo(start);
  }
  draw();
  if (STEPS[draft.step].id === 'branches') schedulePreview();
  return () => { root = null; clearTimeout(previewTimer); };
}
