// Unified diff parser and an interactive viewer with findings pinned to their lines.
import { PRIORITIES, PRIORITY_LABEL, fill, findingLocation, h, icon, plural, priorityChip, toast } from './dom.js';

const BIG_FILE_LINES = 1500;
const AUTO_EXPAND_LINES = 2500;

/** Parse `git diff` output into files -> hunks -> lines with old/new line numbers. */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = { path: m ? m[2] : line.slice(11), oldPath: m ? m[1] : null, status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0, lineCount: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); }
      else if (line.startsWith('rename to ')) file.path = line.slice(10);
      else if (line.startsWith('Binary files ')) file.binary = true;
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = line.slice(4).replace(/^b\//, '');
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (!m) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const sign = line[0];
    if (sign === '+') {
      hunk.lines.push({ type: 'add', newNo: newNo++, text: line.slice(1) });
      file.additions += 1;
    } else if (sign === '-') {
      hunk.lines.push({ type: 'del', oldNo: oldNo++, text: line.slice(1) });
      file.deletions += 1;
    } else if (sign === ' ') {
      hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    } else if (sign === '\\') {
      hunk.lines.push({ type: 'meta', text: line });
    }
  }
  for (const f of files) f.lineCount = f.hunks.reduce((n, hk) => n + hk.lines.length + 1, 0);
  return files;
}

