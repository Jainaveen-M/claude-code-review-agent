import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { PRIORITIES, countByPriority } from './schema.js';

const C = {
  text: '#1f2328',
  muted: '#59636e',
  rule: '#d1d9e0',
  soft: '#f6f8fa',
  code: '#f1f3f5',
  quote: '#8c959f',
};
const VERDICT = {
  APPROVE: { label: 'APPROVE', color: '#1a7f37' },
  REQUEST_CHANGES: { label: 'REQUEST CHANGES', color: '#cf222e' },
  NEEDS_DISCUSSION: { label: 'NEEDS DISCUSSION', color: '#9a6700' },
};
const PRIORITY = {
  P0: { bg: '#cf222e', fg: '#ffffff', label: 'Critical' },
  P1: { bg: '#bc4c00', fg: '#ffffff', label: 'Major' },
  P2: { bg: '#d4a72c', fg: '#1f2328', label: 'Minor' },
  P3: { bg: '#8c959f', fg: '#ffffff', label: 'Suggestion' },
};
const STATUS = {
  implemented: { bg: '#dafbe1', fg: '#116329', label: 'Implemented' },
  partial: { bg: '#fff8c5', fg: '#7d4e00', label: 'Partial' },
  missing: { bg: '#ffebe9', fg: '#a40e26', label: 'Missing' },
  not_verifiable: { bg: '#eaeef2', fg: '#424a53', label: 'Not verifiable' },
};
const CHANGE_TYPE = { bugfix: 'Bug fix', feature: 'Feature', refactor: 'Refactor', other: 'Other' };
const ANSWER = { yes: 'Yes', partial: 'Partially', no: 'No', unclear: 'Unclear', not_applicable: 'Not applicable' };
const MAX_FILE_ROWS = 300;
const MAX_COMMIT_ROWS = 50;

// The standard PDF fonts only cover WinAnsi (Latin-1 plus a few symbols).
// Map common characters to ASCII and replace anything else with "?" so text never garbles.
const REPLACE = {
  '→': '->', '←': '<-', '⇒': '=>', '↔': '<->', '≤': '<=', '≥': '>=',
  '≠': '!=', '−': '-', '‑': '-', '‐': '-', '✓': 'v', '✔': 'v',
  '✗': 'x', '✘': 'x', ' ': ' ', ' ': ' ', '​': '', '\t': '    ',
};
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

export function safeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\n]/gu, (ch) => {
      if (REPLACE[ch] !== undefined) return REPLACE[ch];
      const code = ch.codePointAt(0);
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) return ch;
      return '?';
    });
}

// Approximate height of a table with single-line rows, used to keep short tables with their heading.
const tableHeight = (rows) => 24 + rows * 20;
const location = (f) => (f.line ? `${f.file}:${f.line}` : f.file);
const shortSha = (sha) => sha.slice(0, 8);

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

class Layout {
  constructor(doc) {
    this.doc = doc;
  }

  get left() {
    return this.doc.page.margins.left;
  }

  get width() {
    return this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right;
  }

  get bottom() {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  ensure(height) {
    if (this.doc.y + height > this.bottom) this.doc.addPage();
  }

  body(size = 10) {
    return this.doc.font('Helvetica').fontSize(size).fillColor(C.text);
  }

  /** Section heading. `keepWith` is roughly how much of what follows must fit on the same page. */
  heading(text, keepWith = 70) {
    const { doc } = this;
    this.ensure(30 + keepWith);
    doc.moveDown(0.9);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.text).text(safeText(text), this.left, doc.y, { width: this.width });
    const y = doc.y + 3;
    doc.save().moveTo(this.left, y).lineTo(this.left + this.width, y).lineWidth(0.6).strokeColor(C.rule).stroke().restore();
    doc.y = y + 8;
  }

