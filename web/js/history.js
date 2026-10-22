// History dashboard: filters, KPI tiles, charts and the review table, all on one filtered slice.
import { api, pdfUrl } from './api.js';
import { PRIORITIES, PRIORITY_LABEL, TYPE_LABEL, VERDICT_LABEL, VERDICTS, confirmDialog, countChips, emptyState, fill, formatCost, formatDate, h, icon, plural, priorityChip, toast, verdictBadge } from './dom.js';
import { horizontalBars, stackedColumns } from './charts.js';

const RANGES = [['all', 'All time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']];
const VERDICT_COLOR = { APPROVE: 'var(--mark-approve)', NEEDS_DISCUSSION: 'var(--mark-discuss)', REQUEST_CHANGES: 'var(--mark-changes)' };
const MAX_REPO_BARS = 8;
const DAY = 86_400_000;

const filters = { range: 'all', repo: '', verdict: '', priority: '', q: '' };

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d) => { const s = startOfDay(d); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); return s; };
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

function applyFilters(entries) {
  const since = filters.range === 'all' ? 0 : Date.now() - Number(filters.range) * DAY;
  const needle = filters.q.trim().toLowerCase();
  return entries.filter((e) => new Date(e.createdAt).getTime() >= since
    && (!filters.repo || e.repo === filters.repo)
    && (!filters.verdict || e.verdict === filters.verdict)
    && (!filters.priority || e.counts[filters.priority] > 0)
    && (!needle || `${e.repo} ${e.source} ${e.dest}`.toLowerCase().includes(needle)));
}

/** Continuous day/week/month buckets covering the entries (or the chosen range). */
function timeBuckets(entries) {
  const now = new Date();
  const first = entries.length ? new Date(Math.min(...entries.map((e) => new Date(e.createdAt).getTime()))) : now;
  const rangeStart = filters.range === 'all' ? first : new Date(Date.now() - Number(filters.range) * DAY);
  const span = (now - rangeStart) / DAY;
  const unit = span <= 21 ? 'day' : span <= 150 ? 'week' : 'month';
  const floor = unit === 'day' ? startOfDay : unit === 'week' ? startOfWeek : startOfMonth;
  let cursor = floor(unit === 'day' ? new Date(Math.min(rangeStart, now - 6 * DAY)) : rangeStart);
  const end = floor(now);
  const buckets = [];
  const index = new Map();
  while (cursor <= end) {
    const label = unit === 'month'
      ? cursor.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
      : cursor.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const bucket = { label, title: unit === 'week' ? `Week of ${label}` : label, values: {} };
    index.set(cursor.getTime(), bucket);
    buckets.push(bucket);
    cursor = unit === 'day' ? new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
      : unit === 'week' ? new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7)
        : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  for (const e of entries) {
    const bucket = index.get(floor(new Date(e.createdAt)).getTime());
    if (bucket) bucket.values[e.verdict] = (bucket.values[e.verdict] ?? 0) + 1;
  }
  return { buckets, unit };
}

