// Code Review Agent UI. Everything from the server is rendered as text (never innerHTML):
// review content comes from a model that read untrusted code.

const $ = (selector) => document.querySelector(selector);
const MAX_BRD_BYTES = 20 * 1024 * 1024;
const VERDICT_LABEL = { APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes', NEEDS_DISCUSSION: 'Needs discussion' };
const VERDICT_CLASS = { APPROVE: 'approve', REQUEST_CHANGES: 'changes', NEEDS_DISCUSSION: 'discuss' };
const TYPE_LABEL = { bugfix: 'Bug fix', feature: 'Feature', refactor: 'Refactor', other: 'Other' };
const STATUS_LABEL = { implemented: 'Implemented', partial: 'Partial', missing: 'Missing', not_verifiable: 'Not verifiable' };
const ANSWER = { yes: 'Yes', partial: 'Partially', no: 'No', unclear: 'Unclear', not_applicable: 'n/a' };
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

const state = { token: null, status: null, run: null, historyTimer: null };

/** Tiny element builder: h('td', { class: 'x' }, 'text', childNode). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// ---------- API ----------

function initToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    try { sessionStorage.setItem('cra-token', fromUrl); } catch { /* storage blocked */ }
    url.searchParams.delete('t');
    history.replaceState(null, '', url.pathname + url.search);
    return fromUrl;
  }
  try { return sessionStorage.getItem('cra-token'); } catch { return null; }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-CRA-Token': state.token ?? '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

const withToken = (path) => `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(state.token)}`;

// ---------- Formatting ----------

function formatDate(iso) {
  const date = new Date(iso);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', year, hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Claude Code reports an API-equivalent cost; on a subscription it is an estimate, not a charge.
const formatCost = (usd) => (usd == null ? '' : `≈ $${usd.toFixed(2)}`);
const modelLabel = (model) => (model === 'default' ? 'Claude Code default model' : model);
const canRun = () => Boolean(state.status?.claude.loggedIn);

function countChips(counts) {
  return h('span', { class: 'counts' }, PRIORITIES.map((p) =>
    h('span', { class: `prio ${p}${counts[p] ? '' : ' zero'}`, title: `${p}: ${counts[p]}` }, `${p} ${counts[p]}`)));
}

const verdictBadge = (verdict) => h('span', { class: `verdict ${verdict}` }, VERDICT_LABEL[verdict] ?? verdict);

// ---------- Banner and status ----------

function showBanner(title, text, kind = 'warn') {
  const banner = $('#banner');
  banner.className = `banner${kind === 'error' ? ' error' : ''}`;
  banner.replaceChildren(h('strong', {}, title), text ? h('p', {}, text) : null);
  banner.hidden = false;
}

async function loadStatus() {
  state.status = await api('/api/status');
  const { claude, config } = state.status;
  $('#model-pill').textContent = modelLabel(config.model);
  $('#session-pill').textContent = claude.loggedIn
    ? `Claude Code${claude.subscriptionType ? ` · ${claude.subscriptionType[0].toUpperCase()}${claude.subscriptionType.slice(1)}` : ''}`
    : '';
  $('#session-pill').title = claude.loggedIn ? `Reviews run on your Claude Code session (${claude.path}, ${claude.version})` : '';
  if (!claude.loggedIn) {
    showBanner(
      claude.found ? 'Claude Code is not logged in' : 'Claude Code is not installed',
      `${claude.error} Reviews run on your local Claude Code session. You can still browse past reports. Reload this page once it's set up.`,
    );
    $('#run-btn').disabled = true;
  } else {
    $('#banner').hidden = true;
  }
}

// ---------- Repository and branches ----------

async function loadRecentRepos() {
  const { repos } = await api('/api/repos/recent');
  $('#recent-repos').replaceChildren(...repos.map((r) => h('option', { value: r.repoPath }, r.repo)));
  return repos;
}

function fillBranchSelect(select, branches, selected) {
  const local = branches.filter((b) => b.kind === 'local');
  const remote = branches.filter((b) => b.kind === 'remote');
  const group = (label, list) => (list.length
    ? h('optgroup', { label }, list.map((b) => h('option', { value: b.name, selected: b.name === selected }, b.name)))
    : null);
  select.replaceChildren(...[group('Local', local), group('Remote', remote)].filter(Boolean));
  select.disabled = branches.length === 0;
}

async function loadBranches({ fetch = false } = {}) {
  const repo = $('#repo').value.trim();
  const hint = $('#repo-hint');
  if (!repo) {
    hint.textContent = 'Enter the absolute path of a git repository.';
    return;
  }
  hint.textContent = fetch ? 'Fetching remotes...' : 'Loading branches...';
  hint.className = 'hint';
  try {
    const data = await api(`/api/branches?repo=${encodeURIComponent(repo)}${fetch ? '&fetch=1' : ''}`);
    $('#repo').value = data.repoPath;
    const otherThanDest = data.branches.find((b) => b.name !== data.defaultDest)?.name;
    fillBranchSelect($('#source'), data.branches, data.current && data.current !== data.defaultDest ? data.current : otherThanDest);
    fillBranchSelect($('#dest'), data.branches, data.defaultDest);
    $('#refresh-branches').disabled = false;
    hint.textContent = `${data.repo}: ${data.branches.length} branches${data.current ? `, on ${data.current}` : ''}${data.warning ? `. ${data.warning}` : ''}`;
  } catch (error) {
    hint.textContent = error.message;
    hint.className = 'error';
    for (const id of ['#source', '#dest']) {
      $(id).replaceChildren(h('option', {}, 'Load a repository first'));
      $(id).disabled = true;
    }
  }
}

// ---------- Form ----------

const changeType = () => document.querySelector('input[name="changeType"]:checked').value;
const brdMode = () => document.querySelector('input[name="brdMode"]:checked').value;

function syncBrdFields() {
  $('#brd-field').hidden = changeType() !== 'feature';
  $('#brd-upload').hidden = brdMode() !== 'file';
  $('#brd-text').hidden = brdMode() !== 'text';
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the BRD file'));
    reader.readAsDataURL(file);
  });
}

