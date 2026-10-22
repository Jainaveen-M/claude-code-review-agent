import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { FolderError, findRepos, listFolder } from '../src/folders.js';
import { tempDir } from './helpers.js';

let root;
const mkdir = (...parts) => fs.mkdirSync(path.join(root, ...parts), { recursive: true });

before(() => {
  // root/
  //   alpha/ (repo, with src/)   Beta/   gamma/nested/deep-repo/ (repo)   .hidden/   node_modules/   notes.txt
  root = tempDir('folders');
  mkdir('alpha', '.git');
  mkdir('alpha', 'src');
  mkdir('Beta');
  mkdir('gamma', 'nested', 'deep-repo', '.git');
  mkdir('gamma', 'nested', 'deep-repo', 'packages', 'inner', '.git');
  mkdir('.hidden', 'repo', '.git');
  mkdir('node_modules', 'pkg', '.git');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
});

test('lists subfolders, marking git repositories', async () => {
  const listing = await listFolder(root);
  assert.equal(listing.path, root);
  assert.equal(listing.parent, path.dirname(root));
  assert.equal(listing.isRepo, false);
  assert.equal(listing.repoRoot, null);
  assert.deepEqual(listing.entries.map((e) => [e.name, e.isRepo]), [['alpha', true], ['Beta', false], ['gamma', false]]);
});

test('hidden folders appear only on request; node_modules never', async () => {
  const listing = await listFolder(root, { showHidden: true });
  assert.deepEqual(listing.entries.map((e) => e.name), ['.hidden', 'alpha', 'Beta', 'gamma']);
});

test('a folder inside a repository reports the repository root', async () => {
  const listing = await listFolder(path.join(root, 'alpha', 'src'));
  assert.equal(listing.isRepo, false);
  assert.equal(listing.repoRoot, path.join(root, 'alpha'));
  assert.equal((await listFolder(path.join(root, 'alpha'))).isRepo, true);
});

test('defaults to the home folder and expands ~', async () => {
  assert.equal((await listFolder('')).path, os.homedir());
  assert.equal((await listFolder('~')).path, os.homedir());
});

test('bad paths give clear errors', async () => {
  await assert.rejects(listFolder(path.join(root, 'missing')), (e) => e instanceof FolderError && e.status === 404);
  await assert.rejects(listFolder(path.join(root, 'notes.txt')), (e) => e instanceof FolderError && e.status === 400);
  await assert.rejects(listFolder('relative/path'), (e) => e instanceof FolderError && e.status === 400);
});

test('findRepos finds repositories a few levels down without entering them', async () => {
  const { repos, complete } = await findRepos(root);
  assert.equal(complete, true);
  assert.deepEqual(repos.map((r) => r.name), ['alpha', path.join('gamma', 'nested', 'deep-repo')]);
  const shallow = await findRepos(root, { maxDepth: 1 });
  assert.deepEqual(shallow.repos.map((r) => r.name), ['alpha']);
  const limited = await findRepos(root, { limit: 1 });
  assert.equal(limited.repos.length, 1);
  assert.equal(limited.complete, false);
});