export function render(container) {
  let all = [];
  let alive = true;

  const set = (key, value) => {
    filters[key] = filters[key] === value ? '' : value;
    draw();
  };

  function filterRow() {
    const select = (key, options, label) => {
      const el = h('select', { 'aria-label': label, onchange: (e) => { filters[key] = e.target.value; draw(); } },
        options.map(([value, text]) => h('option', { value, selected: filters[key] === value }, text)));
      return el;
    };
    const repos = [...new Set(all.map((e) => e.repo))].sort();
    const search = h('input', { type: 'search', placeholder: 'Search branches', value: filters.q, 'aria-label': 'Search branches' });
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { filters.q = search.value; drawBody(); }, 200);
    });
    return h('div', { class: 'filter-row' },
      select('range', RANGES, 'Date range'),
      select('repo', [['', 'All repositories'], ...repos.map((r) => [r, r])], 'Repository'),
      select('verdict', [['', 'All verdicts'], ...VERDICTS.map((v) => [v, VERDICT_LABEL[v]])], 'Verdict'),
      search);
  }

  function activeFilters() {
    const chips = [];
    const chip = (text, key) => chips.push(h('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', title: 'Remove filter', onclick: () => { filters[key] = key === 'range' ? 'all' : ''; draw(); } }, text, icon('x', 12)));
    if (filters.range !== 'all') chip(RANGES.find(([v]) => v === filters.range)[1], 'range');
    if (filters.repo) chip(`Repository: ${filters.repo}`, 'repo');
    if (filters.verdict) chip(`Verdict: ${VERDICT_LABEL[filters.verdict]}`, 'verdict');
    if (filters.priority) chip(`Has ${filters.priority} ${PRIORITY_LABEL[filters.priority].toLowerCase()} findings`, 'priority');
    if (filters.q.trim()) chip(`Search: ${filters.q.trim()}`, 'q');
    return h('div', { class: 'active-filters' },
      chips.length ? [h('span', { class: 'label' }, 'Filtered by'), chips, h('button', { type: 'button', class: 'link', onclick: () => { Object.assign(filters, { range: 'all', repo: '', verdict: '', priority: '', q: '' }); draw(); } }, 'Clear all')]
        : h('span', { class: 'label' }, 'Tip: click a bar or legend entry to filter everything on this page.'));
  }

  function kpis(entries) {
    const n = entries.length;
    const approved = entries.filter((e) => e.verdict === 'APPROVE').length;
    const serious = entries.reduce((sum, e) => sum + e.counts.P0 + e.counts.P1, 0);
    const withSerious = entries.filter((e) => e.counts.P0 + e.counts.P1 > 0).length;
    const costed = entries.filter((e) => e.costUsd != null);
    const cost = costed.reduce((sum, e) => sum + e.costUsd, 0);
    const tile = (label, value, sub) => h('section', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
    return h('div', { class: 'kpis' },
      tile('Reviews', String(n), `across ${plural(new Set(entries.map((e) => e.repo)).size, 'repository', 'repositories')}`),
      tile('Approved', n ? `${Math.round((approved / n) * 100)}%` : '—', `${approved} of ${n} reviews`),
      tile('Critical and major findings', String(serious), `in ${plural(withSerious, 'review')}`),
      tile('Estimated cost', costed.length ? formatCost(cost) : '—', costed.length ? `${plural(costed.length, 'UI review')} · API-equivalent` : 'No cost data yet'));
  }

  function charts(entries) {
    const { buckets, unit } = timeBuckets(entries);
    const findingRows = PRIORITIES.map((p) => ({
      key: p,
      title: `${p} ${PRIORITY_LABEL[p]}`,
      label: h('span', { class: 'prio-label' }, priorityChip(p), PRIORITY_LABEL[p]),
      value: entries.reduce((sum, e) => sum + e.counts[p], 0),
    }));
    const repoCounts = [...entries.reduce((m, e) => m.set(e.repo, (m.get(e.repo) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
    const repoRows = repoCounts.slice(0, MAX_REPO_BARS).map(([repo, value]) => ({ key: repo, title: repo, label: repo, value }));
    if (repoCounts.length > MAX_REPO_BARS) {
      repoRows.push({ key: '__other', title: 'Other', label: `Other (${repoCounts.length - MAX_REPO_BARS})`, value: repoCounts.slice(MAX_REPO_BARS).reduce((n, [, v]) => n + v, 0) });
    }
    return h('div', { class: 'charts' },
      h('section', { class: 'card chart-card wide' },
        h('h3', {}, `Reviews per ${unit}, by verdict`),
        stackedColumns({
          buckets,
          series: VERDICTS.map((v) => ({ key: v, label: VERDICT_LABEL[v], color: VERDICT_COLOR[v] })),
          selected: filters.verdict,
          onSelect: (v) => set('verdict', v),
        })),
      h('section', { class: 'card chart-card' },
        h('h3', {}, 'Findings by priority'),
        horizontalBars({ rows: findingRows, color: 'var(--series-1)', unit: 'findings', valueHead: 'Findings', selected: filters.priority, onSelect: (p) => set('priority', p) })),
      h('section', { class: 'card chart-card' },
        h('h3', {}, 'Reviews by repository'),
        horizontalBars({ rows: repoRows, color: 'var(--series-1)', unit: 'reviews', valueHead: 'Reviews', selected: filters.repo, onSelect: (r) => r !== '__other' && set('repo', r) })));
  }

  function table(entries) {
    const rows = entries.map((e) => h('tr', { onclick: () => { location.hash = `#/report/${e.id}`; }, title: e.repoPath },
      h('td', { class: 'date' }, formatDate(e.createdAt)),
      h('td', {}, e.repo),
      h('td', { class: 'branches' }, e.source, ' ', h('span', { class: 'to' }, h('span', { class: 'arrow' }, '→'), e.dest)),
      h('td', { class: 'hide-sm' }, TYPE_LABEL[e.changeType] ?? e.changeType, ' ',
        e.hasBrd ? h('span', { class: 'tag', title: 'Checked against a BRD' }, 'BRD') : null, ' ',
        e.origin === 'chat' ? h('span', { class: 'tag', title: 'Run from Claude Code with /branch-review' }, 'chat') : null),
      h('td', {}, verdictBadge(e.verdict)),
      h('td', {}, countChips(e.counts)),
      h('td', { class: 'hide-sm num' }, formatCost(e.costUsd)),
      h('td', { class: 'row-actions' },
        e.pdfMissing ? h('span', { class: 'muted' }, 'PDF missing') : h('a', { class: 'btn small', href: pdfUrl(e.id), target: '_blank', rel: 'noopener', onclick: (ev) => ev.stopPropagation() }, 'PDF'),
        h('button', {
          type: 'button',
          class: 'btn small danger-ghost',
          onclick: async (ev) => {
            ev.stopPropagation();
            const ok = await confirmDialog({ title: 'Delete this report?', text: `The PDF and data for ${e.source} → ${e.dest} (${e.repo}, ${formatDate(e.createdAt)}) will be removed from disk.` });
            if (!ok) return;
            await api(`/api/history/${e.id}`, { method: 'DELETE' });
            toast('Report deleted');
            load();
          },
        }, 'Delete'))));
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, `Reviews (${entries.length})`)),
      entries.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'rows' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Repository'), h('th', {}, 'Branches'), h('th', { class: 'hide-sm' }, 'Type'), h('th', {}, 'Verdict'), h('th', {}, 'Findings'),
            h('th', { class: 'hide-sm num', title: 'API-equivalent cost reported by Claude Code; on a subscription an estimate, not a charge' }, 'Est. cost'), h('th', { class: 'actions-col' }, h('span', { class: 'visually-hidden' }, 'Actions')))),
          h('tbody', {}, rows)))
        : emptyState('search', 'No reviews match these filters', null, h('button', { type: 'button', class: 'btn', onclick: () => { Object.assign(filters, { range: 'all', repo: '', verdict: '', priority: '', q: '' }); draw(); } }, 'Clear filters')));
  }

  const body = h('div', {});
  function drawBody() {
    const entries = applyFilters(all);
    fill(body, activeFilters(), kpis(entries), charts(entries), table(entries));
  }

  function draw() {
    if (!alive) return;
    if (all.length === 0) {
      fill(container, 
        h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'History'))),
        h('section', { class: 'card' }, emptyState('chart', 'No reviews yet', 'Run your first review, or use /branch-review in Claude Code. Reports show up here.', h('a', { class: 'btn primary', href: '#/new' }, 'New review'))));
      return;
    }
    fill(container, 
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, 'History'), h('p', {}, `${plural(all.length, 'review')} saved in ~/code-reviews`)),
        h('a', { class: 'btn primary', href: '#/new' }, icon('play', 15), 'New review')),
      filterRow(),
      body);
    drawBody();
  }

  async function load() {
    try {
      ({ entries: all } = await api('/api/history'));
      draw();
    } catch (error) {
      fill(container, h('section', { class: 'card' }, emptyState('alert', 'Could not load history', error.message)));
    }
  }

  fill(container, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), 'Loading history…'));
  load();
  return () => { alive = false; };
}
