// Interactive report: overview, code with inline findings, and the BRD checklist.
import { api, apiText, pdfUrl } from './api.js';
import { ANSWER, PRIORITIES, STATUS_LABEL, TYPE_LABEL, confirmDialog, countChips, emptyState, fill, findingLocation, formatCost, formatDate, formatDuration, h, icon, plural, priorityChip, shortSha, statusBadge, toast, verdictBadge } from './dom.js';
import { diffViewer, parseDiff } from './diff.js';

const STATUSES = ['missing', 'partial', 'implemented', 'not_verifiable'];

/** "src/a.js:42" -> { file, line } */
function parseEvidence(text) {
  const m = String(text).match(/^(.*?):(\d+)(?:-\d+)?$/);
  return m ? { file: m[1], line: Number(m[2]) } : { file: String(text), line: null };
}

function checkRow(label, value) {
  const cls = value === 'yes' ? 'yes' : value === 'no' ? 'no' : value === 'not_applicable' ? 'na' : value;
  const sym = value === 'yes' ? icon('check', 14) : value === 'no' ? icon('x', 14) : value === 'not_applicable' ? icon('dots', 14) : icon('alert', 13);
  return h('div', { class: 'check-row' }, h('span', { class: `ci ${cls}` }, sym), h('span', { class: 'cl' }, label), h('span', { class: 'cv' }, ANSWER[value] ?? value));
}