  subheading(text) {
    this.ensure(40);
    this.doc.moveDown(0.3);
    this.doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.text).text(safeText(text), this.left, this.doc.y, { width: this.width });
    this.doc.moveDown(0.25);
  }

  para(text, { size = 10, color = C.text, gap = 0.5 } = {}) {
    this.body(size).fillColor(color).text(safeText(text), this.left, this.doc.y, { width: this.width, lineGap: 2 });
    this.doc.moveDown(gap);
  }

  /** "Label: value" on one line, label in bold. */
  field(label, value) {
    const { doc } = this;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.muted).text(`${safeText(label)}  `, this.left, doc.y, { continued: true });
    doc.font('Helvetica').fillColor(C.text).text(safeText(value), { width: this.width });
    doc.moveDown(0.2);
  }

  bullets(items) {
    for (const item of items) {
      this.body(10).text(`•  ${safeText(item)}`, this.left + 6, this.doc.y, { width: this.width - 6, lineGap: 2 });
      this.doc.moveDown(0.2);
    }
    this.doc.moveDown(0.3);
  }

  /** Indented block with a grey bar on the left, for quoting the author. */
  quote(text) {
    const { doc } = this;
    const indent = 12;
    this.body(10);
    const height = doc.heightOfString(safeText(text), { width: this.width - indent, lineGap: 2 });
    if (height < this.bottom - this.doc.page.margins.top) this.ensure(height + 4);
    const top = doc.y;
    doc.fillColor(C.text).text(safeText(text), this.left + indent, top, { width: this.width - indent, lineGap: 2 });
    if (doc.y > top) doc.save().rect(this.left, top, 3, doc.y - top).fill(C.quote).restore();
    doc.x = this.left;
    doc.moveDown(0.6);
  }

  /** Monospace block on a grey background, split across pages line by line. */
  code(text) {
    const { doc } = this;
    const pad = 6;
    const width = this.width - pad * 2;
    const lines = safeText(text).replace(/\n+$/, '').split('\n').map((l) => l || ' ');
    const measure = (s) => doc.heightOfString(s, { width, lineGap: 1 });
    let i = 0;
    while (i < lines.length) {
      doc.font('Courier').fontSize(8.5);
      this.ensure(measure(lines[i]) + pad * 2 + 4);
      const room = this.bottom - doc.y - pad * 2 - 4;
      const chunk = [];
      while (i < lines.length && (chunk.length === 0 || measure([...chunk, lines[i]].join('\n')) <= room)) {
        chunk.push(lines[i]);
        i += 1;
      }
      const textBlock = chunk.join('\n');
      const top = doc.y;
      const height = measure(textBlock) + pad * 2;
      doc.save().roundedRect(this.left, top, this.width, height, 3).fill(C.code).restore();
      doc.font('Courier').fontSize(8.5).fillColor(C.text).text(textBlock, this.left + pad, top + pad, { width, lineGap: 1 });
      doc.x = this.left;
      doc.y = top + height + 6;
      if (i < lines.length) doc.addPage();
    }
  }

  /** Rounded label with coloured background, drawn inline at (x, y). Returns its width. */
  chip(text, x, y, { bg, fg, size = 8 }) {
    const { doc } = this;
    doc.font('Helvetica-Bold').fontSize(size);
    const label = safeText(text);
    const w = doc.widthOfString(label) + 10;
    const h = size + 6;
    doc.save().roundedRect(x, y, w, h, 3).fill(bg).restore();
    doc.fillColor(fg).text(label, x + 5, y + 3.2, { lineBreak: false });
    return w;
  }

  /**
   * Table with a shaded header row. `columns` is [{ header, width }] where width is
   * a fraction of the content width; cells are strings or pdfkit cell objects.
   */
  table(columns, rows, { size = 8.5, border = true } = {}) {
    const { doc } = this;
    this.ensure(50);
    this.body(size);
    doc.table({
      position: { x: this.left, y: doc.y },
      maxWidth: this.width,
      columnStyles: columns.map((c) => ({ width: c.width * this.width })),
      defaultStyle: {
        padding: [4, 5],
        border: border ? 0.5 : 0,
        borderColor: C.rule,
        textColor: C.text,
      },
      rowStyles: (i) => (i === 0 && columns.some((c) => c.header) ? { backgroundColor: C.soft, font: { src: 'Helvetica-Bold' } } : {}),
      data: [
        ...(columns.some((c) => c.header) ? [columns.map((c) => safeText(c.header))] : []),
        ...rows.map((row) => row.map((cell) => (cell && typeof cell === 'object' ? { ...cell, text: safeText(cell.text) } : safeText(cell)))),
      ],
    });
    doc.x = this.left;
    doc.moveDown(0.6);
  }
}

