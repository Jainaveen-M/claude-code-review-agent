import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { ReportError, reportFromFile } from '../src/report.js';
import { makeRepo, useTempHome } from './helpers.js';

let repo;
before(() => {
  useTempHome();
  repo = makeRepo();
});

const review = {
  verdict: 'APPROVE',
  confidence: 'HIGH',
  summary: 'Adds coupons.',
  intentCheck: { matchesDescription: 'yes', rootCauseAddressed: 'not_applicable', testsAdded: false, notes: 'n' },
  findings: [{ priority: 'P0', title: 'SQL injection', file: 'src/coupons.js', line: 2, category: 'security', description: 'd' }],
  recommendation: 'Fix it.',
};

test('a chat-mode draft gets git facts computed and the verdict rule enforced', async () => {
  const draft = { inputs: { repoPath: repo, source: 'feature/coupons', dest: 'main', changeType: 'feature', description: 'Coupons' }, review };
  const { report, isDraft } = await reportFromFile(draft);
  assert.equal(isDraft, true);
  assert.equal(report.meta.origin, 'chat');
  assert.equal(report.meta.commitCount, 1);
  assert.equal(report.filesChanged.length, 2);
  assert.equal(report.verdict, 'REQUEST_CHANGES', 'APPROVE with a P0 is corrected');
});

test('invalid drafts list the offending fields', async () => {
  const bad = { inputs: { repoPath: repo, source: 'feature/coupons', dest: 'main', changeType: 'feature', description: 'x' }, review: { ...review, findings: [{ priority: 'P9' }] } };
  await assert.rejects(reportFromFile(bad), (error) => error instanceof ReportError && /review\.findings\[0\]\.priority/.test(error.message));
});