export function render(container, { id, tab = 'overview' }) {
  let alive = true;
  fill(container, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), 'Loading report…'));

  api(`/api/history/${id}`).then(({ entry, report }) => {
    if (!alive) return;
    const { meta } = report;
    const panels = {};
    let current = null;
    let viewer = null;
    let viewerPromise = null;

    // ---------- Header ----------
    const head = h('div', { class: 'report-head' },
      h('div', { class: 'crumb' }, h('a', { href: '#/history' }, 'History'), icon('chevron-right', 12), meta.repo),
      h('div', { class: 'report-title' },
        verdictBadge(report.verdict, true),
        h('h1', {}, `${meta.source} → ${meta.dest}`),
        h('div', { class: 'report-actions' },
          h('a', { class: 'btn', href: pdfUrl(id), target: '_blank', rel: 'noopener' }, icon('external', 14), 'PDF'),
          h('a', { class: 'btn', href: pdfUrl(id, true) }, icon('download', 14), 'Download'),
          h('button', {
            type: 'button',
            class: 'btn danger-ghost',
            onclick: async () => {
              const ok = await confirmDialog({ title: 'Delete this report?', text: `The PDF and data for ${meta.source} → ${meta.dest} (${formatDate(meta.createdAt)}) will be removed from disk.` });
              if (!ok) return;
              await api(`/api/history/${id}`, { method: 'DELETE' });
              toast('Report deleted');
              location.hash = '#/history';
            },
          }, icon('trash', 14), 'Delete'))),
      h('div', { class: 'report-meta' },
        h('span', {}, icon('folder', 13), meta.repo),
        h('span', {}, icon('clock', 13), formatDate(meta.createdAt)),
        h('span', {}, TYPE_LABEL[meta.changeType]),
        h('span', {}, `${plural(meta.commitCount, 'commit')}, ${plural(meta.stats.files, 'file')}, +${meta.stats.insertions} −${meta.stats.deletions}`),
        h('span', {}, `Confidence: ${report.confidence.toLowerCase()}`),
        meta.origin === 'chat' ? h('span', { class: 'tag' }, 'from chat') : null),
      countChips(entry.counts));

    // ---------- Tabs ----------
    const tabs = [
      { id: 'overview', label: 'Overview', iconName: 'info' },
      { id: 'code', label: 'Code & findings', iconName: 'code', count: report.findings.length },
      ...(report.brd ? [{ id: 'brd', label: 'BRD checklist', iconName: 'list', count: report.brd.requirements.length }] : []),
    ];
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    const panelHost = h('div', {});

    function select(tabId) {
      if (!tabs.some((t) => t.id === tabId)) tabId = 'overview';
      current = tabId;
      fill(tabBar, ...tabs.map((t) => h('button', {
        type: 'button',
        class: 'tab',
        role: 'tab',
        'aria-selected': t.id === tabId ? 'true' : 'false',
        onclick: () => select(t.id),
      }, icon(t.iconName, 14), t.label, t.count != null ? h('span', { class: 'count' }, String(t.count)) : null)));
      panels[tabId] ??= build(tabId);
      fill(panelHost, panels[tabId]);
      history.replaceState(null, '', `#/report/${id}${tabId === 'overview' ? '' : `/${tabId}`}`);
    }

    function openCode(then) {
      select('code');
      viewerPromise?.then((v) => v && then?.(v));
    }

    function build(tabId) {
      if (tabId === 'code') return codePanel();
      if (tabId === 'brd') return brdPanel();
      return overviewPanel();
    }

    // ---------- Overview ----------
    function overviewPanel() {
      const check = report.intentCheck;
      const top = [...report.findings].sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)).slice(0, 6);
      const brd = report.brd;
      const tally = brd ? Object.fromEntries(STATUSES.map((s) => [s, brd.requirements.filter((r) => r.status === s).length])) : null;
      return h('div', { class: 'overview' },
        h('div', { class: 'stack' },
          h('section', { class: 'card prose' },
            h('h3', {}, 'Summary'),
            h('p', {}, report.summary),
            h('div', { class: 'recommendation' }, h('strong', {}, 'Recommendation'), h('p', {}, report.recommendation))),
          h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Top findings'),
              report.findings.length ? h('button', { type: 'button', class: 'link', onclick: () => openCode() }, 'See all in the code') : null),
            top.length ? h('ul', { class: 'top-findings' }, top.map((f) => h('li', {},
              h('button', { type: 'button', onclick: () => openCode((v) => v.focusFinding(f)) },
                priorityChip(f.priority),
                h('span', { class: 'tf-title' }, f.title),
                h('span', { class: 'tf-loc' }, findingLocation(f))))))
              : emptyState('check', 'No issues found', 'Nothing in the changed code needs fixing.')),
          h('section', { class: 'card prose' },
            h('h3', {}, 'What the author changed'),
            h('div', { class: 'quote' }, meta.description))),
        h('div', { class: 'stack' },
          h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Does the change do what was described?')),
            h('div', { class: 'check-rows' },
              checkRow('Matches the description', check.matchesDescription),
              meta.changeType === 'bugfix' || check.rootCauseAddressed !== 'not_applicable' ? checkRow('Root cause addressed', check.rootCauseAddressed) : null,
              checkRow('Tests added or updated', check.testsAdded ? 'yes' : 'no')),
            h('p', { class: 'hint', style: { marginTop: '12px' } }, check.notes)),
          brd ? h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'BRD coverage'), h('button', { type: 'button', class: 'link', onclick: () => select('brd') }, 'Open checklist')),
            meter(tally),
            h('p', { class: 'hint', style: { marginTop: '8px' } }, `${tally.implemented} of ${brd.requirements.length} implemented, ${tally.partial} partial, ${tally.missing} missing`)) : null,
          h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, `Commits (${meta.commitCount})`)),
            h('ul', { class: 'commit-list' }, meta.commits.slice(0, 12).map((c) => h('li', {}, h('span', { class: 'sha' }, shortSha(c.sha)), h('span', { class: 'subj', title: c.subject }, c.subject)))),
            meta.commitCount > 12 ? h('div', { class: 'more' }, `+ ${meta.commitCount - 12} more`) : null),
          h('section', { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Run details')),
            h('div', { class: 'check-rows' },
              h('div', { class: 'check-row' }, h('span', { class: 'cl muted' }, 'Model'), h('span', {}, meta.model ?? (meta.origin === 'chat' ? 'Claude Code chat' : '—'))),
              meta.costUsd != null ? h('div', { class: 'check-row' }, h('span', { class: 'cl muted' }, 'Estimated cost'), h('span', {}, formatCost(meta.costUsd))) : null,
              meta.durationMs != null ? h('div', { class: 'check-row' }, h('span', { class: 'cl muted' }, 'Duration'), h('span', {}, formatDuration(meta.durationMs))) : null,
              h('div', { class: 'check-row' }, h('span', { class: 'cl muted' }, 'Merge base'), h('span', { class: 'mono' }, shortSha(meta.mergeBase))),
              h('div', { class: 'check-row' }, h('span', { class: 'cl muted' }, 'Source commit'), h('span', { class: 'mono' }, shortSha(meta.sourceSha)))))));
    }

    function meter(tally) {
      return h('div', { class: 'meter', role: 'img', 'aria-label': STATUSES.map((s) => `${tally[s]} ${STATUS_LABEL[s].toLowerCase()}`).join(', ') },
        STATUSES.filter((s) => tally[s]).map((s) => h('span', { class: s, title: `${STATUS_LABEL[s]}: ${tally[s]}`, style: { flexGrow: String(tally[s]) } })));
    }

    // ---------- Code ----------
    function codePanel() {
      const panel = h('div', {}, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), 'Loading the code…'));
      viewerPromise = apiText(`/api/history/${id}/diff`)
        .then((text) => {
          const files = parseDiff(text);
          viewer = diffViewer({ files, findings: report.findings, truncated: /\n# diff truncated\n?$/.test(text) });
          fill(panel, viewer.el);
          return viewer;
        })
        .catch((error) => {
          fill(panel, h('section', { class: 'card' },
            emptyState('code', 'The code is not available', error.message),
            h('ul', { class: 'top-findings' }, report.findings.map((f) => h('li', {}, h('div', { class: 'dv-note' },
              h('div', { class: 'dv-note-head' }, priorityChip(f.priority), h('strong', {}, f.title), h('span', { class: 'tag' }, findingLocation(f))),
              h('p', {}, f.description),
              f.suggestion ? h('pre', {}, f.suggestion) : null))))));
          return null;
        });
      return panel;
    }

    // ---------- BRD ----------
    function brdPanel() {
      const brd = report.brd;
      const tally = Object.fromEntries(STATUSES.map((s) => [s, brd.requirements.filter((r) => r.status === s).length]));
      let filter = 'all';
      const list = h('ul', { class: 'req-list' });
      const chips = h('div', { class: 'chips' });
      const total = brd.requirements.length;
      const pct = total ? Math.round(((tally.implemented + tally.partial * 0.5) / total) * 100) : 0;

      function draw() {
        fill(chips, ...[['all', 'All', total], ...STATUSES.map((s) => [s, STATUS_LABEL[s], tally[s]])].map(([key, label, n]) => h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': filter === key ? 'true' : 'false',
          disabled: n === 0 && key !== 'all',
          onclick: () => { filter = key; draw(); },
        }, label, h('span', { class: 'count' }, String(n)))));
        const items = brd.requirements.filter((r) => filter === 'all' || r.status === filter);
        fill(list, ...items.map((r) => h('li', {},
          h('details', { class: 'req', open: r.status === 'missing' || r.status === 'partial' ? true : null },
            h('summary', {}, h('span', { class: 'chev' }, icon('chevron-right', 14)), h('span', { class: 'rid' }, r.id), h('span', { class: 'rtext' }, r.text), statusBadge(r.status)),
            h('div', { class: 'req-body' },
              r.notes ? h('p', {}, r.notes) : null,
              r.evidence.length
                ? h('div', { class: 'evidence' }, h('span', { class: 'hint' }, 'Evidence:'), r.evidence.map((ev) => {
                  const { file, line } = parseEvidence(ev);
                  return h('button', { type: 'button', class: 'chip', title: 'Show in the code', onclick: () => openCode((v) => v.jumpTo(file, line)) }, icon('code', 12), ev);
                }))
                : h('p', { class: 'hint' }, 'No code evidence cited.'))))),
        items.length === 0 ? h('li', { class: 'hint' }, 'No requirements with this status.') : null);
      }
      draw();

      return h('div', { class: 'stack' },
        h('section', { class: 'card' },
          h('div', { class: 'coverage' },
            h('div', { class: 'coverage-top' }, h('span', { class: 'big' }, `${pct}%`), h('span', { class: 'muted' }, `of the BRD is covered · ${brd.title}`)),
            meter(tally),
            h('div', { class: 'legend' }, STATUSES.map((s) => h('span', { class: 'chips' }, statusBadge(s), h('span', { class: 'hint' }, String(tally[s])))))),
          chips),
        h('section', { class: 'card' }, list),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, 'Changes not traced to any requirement')),
          brd.outOfScopeChanges.length ? h('ul', { class: 'tips' }, brd.outOfScopeChanges.map((c) => h('li', {}, c))) : h('p', { class: 'hint' }, 'None. Every change traces back to a requirement.')));
    }

    fill(container, head, tabBar, panelHost);
    select(tab);
  }).catch((error) => {
    if (!alive) return;
    fill(container, h('section', { class: 'card' }, emptyState('doc', 'Report not found', error.message, h('a', { class: 'btn primary', href: '#/history' }, 'Open history'))));
  });

  return () => { alive = false; };
}