function header(L, report) {
  const { doc } = L;
  const { meta } = report;
  const verdict = VERDICT[report.verdict];

  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.muted).text('CODE REVIEW REPORT', L.left, doc.y, { characterSpacing: 1 });
  doc.moveDown(0.3);
  const titleTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(19).fillColor(C.text)
    .text(safeText(`${meta.source}  ->  ${meta.dest}`), L.left, titleTop, { width: L.width - 150 });
  const afterTitle = doc.y;

  doc.font('Helvetica-Bold').fontSize(10);
  const badgeW = doc.widthOfString(verdict.label) + 22;
  const badgeX = L.left + L.width - badgeW;
  doc.save().roundedRect(badgeX, titleTop, badgeW, 24, 4).fill(verdict.color).restore();
  doc.fillColor('#ffffff').text(verdict.label, badgeX + 11, titleTop + 7.5, { lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(C.muted)
    .text(`Confidence: ${report.confidence}`, badgeX, titleTop + 28, { width: badgeW, align: 'center' });

  doc.y = Math.max(afterTitle, titleTop + 42) + 4;
  doc.font('Helvetica').fontSize(10.5).fillColor(C.muted).text(safeText(`${meta.repo}  ·  ${meta.repoPath}`), L.left, doc.y, { width: L.width });
  doc.moveDown(0.8);

  const reviewed = new Date(meta.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const run = [meta.model, meta.costUsd != null ? `est. $${meta.costUsd.toFixed(2)}` : null, meta.durationMs != null ? formatDuration(meta.durationMs) : null]
    .filter(Boolean).join('  ·  ');
  const label = (text) => ({ text, textColor: C.muted, font: { src: 'Helvetica-Bold' } });
  L.table(
    [{ width: 0.16 }, { width: 0.34 }, { width: 0.16 }, { width: 0.34 }],
    [
      [label('Source'), `${meta.source} (${shortSha(meta.sourceSha)})`, label('Change type'), CHANGE_TYPE[meta.changeType]],
      [label('Destination'), `${meta.dest} (${shortSha(meta.destSha)})`, label('Reviewed'), reviewed],
      [label('Merge base'), shortSha(meta.mergeBase), label('Reviewed by'), run || (meta.origin === 'chat' ? 'Claude Code (chat)' : 'Claude')],
      [label('Commits'), String(meta.commitCount), label('Changes'), `${meta.stats.files} files, +${meta.stats.insertions} / -${meta.stats.deletions}`],
      ...(meta.brdSource ? [[label('BRD'), { text: meta.brdSource, colSpan: 3 }]] : []),
    ],
    { size: 9, border: false },
  );

  const counts = countByPriority(report.findings);
  let x = L.left;
  const y = doc.y;
  for (const p of PRIORITIES) {
    x += L.chip(`${p} ${PRIORITY[p].label}: ${counts[p]}`, x, y, { ...PRIORITY[p], size: 8.5 }) + 6;
  }
  doc.x = L.left;
  doc.y = y + 22;
}

function intentSection(L, report) {
  const { intentCheck: check, meta } = report;
  L.heading('Does the change do what was described?');
  const answer = (value) => ({
    text: ANSWER[value] ?? String(value),
    font: { src: 'Helvetica-Bold' },
    textColor: value === 'yes' ? '#116329' : value === 'no' ? '#a40e26' : value === 'partial' ? '#7d4e00' : C.text,
  });
  const rows = [['Matches the description', answer(check.matchesDescription)]];
  if (meta.changeType === 'bugfix' || check.rootCauseAddressed !== 'not_applicable') {
    rows.push(['Root cause addressed', answer(check.rootCauseAddressed)]);
  }
  rows.push(['Tests added or updated', answer(check.testsAdded ? 'yes' : 'no')]);
  L.table([{ width: 0.35 }, { width: 0.65 }], rows, { size: 9.5 });
  L.para(check.notes);
}

function brdSection(L, report) {
  const { brd } = report;
  L.heading('BRD compliance');
  L.field('Document', brd.title);
  const tally = Object.fromEntries(Object.keys(STATUS).map((s) => [s, brd.requirements.filter((r) => r.status === s).length]));
  L.field('Coverage', Object.entries(tally).map(([s, n]) => `${n} ${STATUS[s].label.toLowerCase()}`).join(', '));
  L.doc.moveDown(0.3);
  if (brd.requirements.length === 0) {
    L.para('No requirements could be extracted from the BRD.', { color: C.muted });
  } else {
    L.table(
      [{ header: 'ID', width: 0.1 }, { header: 'Requirement', width: 0.42 }, { header: 'Status', width: 0.15 }, { header: 'Evidence / notes', width: 0.33 }],
      brd.requirements.map((r) => [
        { text: r.id, font: { src: 'Helvetica-Bold' } },
        r.text,
        { text: STATUS[r.status].label, backgroundColor: STATUS[r.status].bg, textColor: STATUS[r.status].fg, font: { src: 'Helvetica-Bold' } },
        [r.evidence.join(', '), r.notes].filter(Boolean).join('\n') || '-',
      ]),
    );
  }
  L.subheading('Changes not traced to any requirement');
  if (brd.outOfScopeChanges.length) L.bullets(brd.outOfScopeChanges);
  else L.para('None.', { color: C.muted });
}

function findingsSection(L, report) {
  const order = (f) => PRIORITIES.indexOf(f.priority);
  const findings = [...report.findings].sort((a, b) => order(a) - order(b));
  L.heading('Findings');
  if (findings.length === 0) {
    L.para('No issues found in the changed code.', { color: C.muted });
    return;
  }
  L.table(
    [{ header: '#', width: 0.05 }, { header: 'Priority', width: 0.1 }, { header: 'Issue', width: 0.44 }, { header: 'Location', width: 0.27 }, { header: 'Category', width: 0.14 }],
    findings.map((f, i) => [
      String(i + 1),
      { text: f.priority, backgroundColor: PRIORITY[f.priority].bg, textColor: PRIORITY[f.priority].fg, font: { src: 'Helvetica-Bold' }, align: { x: 'center', y: 'top' } },
      f.title,
      location(f),
      f.category,
    ]),
  );

  L.heading('Finding details');
  findings.forEach((f, i) => {
    const { doc } = L;
    L.ensure(80);
    const y = doc.y;
    const w = L.chip(f.priority, L.left, y, { ...PRIORITY[f.priority], size: 8.5 });
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.text)
      .text(safeText(`${i + 1}. ${f.title}`), L.left + w + 8, y + 1, { width: L.width - w - 8 });
    doc.x = L.left;
    doc.moveDown(0.2);
    L.para(`${location(f)}  ·  ${f.category}`, { size: 8.5, color: C.muted, gap: 0.3 });
    L.para(f.description);
    if (f.suggestion) {
      L.body(9).fillColor(C.muted).font('Helvetica-Bold').text('Suggested fix', L.left, doc.y);
      doc.moveDown(0.2);
      L.code(f.suggestion);
    }
    doc.moveDown(0.6);
  });
}

function filesSection(L, report) {
  const files = report.filesChanged;
  L.heading(`Files changed (${files.length})`, tableHeight(Math.min(files.length, 12)));
  L.table(
    [{ header: 'File', width: 0.76 }, { header: 'Added', width: 0.12 }, { header: 'Removed', width: 0.12 }],
    files.slice(0, MAX_FILE_ROWS).map((f) => [
      f.path,
      { text: f.binary ? 'binary' : `+${f.insertions}`, textColor: '#116329', align: 'right' },
      { text: f.binary ? '' : `-${f.deletions}`, textColor: '#a40e26', align: 'right' },
    ]),
  );
  if (files.length > MAX_FILE_ROWS) L.para(`...and ${files.length - MAX_FILE_ROWS} more files.`, { color: C.muted });

  const { commits, commitCount } = report.meta;
  L.heading(`Commits (${commitCount})`, tableHeight(Math.min(commits.length, 12)));
  L.table(
    [{ header: 'Commit', width: 0.13 }, { header: 'Message', width: 0.87 }],
    commits.slice(0, MAX_COMMIT_ROWS).map((c) => [{ text: shortSha(c.sha), font: { src: 'Courier' } }, c.subject]),
  );
  if (commitCount > MAX_COMMIT_ROWS) L.para(`...and ${commitCount - MAX_COMMIT_ROWS} more commits.`, { color: C.muted });
}

function footers(doc, report) {
  const { meta } = report;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const { margins } = doc.page;
    const savedBottom = margins.bottom;
    margins.bottom = 0;
    const y = doc.page.height - 34;
    const width = doc.page.width - margins.left - margins.right;
    doc.save().moveTo(margins.left, y - 6).lineTo(margins.left + width, y - 6).lineWidth(0.5).strokeColor(C.rule).stroke().restore();
    doc.font('Helvetica').fontSize(8).fillColor(C.muted);
    doc.text(safeText(`${meta.repo}  ·  ${meta.source} -> ${meta.dest}`), margins.left, y, { width: width - 80, lineBreak: false, ellipsis: true });
    doc.text(`Page ${i + 1} of ${range.count}`, margins.left, y, { width, align: 'right', lineBreak: false });
    margins.bottom = savedBottom;
  }
}

/** Render a full report (see schema.js `Report`) to a PDF file. */
export function renderReportPdf(report, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 56, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title: safeText(`Code review: ${report.meta.source} into ${report.meta.dest} (${report.meta.repo})`),
      Author: 'claude-code-review-agent',
      Subject: `Verdict: ${VERDICT[report.verdict].label}`,
    },
  });
  const L = new Layout(doc);
  const done = new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    out.on('finish', resolve);
    out.on('error', reject);
    doc.on('error', reject);
    doc.pipe(out);
  });

  header(L, report);
  L.heading('Summary');
  L.para(report.summary);
  L.heading('What the author changed');
  L.quote(report.meta.description);
  intentSection(L, report);
  if (report.brd) brdSection(L, report);
  findingsSection(L, report);
  L.heading('Recommendation');
  L.para(report.recommendation);
  filesSection(L, report);
  footers(doc, report);
  doc.end();
  return done;
}
