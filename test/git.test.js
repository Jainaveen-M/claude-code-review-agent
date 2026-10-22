import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { GitError, assertRefName, collectGitFacts, listBranches, repoRoot, resolveBranch } from '../src/git.js';
import { makeRepo, tempDir } from './helpers.js';

let repo;
before(() => {
  repo = makeRepo();
});

test('listBranches returns branches, the current branch and a default destination', async () => {
  const { branches, current, defaultDest } = await listBranches(repo);
  assert.deepEqual(branches.map((b) => b.name).sort(), ['feature/coupons', 'main', 'noop']);
  assert.ok(branches.every((b) => b.kind === 'local'));
  assert.equal(current, 'main');
  assert.equal(defaultDest, 'main');
});

test('collectGitFacts compares from the merge base', async () => {
  const facts = await collectGitFacts(repo, 'feature/coupons', 'main');
  assert.equal(facts.repoPath, repo);
  assert.equal(facts.commitCount, 1);
  assert.equal(facts.commits[0].subject, 'Add coupons');
  assert.deepEqual(facts.filesChanged.map((f) => f.path).sort(), ['src/checkout.js', 'src/coupons.js']);
  assert.equal(facts.stats.files, 2);
  assert.equal(facts.stats.insertions, 5);
  assert.equal(facts.stats.deletions, 2);
  assert.match(facts.mergeBase, /^[0-9a-f]{40}$/);
});

test('collectGitFacts rejects identical branches and empty diffs', async () => {
  await assert.rejects(collectGitFacts(repo, 'main', 'main'), /same commit/);
  await assert.rejects(collectGitFacts(repo, 'noop', 'main'), /No changes/);
});

test('branch names that could be read as options are rejected', async () => {
  assert.throws(() => assertRefName('-x'), GitError);
  assert.throws(() => assertRefName('--output=/tmp/x'), GitError);
  assert.throws(() => assertRefName('a b'), GitError);
  assert.throws(() => assertRefName('a..b'), GitError);
  assert.doesNotThrow(() => assertRefName('feature/coupons-v2'));
  await assert.rejects(resolveBranch(repo, 'does-not-exist'), /Branch not found/);
});

test('repoRoot rejects folders that are not repositories', async () => {
  await assert.rejects(repoRoot(tempDir('plain')), /Not a git repository/);
  await assert.rejects(repoRoot('relative/path'), /absolute/);
});