async function collectRequest() {
  const repoPath = $('#repo').value.trim();
  const source = $('#source').value;
  const dest = $('#dest').value;
  const description = $('#description').value.trim();
  if (!repoPath || $('#source').disabled) throw new Error('Load a repository and pick the branches first.');
  if (source === dest) throw new Error('Source and destination must be different branches.');
  if (!description) throw new Error('Describe what you fixed or changed.');

  const request = { repoPath, source, dest, changeType: changeType(), description, fetch: $('#fetch').checked };
  if (request.changeType === 'feature' && brdMode() === 'file') {
    const file = $('#brd-file').files[0];
    if (!file) throw new Error('Choose a BRD file, or select "No BRD".');
    if (file.size > MAX_BRD_BYTES) throw new Error('The BRD file is larger than 20 MB.');
    request.brd = { name: file.name, base64: await readFileBase64(file) };
  } else if (request.changeType === 'feature' && brdMode() === 'text') {
    const text = $('#brd-text').value.trim();
    if (!text) throw new Error('Paste the BRD text, or select "No BRD".');
    request.brd = { text };
  }
  return request;
}

async function submitReview(event) {
  event.preventDefault();
  const error = $('#form-error');
  error.textContent = '';
  const button = $('#run-btn');
  button.disabled = true;
  try {
    const request = await collectRequest();
    const { runId } = await api('/api/reviews', { method: 'POST', body: request });
    attachRun(runId, `${request.source} → ${request.dest}`);
  } catch (err) {
    error.textContent = err.message;
    button.disabled = !canRun();
  }
}

function setFormDisabled(disabled) {
  for (const el of $('#review-form').elements) {
    if (el.id === 'source' || el.id === 'dest') el.disabled = disabled || el.options.length === 0 || el.options[0]?.textContent === 'Load a repository first';
    else el.disabled = disabled;
  }
  if (!disabled) {
    $('#run-btn').disabled = !canRun();
    $('#refresh-branches').disabled = $('#source').disabled;
  }
}

// ---------- Running review ----------

