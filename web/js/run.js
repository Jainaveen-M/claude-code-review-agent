// Live review: phases, a file tree that lights up as Claude reads files, and an activity feed.
import { api, pdfUrl, withToken } from './api.js';
import { countChips, emptyState, fill, formatCost, formatDuration, h, icon, plural, toast, verdictBadge } from './dom.js';
import { resetForNewReview } from './wizard.js';

const PHASES = [
  { id: 'compare', label: 'Compare branches' },
  { id: 'brd', label: 'Read the BRD' },
  { id: 'review', label: 'Claude reviews' },
  { id: 'report', label: 'Build the report' },
];
const TOOL_ICON = { Read: 'eye', Bash: 'terminal', Grep: 'search', Glob: 'search', Skill: 'list', StructuredOutput: 'doc' };

function groupByDir(files) {
  const dirs = new Map();
  for (const f of files) {
    const cut = f.path.lastIndexOf('/');
    const dir = cut > 0 ? f.path.slice(0, cut) : '';
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push({ ...f, name: f.path.slice(cut + 1) });
  }
  return [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function render(container, { id }) {
  const view = {
    info: null,
    phase: null,
    done: new Set(),
    failed: false,
    finished: false,
    files: new Map(), // path -> li
    read: new Set(),
    context: new Set(),
    active: null,
    started: Date.now(),
  };

  const elapsed = h('span', { class: 'elapsed' });
  const spinner = h('span', { class: 'spinner' });
  const title = h('h1', {}, 'Starting review…');
  const repoLine = h('div', { class: 'hint' });
  const cancel = h('button', { type: 'button', class: 'btn danger-ghost', onclick: () => cancelRun() }, icon('x', 15), 'Cancel');
  const again = h('a', { class: 'btn', href: '#/new', hidden: true }, icon('play', 15), 'New review');
  const result = h('div', { hidden: true });
  const phases = h('ol', { class: 'phases' });
  const progress = h('span', { style: { width: '0%' } });
  const progressText = h('span', { class: 'hint' }, 'Waiting for the file list…');
  const tree = h('ul', { class: 'file-tree' });
  const contextLine = h('p', { class: 'hint', hidden: true });
  const activity = h('ol', { class: 'activity', 'aria-live': 'polite' });

  fill(container, 
    h('div', { class: 'run-head' },
      h('div', { class: 'title' }, spinner, h('div', {}, title, repoLine)),
      h('div', { class: 'chips' }, elapsed, cancel, again)),
    result,
    phases,
    h('div', { class: 'run-grid' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Changed files'), progressText),
        h('div', { class: 'progress-bar' }, progress),
        tree,
        contextLine),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Activity')),
        activity)),
  );

  const timer = setInterval(() => {
    if (!view.finished) elapsed.textContent = formatDuration(Date.now() - view.started);
  }, 1000);

  function drawPhases() {
    const list = PHASES.filter((p) => p.id !== 'brd' || view.info?.hasBrd);
    fill(phases, ...list.map((p) => {
      const state = view.done.has(p.id) ? 'done' : p.id === view.phase ? (view.failed ? 'failed' : 'active') : '';
      return h('li', { class: `phase ${state}` },
        h('span', { class: 'pdot' }, state === 'done' ? icon('check', 11) : state === 'failed' ? icon('x', 11) : null),
        p.label);
    }));
  }

  function setPhase(phase) {
    if (view.phase && view.phase !== phase) view.done.add(view.phase);
    view.phase = phase;
    drawPhases();
  }

  function drawProgress() {
    const total = view.files.size;
    const read = [...view.read].filter((p) => view.files.has(p)).length;
    progress.style.width = total ? `${Math.round((read / total) * 100)}%` : '0%';
    progressText.textContent = total ? `Read ${read} of ${plural(total, 'file')}` : 'Waiting for the file list…';
    contextLine.hidden = view.context.size === 0;
    contextLine.textContent = `Also read ${plural(view.context.size, 'other file')} for context`;
  }

  function buildTree(files) {
    view.files.clear();
    const items = [];
    for (const [dir, list] of groupByDir(files)) {
      items.push(h('li', { class: 'ft-dir' }, icon('folder', 13), dir || '(root)'));
      for (const f of list) {
        const li = h('li', { class: 'ft-file', title: f.path },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          h('span', { class: 'fname' }, f.name),
          h('span', { class: 'fnum' }, f.binary ? 'bin' : [h('span', { class: 'a' }, `+${f.insertions}`), ' ', h('span', { class: 'd' }, `−${f.deletions}`)]));
        view.files.set(f.path, li);
        items.push(li);
      }
    }
    fill(tree, ...items);
    drawProgress();
  }

  function markFile(path) {
    if (view.active && view.active !== path) {
      view.files.get(view.active)?.classList.replace('active', 'read');
    }
    view.read.add(path);
    const li = view.files.get(path);
    if (li) {
      li.classList.remove('read');
      li.classList.add('active');
      li.scrollIntoView({ block: 'nearest' });
      view.active = path;
    } else {
      view.context.add(path);
      view.active = null;
    }
    drawProgress();
  }

  function log(event) {
    const kind = event.type === 'note' ? 'note' : event.type === 'warning' ? 'warning' : event.type === 'error' ? 'error' : '';
    const iconName = event.type === 'note' ? 'message' : event.type === 'warning' || event.type === 'error' ? 'alert' : TOOL_ICON[event.tool] ?? 'clock';
    const nearBottom = activity.scrollHeight - activity.scrollTop - activity.clientHeight < 60;
    activity.append(h('li', { class: kind },
      h('span', { class: 'aicon' }, icon(iconName, 14)),
      h('span', { class: 'atext' }, event.text),
      h('time', {}, new Date(event.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))));
    if (nearBottom) activity.scrollTop = activity.scrollHeight;
  }

  function finish() {
    view.finished = true;
    spinner.replaceWith(h('span', { class: 'repo-avatar' }, icon(view.failed ? 'alert' : 'check', 18)));
    cancel.hidden = true;
    again.hidden = false;
    if (view.active) view.files.get(view.active)?.classList.replace('active', 'read');
    clearInterval(timer);
  }

  function showDone(entry) {
    for (const p of PHASES) view.done.add(p.id);
    view.phase = null;
    drawPhases();
    finish();
    title.textContent = `${entry.source} → ${entry.dest}`;
    result.hidden = false;
    fill(result, h('div', { class: `result-card ${entry.verdict}` },
      verdictBadge(entry.verdict, true),
      h('div', { class: 'grow' },
        h('strong', {}, 'Review complete'),
        h('div', { class: 'chips' }, countChips(entry.counts), h('span', { class: 'hint' }, [formatCost(entry.costUsd), entry.durationMs ? formatDuration(entry.durationMs) : ''].filter(Boolean).join(' · ')))),
      h('div', { class: 'chips' },
        h('a', { class: 'btn primary', href: `#/report/${entry.id}` }, 'Open report', icon('arrow-right', 15)),
        h('a', { class: 'btn', href: pdfUrl(entry.id), target: '_blank', rel: 'noopener' }, icon('external', 14), 'PDF'),
        h('a', { class: 'btn', href: pdfUrl(entry.id, true) }, icon('download', 14), 'Download'))));
    resetForNewReview();
    toast('Review complete');
  }

  function showFailure(text, cancelled) {
    view.failed = !cancelled;
    drawPhases();
    finish();
    result.hidden = false;
    fill(result, h('div', { class: 'result-card failed' },
      icon('alert', 22),
      h('div', { class: 'grow' }, h('strong', {}, cancelled ? 'Review cancelled' : 'The review failed'), h('span', {}, text)),
      h('a', { class: 'btn', href: '#/new' }, cancelled ? 'Back to setup' : 'Fix and try again')));
  }

  async function cancelRun() {
    cancel.disabled = true;
    try {
      await api(`/api/reviews/${id}/cancel`, { method: 'POST', body: {} });
    } catch (error) {
      log({ type: 'error', text: error.message, at: new Date().toISOString() });
      cancel.disabled = false;
    }
  }

  function handle(event) {
    // The server ends the stream after a final event; stop EventSource from reconnecting and replaying it.
    if (['done', 'error', 'cancelled'].includes(event.type)) source?.close();
    switch (event.type) {
      case 'phase':
        setPhase(event.phase);
        break;
      case 'facts':
        buildTree(event.facts.filesChanged);
        break;
      case 'progress':
        if (event.file) markFile(event.file);
        log(event);
        break;
      case 'done':
        log({ ...event, text: 'Report saved' });
        showDone(event.entry);
        break;
      case 'error':
        log(event);
        showFailure(event.text, false);
        break;
      case 'cancelled':
        log(event);
        showFailure('You stopped this review.', true);
        break;
      default:
        log(event);
    }
  }

  let source = null;
  api(`/api/reviews/${id}`)
    .then((info) => {
      view.info = info;
      view.started = new Date(info.startedAt).getTime();
      title.textContent = `${info.source} → ${info.dest}`;
      repoLine.textContent = info.repoPath;
      drawPhases();
      source = new EventSource(withToken(`/api/reviews/${id}/events`));
      source.onmessage = (message) => handle(JSON.parse(message.data));
      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED && !view.finished) showFailure('Lost the connection to the server.', false);
      };
    })
    .catch((error) => {
      clearInterval(timer);
      fill(container, h('section', { class: 'card' }, emptyState('clock', 'Review not found', error.message,
        h('div', { class: 'chips' }, h('a', { class: 'btn primary', href: '#/history' }, 'Open history'), h('a', { class: 'btn', href: '#/new' }, 'New review')))));
    });

  return () => {
    source?.close();
    clearInterval(timer);
  };
}
