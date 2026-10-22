import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { renderReportPdf, safeText } from '../src/render-pdf.js';
import { Report } from '../src/schema.js';
import { loadFixture, tempDir } from './helpers.js';

const pageCount = (buffer) => (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

test('renders the sample report to a multi-page PDF', async () => {
  const out = path.join(tempDir('render'), 'nested', 'report.pdf');
  await renderReportPdf(Report.parse(loadFixture('sample-report.json')), out);
  const pdf = fs.readFileSync(out);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pageCount(pdf) >= 2, `expected several pages, got ${pageCount(pdf)}`);
});

test('renders a minimal report: no BRD, no findings', async () => {
  const report = Report.parse(loadFixture('sample-report.json'));
  delete report.brd;
  report.findings = [];
  report.verdict = 'APPROVE';
  report.meta.changeType = 'bugfix';
  const out = path.join(tempDir('render'), 'minimal.pdf');
  await renderReportPdf(report, out);
  assert.ok(pageCount(fs.readFileSync(out)) >= 1);
});

test('renders a very long code suggestion across pages', async () => {
  const report = Report.parse(loadFixture('sample-report.json'));
  report.findings[0].suggestion = Array.from({ length: 220 }, (_, i) => `  const value${i} = compute(${i}); // line ${i}`).join('\n');
  const out = path.join(tempDir('render'), 'long.pdf');
  await renderReportPdf(report, out);
  assert.ok(pageCount(fs.readFileSync(out)) >= 5);
});

test('safeText keeps WinAnsi characters and replaces the rest', () => {
  assert.equal(safeText('a → b ≥ c'), 'a -> b >= c');
  assert.equal(safeText('“quoted” – café €5 •'), '“quoted” – café €5 •');
  assert.equal(safeText('emoji 🚀 and 中文'), 'emoji ? and ??');
  assert.equal(safeText('tab\there\r\nnext'), 'tab    here\nnext');
});