function logLine(event) {
  const time = new Date(event.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const cls = event.type === 'note' ? 'note' : event.type === 'warning' ? 'warning' : event.type === 'error' ? 'error' : '';
  const log = $('#run-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(h('li', {}, h('time', {}, time), h('span', { class: cls }, event.text)));
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function showResult(entry) {
  const box = h('div', { class: `result ${VERDICT_CLASS[entry.verdict]}` },
    h('div', { class: 'result-top' },
      verdictBadge(entry.verdict),
      countChips(entry.counts),
      h('span', { class: 'muted' }, [formatCost(entry.costUsd), entry.durationMs ? formatDuration(entry.durationMs) : ''].filter(Boolean).join(' · '))),
    h('div', { class: 'result-actions' },
      h('a', { class: 'btn primary', href: withToken(`/api/history/${entry.id}/pdf`), target: '_blank', rel: 'noopener' }, 'View PDF'),
      h('a', { class: 'btn', href: withToken(`/api/history/${entry.id}/pdf?download=1`) }, 'Download'),
      h('button', { class: 'btn', type: 'button', onclick: () => openDetail(entry.id) }, 'Summary')));
  $('#run-result').replaceChildren(box);
  $('#run-result').hidden = false;
}

function finishRun(title) {
  clearInterval(state.run?.timer);
  state.run?.source?.close();
  $('#run-spinner').hidden = true;
  $('#run-title').textContent = title;
  $('#cancel-btn').hidden = true;
  $('#new-btn').hidden = false;
  setFormDisabled(false);
  state.run = null;
}

function attachRun(runId, label) {
  $('#run-panel').hidden = false;
  $('#run-log').replaceChildren();
  $('#run-result').hidden = true;
  $('#run-spinner').hidden = false;
  $('#run-title').textContent = `Reviewing ${label}`;
  $('#cancel-btn').hidden = false;
  $('#cancel-btn').disabled = false;
  $('#new-btn').hidden = true;
  setFormDisabled(true);

  const started = Date.now();
  const timer = setInterval(() => { $('#run-elapsed').textContent = formatDuration(Date.now() - started); }, 1000);
  const source = new EventSource(withToken(`/api/reviews/${runId}/events`));
  state.run = { id: runId, source, timer };

  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'done') {
      logLine({ ...event, text: 'Report saved' });
      showResult(event.entry);
      finishRun('Review complete');
      loadHistory();
    } else if (event.type === 'error') {
      logLine(event);
      $('#run-result').replaceChildren(h('div', { class: 'result failed' }, h('strong', {}, 'The review failed'), h('span', {}, event.text)));
      $('#run-result').hidden = false;
      finishRun('Review failed');
    } else if (event.type === 'cancelled') {
      logLine(event);
      finishRun('Review cancelled');
    } else {
      logLine(event);
    }
  };
  source.onerror = () => {
    if (state.run?.id === runId && source.readyState === EventSource.CLOSED) {
      logLine({ type: 'error', text: 'Lost connection to the server', at: new Date().toISOString() });
      finishRun('Connection lost');
    }
  };
}

async function cancelRun() {
  if (!state.run) return;
  $('#cancel-btn').disabled = true;
  try {
    await api(`/api/reviews/${state.run.id}/cancel`, { method: 'POST', body: {} });
  } catch (error) {
    logLine({ type: 'error', text: error.message, at: new Date().toISOString() });
  }
}

function resetForNewReview() {
  $('#run-panel').hidden = true;
  $('#description').value = '';
  $('#brd-file').value = '';
  $('#brd-text').value = '';
  $('#brd-file-label').textContent = 'Choose a PDF, Word (.docx), Markdown or text file, up to 20 MB';
  $('#description').focus();
}

// ---------- History ----------

async function loadHistory() {
  const params = new URLSearchParams();
  if ($('#h-repo').value) params.set('repo', $('#h-repo').value);
  if ($('#h-verdict').value) params.set('verdict', $('#h-verdict').value);
  if ($('#h-search').value.trim()) params.set('q', $('#h-search').value.trim());
  const { entries } = await api(`/api/history?${params}`);
  renderHistory(entries);
  if (!params.has('repo') && !params.has('verdict') && !params.has('q')) updateRepoFilter(entries);
}

function updateRepoFilter(entries) {
  const select = $('#h-repo');
  const current = select.value;
  const repos = [...new Set(entries.map((e) => e.repo))].sort();
  select.replaceChildren(h('option', { value: '' }, 'All repositories'), ...repos.map((r) => h('option', { value: r, selected: r === current }, r)));
}

function renderHistory(entries) {
  const rows = entries.map((e) => {
    const stop = (fn) => (event) => { event.stopPropagation(); fn(); };
    return h('tr', { onclick: () => openDetail(e.id), title: e.repoPath },
      h('td', { class: 'date' }, formatDate(e.createdAt)),
      h('td', {}, e.repo),
      h('td', { class: 'branches' }, e.source, ' ', h('span', { class: 'to' }, h('span', { class: 'arrow' }, '→'), e.dest)),
      h('td', { class: 'hide-sm' }, TYPE_LABEL[e.changeType] ?? e.changeType, e.hasBrd ? h('span', { class: 'tag', title: 'Checked against a BRD' }, 'BRD') : null,
        e.origin === 'chat' ? h('span', { class: 'tag', title: 'Run from Claude Code with /branch-review' }, 'chat') : null),
      h('td', {}, verdictBadge(e.verdict)),
      h('td', {}, countChips(e.counts)),
      h('td', { class: 'hide-sm num' }, formatCost(e.costUsd)),
      h('td', { class: 'row-actions' },
        e.pdfMissing ? h('span', { class: 'muted' }, 'PDF missing') : [
          h('a', { class: 'btn small', href: withToken(`/api/history/${e.id}/pdf`), target: '_blank', rel: 'noopener', onclick: (ev) => ev.stopPropagation() }, 'View'),
          h('a', { class: 'btn small', href: withToken(`/api/history/${e.id}/pdf?download=1`), onclick: (ev) => ev.stopPropagation() }, 'Download'),
        ],
        h('button', { class: 'btn small danger-ghost', type: 'button', onclick: stop(() => confirmDelete(e)) }, 'Delete')));
  });
  $('#h-table tbody').replaceChildren(...rows);
  $('#h-table').hidden = entries.length === 0;
  $('#h-empty').hidden = entries.length > 0;
}

function confirmDelete(entry) {
  const dialog = $('#confirm-dialog');
  $('#confirm-text').textContent = `Delete the review of ${entry.source} → ${entry.dest} (${entry.repo}, ${formatDate(entry.createdAt)})? The PDF and its data are removed from disk.`;
  dialog.returnValue = '';
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'confirm') return;
    try {
      await api(`/api/history/${entry.id}`, { method: 'DELETE' });
      await loadHistory();
    } catch (error) {
      showBanner('Could not delete the report', error.message, 'error');
    }
  };
  dialog.showModal();
}