const normalize = (p) => String(p ?? '').replace(/^\.?\//, '');

function matchFile(files, path) {
  const target = normalize(path);
  return files.find((f) => f.path === target || f.oldPath === target)
    ?? files.find((f) => f.path.endsWith(`/${target}`) || target.endsWith(`/${f.path}`))
    ?? null;
}

/**
 * Build the viewer. Returns { el, jumpTo(file, line), focusFinding(finding) }.
 * `findings` are the report's findings; each is placed under its line in the source version.
 */
export function diffViewer({ files, findings, truncated }) {
  const ordered = [...findings].sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
  const byFile = new Map(files.map((f) => [f, []]));
  const outside = [];
  for (const finding of ordered) {
    const file = matchFile(files, finding.file);
    if (file) byFile.get(file).push(finding);
    else outside.push(finding);
  }
  const totalLines = files.reduce((n, f) => n + f.lineCount, 0);
  const ui = {
    priorities: new Set(PRIORITIES),
    onlyWithFindings: false,
    query: '',
    expanded: new Set(files.filter((f) => byFile.get(f).length || (totalLines <= AUTO_EXPAND_LINES && f.lineCount <= BIG_FILE_LINES))),
    showBig: new Set(),
    current: -1,
  };
  const sections = new Map(); // file -> { el, body, notes: Map(finding -> el) }
  const notes = new Map(); // finding -> note element

  const visible = (finding) => ui.priorities.has(finding.priority);

  // ---------- Notes ----------
  function noteEl(finding) {
    const index = ordered.indexOf(finding);
    const el = h('div', { class: `dv-note ${finding.priority}`, id: `finding-${index}`, 'data-index': index },
      h('div', { class: 'dv-note-head' },
        priorityChip(finding.priority, `${finding.priority} ${PRIORITY_LABEL[finding.priority]}`),
        h('strong', {}, finding.title),
        h('span', { class: 'tag' }, finding.category)),
      h('p', {}, finding.description),
      finding.suggestion ? h('pre', {}, finding.suggestion) : null,
      finding.suggestion ? h('div', { class: 'note-actions' },
        h('button', {
          type: 'button',
          class: 'btn small',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(finding.suggestion);
              toast('Suggested fix copied');
            } catch {
              toast('Could not copy: your browser blocked clipboard access');
            }
          },
        }, icon('copy', 13), 'Copy fix')) : null);
    el.hidden = !visible(finding);
    notes.set(finding, el);
    return el;
  }

  // ---------- File sections ----------
  function renderBody(file) {
    const section = sections.get(file);
    const list = byFile.get(file);
    if (file.binary) {
      fill(section.body, h('div', { class: 'dv-big' }, 'Binary file: no line-by-line diff.'));
      return;
    }
    if (file.lineCount > BIG_FILE_LINES && !ui.showBig.has(file)) {
      fill(section.body, h('div', { class: 'dv-big' },
        `Large diff: ${file.lineCount.toLocaleString()} lines.`,
        h('button', { type: 'button', class: 'btn small', onclick: () => { ui.showBig.add(file); renderBody(file); } }, 'Show it')));
      return;
    }
    const atLine = new Map();
    for (const f of list) if (f.line) atLine.set(f.line, [...(atLine.get(f.line) ?? []), f]);
    const placed = new Set();
    const rows = [];
    for (const hunk of file.hunks) {
      rows.push(h('tr', { class: 'hunk' }, h('td', { class: 'ln' }), h('td', { class: 'ln' }), h('td', { class: 'code' }, hunk.header)));
      for (const line of hunk.lines) {
        if (line.type === 'meta') {
          rows.push(h('tr', { class: 'hunk' }, h('td', { class: 'ln' }), h('td', { class: 'ln' }), h('td', { class: 'code' }, line.text)));
          continue;
        }
        const here = line.type !== 'del' ? atLine.get(line.newNo) ?? [] : [];
        rows.push(h('tr', { class: `${line.type}${here.length ? ' has-finding' : ''}`, 'data-new': line.newNo ?? null },
          h('td', { class: 'ln' }, line.oldNo ?? ''),
          h('td', { class: 'ln' }, line.newNo ?? ''),
          h('td', { class: 'code', 'data-sign': line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }, line.text)));
        for (const finding of here) {
          placed.add(finding);
          rows.push(h('tr', { class: 'dv-comment' }, h('td', { colspan: 3 }, noteEl(finding))));
        }
      }
    }
    const loose = list.filter((f) => !placed.has(f));
    fill(section.body, 
      loose.length ? h('div', { class: 'dv-outside' }, h('span', { class: 'label' }, loose.some((f) => f.line) ? 'Findings on lines outside the changed hunks' : 'Findings about the whole file'), loose.map(noteEl)) : null,
      h('table', { class: 'dv-table' }, h('tbody', {}, rows)),
    );
  }

  function setExpanded(file, open) {
    const section = sections.get(file);
    if (open) ui.expanded.add(file);
    else ui.expanded.delete(file);
    section.el.classList.toggle('collapsed', !open);
    section.body.hidden = !open;
    if (open && !section.rendered) {
      renderBody(file);
      section.rendered = true;
    }
  }

  function fileSection(file) {
    const list = byFile.get(file);
    const toggle = h('button', { type: 'button', class: 'toggle', 'aria-label': 'Collapse or expand file', onclick: () => setExpanded(file, !ui.expanded.has(file)) }, icon('chevron-down', 16));
    const body = h('div', { class: 'dv-file-body' });
    const el = h('section', { class: 'dv-file', 'data-path': file.path },
      h('div', { class: 'dv-file-head' },
        toggle,
        file.status !== 'modified' ? h('span', { class: 'tag' }, file.status) : null,
        h('span', { class: 'path' }, file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path),
        list.length ? h('span', { class: 'fdots', title: plural(list.length, 'finding') }, list.map((f) => h('span', { class: `fdot ${f.priority}` }))) : null,
        h('span', { class: 'fnum' }, file.binary ? 'binary' : [h('span', { class: 'a' }, `+${file.additions}`), ' ', h('span', { class: 'd' }, `−${file.deletions}`)])),
      body);
    sections.set(file, { el, body, rendered: false });
    return el;
  }

  // ---------- Sidebar ----------
  const fileList = h('ul', { class: 'dv-files' });
  function drawFileList() {
    const needle = ui.query.toLowerCase();
    const items = files.filter((f) => (!needle || f.path.toLowerCase().includes(needle))
      && (!ui.onlyWithFindings || byFile.get(f).some(visible)));
    fill(fileList, ...items.map((f) => h('li', {},
      h('button', { type: 'button', title: f.path, onclick: () => scrollToFile(f) },
        h('span', { class: 'fpath' }, `‎${f.path}`),
        h('span', { class: 'fdots' }, byFile.get(f).filter(visible).map((x) => h('span', { class: `fdot ${x.priority}` }))),
        h('span', { class: 'fstat' }, f.binary ? 'bin' : [h('span', { class: 'a' }, `+${f.additions}`), ' ', h('span', { class: 'd' }, `−${f.deletions}`)])))),
    items.length === 0 ? h('li', { class: 'hint' }, 'No files match.') : null);
    for (const [file, section] of sections) {
      section.el.hidden = !items.includes(file);
    }
  }

  function scrollToFile(file) {
    setExpanded(file, true);
    sections.get(file).el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- Toolbar ----------
  const counter = h('span', { class: 'hint' });
  const prioChips = h('div', { class: 'chips' });
  function drawToolbar() {
    const shown = ordered.filter(visible);
    fill(prioChips, h('span', { class: 'hint' }, 'Show'), ...PRIORITIES.map((p) => {
      const n = ordered.filter((f) => f.priority === p).length;
      return h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': ui.priorities.has(p) ? 'true' : 'false',
        disabled: n === 0,
        title: `${PRIORITY_LABEL[p]} findings`,
        onclick: () => {
          if (ui.priorities.has(p)) ui.priorities.delete(p);
          else ui.priorities.add(p);
          for (const [finding, el] of notes) el.hidden = !visible(finding);
          drawToolbar();
          drawFileList();
        },
      }, priorityChip(p), h('span', { class: 'count' }, String(n)));
    }));
    const position = shown.indexOf(ordered[ui.current]);
    counter.textContent = shown.length ? (position >= 0 ? `Finding ${position + 1} of ${shown.length}` : plural(shown.length, 'finding')) : 'No findings shown';
  }

  function step(direction) {
    const shown = ordered.filter(visible);
    if (!shown.length) return;
    const position = shown.indexOf(ordered[ui.current]);
    const next = position < 0 ? (direction > 0 ? 0 : shown.length - 1) : (position + direction + shown.length) % shown.length;
    focusFinding(shown[next]);
  }

  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  }

  /** Scroll to a finding's note (expanding its file) and highlight it. */
  function focusFinding(finding) {
    ui.current = ordered.indexOf(finding);
    if (!ui.priorities.has(finding.priority)) {
      ui.priorities.add(finding.priority);
      for (const [f, el] of notes) el.hidden = !visible(f);
    }
    const file = matchFile(files, finding.file);
    if (file) setExpanded(file, true);
    drawToolbar();
    const el = notes.get(finding);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flash(el);
    }
  }

  /** Scroll to file:line, e.g. from BRD evidence. */
  function jumpTo(path, line) {
    const file = matchFile(files, path);
    if (!file) {
      toast(`${path} isn't part of this diff`);
      return;
    }
    setExpanded(file, true);
    const row = line ? sections.get(file).body.querySelector(`tr[data-new="${line}"]`) : null;
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flash(row);
    } else {
      sections.get(file).el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (line) toast(`Line ${line} isn't one of the changed lines; showing the file`);
    }
  }

  // ---------- Assemble ----------
  const search = h('input', { type: 'search', placeholder: 'Filter files', 'aria-label': 'Filter files' });
  search.addEventListener('input', () => { ui.query = search.value.trim(); drawFileList(); });
  const onlyToggle = h('input', { type: 'checkbox', onchange: (e) => { ui.onlyWithFindings = e.target.checked; drawFileList(); } });
  const main = h('div', { class: 'dv-main' },
    h('div', { class: 'dv-toolbar' },
      prioChips,
      h('span', { class: 'grow' }),
      h('span', { class: 'nav-findings' },
        h('button', { type: 'button', class: 'btn small icon-only', title: 'Previous finding', 'aria-label': 'Previous finding', onclick: () => step(-1) }, icon('arrow-left', 14)),
        counter,
        h('button', { type: 'button', class: 'btn small icon-only', title: 'Next finding', 'aria-label': 'Next finding', onclick: () => step(1) }, icon('arrow-right', 14))),
      h('button', { type: 'button', class: 'btn small', onclick: () => files.forEach((f) => setExpanded(f, true)) }, 'Expand all'),
      h('button', { type: 'button', class: 'btn small', onclick: () => files.forEach((f) => setExpanded(f, false)) }, 'Collapse all')),
    truncated ? h('div', { class: 'notice' }, icon('info', 15), 'This diff was very large, so only its first part was saved.') : null,
    outside.length ? h('section', { class: 'dv-file' },
      h('div', { class: 'dv-file-head' }, h('span', { class: 'path' }, 'Findings in files outside this diff')),
      h('div', { class: 'dv-outside' }, outside.map((f) => [h('span', { class: 'label' }, findingLocation(f)), noteEl(f)]))) : null,
    files.map(fileSection));

  const el = h('div', { class: 'dv' },
    h('aside', { class: 'dv-side' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, `Files (${files.length})`)),
        search,
        h('label', { class: 'check' }, onlyToggle, 'Only files with findings'),
        fileList)),
    main);

  for (const file of files) setExpanded(file, ui.expanded.has(file));
  drawToolbar();
  drawFileList();
  return { el, jumpTo, focusFinding };
}
