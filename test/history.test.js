import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { deleteEntry, getEntry, listEntries, recentRepos } from '../src/history.js';
import { saveReport } from '../src/report.js';
import { Report } from '../src/schema.js';
import { loadFixture, useTempHome } from './helpers.js';

let home;
before(() => {
  home = useTempHome();
});

const fixture = () => Report.parse(loadFixture('sample-report.json'));

test('saveReport writes PDF and JSON under <home>/<repo>/ and indexes them', async () => {
  const { entry, pdfPath, jsonPath } = await saveReport(fixture());
  assert.equal(path.dirname(pdfPath), path.join(home, 'shop-api'));
  assert.equal(path.basename(pdfPath), 'review-feature-checkout-coupons-into-main-2026-10-22.pdf');
  assert.ok(fs.existsSync(pdfPath) && fs.existsSync(jsonPath));
  assert.deepEqual(entry.counts, { P0: 1, P1: 2, P2: 2, P3: 1 });
  assert.equal(entry.hasBrd, true);
  assert.equal(getEntry(entry.id).pdfPath, pdfPath);

  const second = await saveReport(fixture());
  assert.match(second.pdfPath, /-2\.pdf$/, 'a second review the same day gets a suffix');
  assert.equal(listEntries().length, 2);
});

test('listEntries filters by repo, verdict and search text', () => {
  assert.equal(listEntries({ repo: 'shop-api' }).length, 2);
  assert.equal(listEntries({ repo: 'other' }).length, 0);
  assert.equal(listEntries({ verdict: 'APPROVE' }).length, 0);
  assert.equal(listEntries({ q: 'COUPONS' }).length, 2);
  assert.deepEqual(recentRepos().map((r) => r.repo), ['shop-api']);
});

test('a corrupt index is rebuilt from the saved reports', () => {
  const ids = listEntries().map((e) => e.id).sort();
  fs.writeFileSync(path.join(home, 'history.json'), '{ not json');
  const rebuilt = listEntries();
  assert.equal(rebuilt.length, 2);
  assert.deepEqual(rebuilt.map((e) => e.id).sort(), ids, 'ids survive a rebuild');
});

test('entries whose files were removed by hand disappear from the list', () => {
  const [first] = listEntries();
  fs.rmSync(first.jsonPath);
  assert.equal(listEntries().length, 1);
});

test('deleteEntry removes the files and the entry', () => {
  const [entry] = listEntries();
  assert.equal(deleteEntry(entry.id), true);
  assert.ok(!fs.existsSync(entry.pdfPath) && !fs.existsSync(entry.jsonPath));
  assert.equal(listEntries().length, 0);
  assert.equal(deleteEntry(entry.id), false);
});