async function openDetail(id) {
  const dialog = $('#detail-dialog');
  const body = $('#detail-body');
  body.replaceChildren(h('p', { class: 'muted' }, 'Loading...'));
  dialog.showModal();
  try {
    const { entry, report } = await api(`/api/history/${id}`);
    $('#detail-title').textContent = `${report.meta.source} → ${report.meta.dest}`;
    body.replaceChildren(...renderDetail(entry, report));
  } catch (error) {
    body.replaceChildren(h('p', { class: 'error' }, error.message));
  }
}

function renderDetail(entry, report) {
  const { meta, intentCheck: check } = report;
  const section = (title, ...children) => h('div', { class: 'detail-section' }, h('h4', {}, title), ...children);
  const findings = [...report.findings].sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
  return [
    h('div', { class: 'result-top' }, verdictBadge(report.verdict), countChips(entry.counts),
      h('a', { class: 'btn small', href: withToken(`/api/history/${entry.id}/pdf`), target: '_blank', rel: 'noopener' }, 'Open PDF')),
    h('div', { class: 'detail-meta' },
      h('span', {}, meta.repo),
      h('span', {}, formatDate(meta.createdAt)),
      h('span', {}, `${meta.commitCount} commits, ${meta.stats.files} files, +${meta.stats.insertions} / -${meta.stats.deletions}`),
      meta.model ? h('span', {}, meta.model) : null,
      meta.costUsd != null ? h('span', {}, formatCost(meta.costUsd)) : null),
    section('Summary', h('p', {}, report.summary)),
    section('What the author changed', h('p', {}, `${TYPE_LABEL[meta.changeType]}: ${meta.description}`)),
    section('Does the change do what was described?',
      h('p', {}, `Matches the description: ${ANSWER[check.matchesDescription]}. Root cause addressed: ${ANSWER[check.rootCauseAddressed]}. Tests added: ${check.testsAdded ? 'yes' : 'no'}.`),
      h('p', { class: 'muted' }, check.notes)),
    report.brd ? section(`BRD: ${report.brd.title}`,
      h('ul', { class: 'req-list' }, report.brd.requirements.map((r) =>
        h('li', {}, h('span', { class: `status ${r.status}` }, STATUS_LABEL[r.status]), h('span', {}, h('strong', {}, `${r.id} `), r.text)))),
      report.brd.outOfScopeChanges.length ? h('p', { class: 'muted' }, `Not traced to a requirement: ${report.brd.outOfScopeChanges.join('; ')}`) : null) : null,
    section(`Findings (${findings.length})`,
      findings.length === 0 ? h('p', { class: 'muted' }, 'No issues found.') : findings.map((f) =>
        h('div', { class: 'finding' },
          h('div', { class: 'finding-head' }, h('span', { class: `prio ${f.priority}` }, f.priority), h('strong', {}, f.title)),
          h('div', { class: 'finding-loc' }, `${f.line ? `${f.file}:${f.line}` : f.file} · ${f.category}`),
          h('p', {}, f.description),
          f.suggestion ? h('pre', { class: 'code' }, f.suggestion) : null))),
    section('Recommendation', h('p', {}, report.recommendation)),
  ];
}

// ---------- Settings ----------

const MODELS = ['default', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function openSettings() {
  const { config } = state.status;
  $('#cfg-model').replaceChildren(...MODELS.map((m) => h('option', { value: m, selected: m === config.model }, modelLabel(m))));
  $('#cfg-effort').replaceChildren(...EFFORTS.map((e) => h('option', { value: e, selected: e === config.effort }, e)));
  $('#cfg-budget').value = config.maxBudgetUsd ?? '';
  $('#cfg-home').textContent = '~/code-reviews (or $CODE_REVIEW_AGENT_HOME)';
  $('#settings-error').textContent = '';
  $('#settings-dialog').showModal();
}

async function saveSettings(event) {
  if (event.submitter?.value !== 'save') return;
  event.preventDefault();
  try {
    const config = await api('/api/config', {
      method: 'PUT',
      body: { model: $('#cfg-model').value, effort: $('#cfg-effort').value, maxBudgetUsd: $('#cfg-budget').value || null },
    });
    state.status.config = config;
    $('#model-pill').textContent = modelLabel(config.model);
    $('#settings-dialog').close();
  } catch (error) {
    $('#settings-error').textContent = error.message;
  }
}

// ---------- Init ----------

async function init() {
  state.token = initToken();
  if (!state.token) {
    showBanner('Open this page from the terminal link', 'Run `code-review-agent ui` and open the URL it prints. It includes an access token.', 'error');
    return;
  }

  $('#review-form').addEventListener('submit', submitReview);
  $('#load-branches').addEventListener('click', () => loadBranches());
  $('#refresh-branches').addEventListener('click', () => loadBranches({ fetch: true }));
  $('#repo').addEventListener('change', () => loadBranches());
  $('#repo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadBranches(); } });
  for (const input of document.querySelectorAll('input[name="changeType"], input[name="brdMode"]')) input.addEventListener('change', syncBrdFields);
  $('#brd-file').addEventListener('change', () => {
    const file = $('#brd-file').files[0];
    $('#brd-file-label').textContent = file ? `${file.name} (${(file.size / 1024).toFixed(0)} KB)` : 'Choose a PDF, Word (.docx), Markdown or text file, up to 20 MB';
  });
  $('#cancel-btn').addEventListener('click', cancelRun);
  $('#new-btn').addEventListener('click', resetForNewReview);
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-form').addEventListener('submit', saveSettings);
  for (const id of ['#h-repo', '#h-verdict']) $(id).addEventListener('change', loadHistory);
  $('#h-search').addEventListener('input', () => {
    clearTimeout(state.historyTimer);
    state.historyTimer = setTimeout(loadHistory, 200);
  });
  syncBrdFields();

  try {
    await loadStatus();
    const [repos] = await Promise.all([loadRecentRepos(), loadHistory()]);
    const startRepo = state.status.launchRepo ?? repos[0]?.repoPath;
    if (startRepo) {
      $('#repo').value = startRepo;
      await loadBranches();
    }
    const active = state.status.activeRun;
    if (active) attachRun(active.id, `${active.source} → ${active.dest}`);
  } catch (error) {
    showBanner('Could not reach the server', error.message, 'error');
  }
}

init();
