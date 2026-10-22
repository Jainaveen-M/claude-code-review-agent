import { execFile } from 'node:child_process';
import path from 'node:path';

const MAX_COMMITS = 200;
const DEFAULT_DESTS = ['main', 'master', 'develop', 'origin/main', 'origin/master', 'origin/develop'];

export class GitError extends Error {}

/** Run git with an argument array (never a shell), returning stdout. */
export function git(args, cwd, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || error.message).trim().split('\n')[0];
        reject(new GitError(message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Reject anything that git could read as an option or that is not a plausible ref name. */
export function assertRefName(name) {
  if (typeof name !== 'string' || name.length === 0) throw new GitError('Branch name is required');
  if (name.startsWith('-')) throw new GitError(`Invalid branch name "${name}"`);
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(name) || name.includes('..')) {
    throw new GitError(`Invalid branch name "${name}"`);
  }
}

export async function repoRoot(dir) {
  if (!dir || !path.isAbsolute(dir)) throw new GitError('Repository path must be absolute');
  try {
    return (await git(['rev-parse', '--show-toplevel'], dir)).trim();
  } catch {
    throw new GitError(`Not a git repository: ${dir}`);
  }
}

export async function fetchRemotes(repo) {
  const remotes = (await git(['remote'], repo)).trim();
  if (!remotes) return { fetched: false, warning: null };
  try {
    await git(['fetch', '--quiet', '--prune', '--all'], repo, { timeout: 120_000 });
    return { fetched: true, warning: null };
  } catch (error) {
    return { fetched: false, warning: `git fetch failed: ${error.message}` };
  }
}

/** Local and remote branches, most recently committed first. */
export async function listBranches(repo) {
  const out = await git(
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(refname:short)%09%(committerdate:iso-strict)%09%(authorname)%09%(subject)', 'refs/heads', 'refs/remotes'],
    repo,
  );
  const branches = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [full, name, date, author, ...subject] = line.split('\t');
    if (full.endsWith('/HEAD')) continue;
    branches.push({ name, kind: full.startsWith('refs/heads/') ? 'local' : 'remote', date, author, subject: subject.join('\t') });
  }
  let current = null;
  try {
    current = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo)).trim() || null;
  } catch {
    // detached HEAD
  }
  const names = new Set(branches.map((b) => b.name));
  const defaultDest = DEFAULT_DESTS.find((n) => names.has(n)) ?? null;
  return { branches, current, defaultDest };
}

/** Resolve a branch to a commit SHA, falling back to origin/<name>. Returns { ref, sha }. */
export async function resolveBranch(repo, name) {
  assertRefName(name);
  for (const ref of [name, `origin/${name}`]) {
    try {
      const sha = (await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], repo)).trim();
      if (sha) return { ref, sha };
    } catch {
      // try next candidate
    }
  }
  throw new GitError(`Branch not found: ${name}`);
}

function parseNumstat(out) {
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ins, del, ...rest] = line.split('\t');
    const binary = ins === '-' && del === '-';
    files.push({
      path: rest.join('\t'),
      insertions: binary ? 0 : Number(ins),
      deletions: binary ? 0 : Number(del),
      ...(binary ? { binary: true } : {}),
    });
  }
  return files;
}

/**
 * Everything about the change that code can determine without a model: resolved
 * SHAs, merge base, commits, and per-file stats. Uses merge-base semantics
 * (what a pull request from source into dest would show).
 */
export async function collectGitFacts(repoPath, sourceName, destName) {
  const repo = await repoRoot(repoPath);
  const source = await resolveBranch(repo, sourceName);
  const dest = await resolveBranch(repo, destName);
  if (source.sha === dest.sha) throw new GitError(`"${sourceName}" and "${destName}" point to the same commit; there is nothing to review`);

  let mergeBase;
  try {
    mergeBase = (await git(['merge-base', dest.sha, source.sha], repo)).trim();
  } catch {
    throw new GitError(`"${sourceName}" and "${destName}" share no history`);
  }

  const range = `${dest.sha}..${source.sha}`;
  const [logOut, countOut, numstatOut] = await Promise.all([
    git(['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x09%s', range], repo),
    git(['rev-list', '--count', range], repo),
    git(['diff', '--numstat', mergeBase, source.sha], repo),
  ]);

  const commits = logOut.split('\n').filter(Boolean).map((line) => {
    const [sha, ...subject] = line.split('\t');
    return { sha, subject: subject.join('\t') };
  });
  const filesChanged = parseNumstat(numstatOut);
  if (filesChanged.length === 0) {
    throw new GitError(`No changes: "${sourceName}" has nothing that "${destName}" doesn't already have`);
  }

  return {
    repo: path.basename(repo),
    repoPath: repo,
    source: sourceName,
    dest: destName,
    sourceSha: source.sha,
    destSha: dest.sha,
    mergeBase,
    commits,
    commitCount: Number(countOut.trim()),
    stats: {
      files: filesChanged.length,
      insertions: filesChanged.reduce((n, f) => n + f.insertions, 0),
      deletions: filesChanged.reduce((n, f) => n + f.deletions, 0),
    },
    filesChanged,
  };
}

/** How many commits `dest` has that the source branch doesn't (it may need a rebase). */
export async function behindCount(repo, sourceSha, destSha) {
  return Number((await git(['rev-list', '--count', `${sourceSha}..${destSha}`], repo)).trim());
}

const MAX_DIFF_BYTES = 5 * 1024 * 1024;

/**
 * The unified diff a review covers (merge base to source). Very large diffs are
 * cut at a file boundary; `truncated` says so.
 */
export async function diffText(repo, mergeBase, sourceSha, { maxBytes = MAX_DIFF_BYTES } = {}) {
  const text = await git(['diff', '--no-color', '--no-ext-diff', '-U3', mergeBase, sourceSha], repo);
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const cut = text.lastIndexOf('\ndiff --git ', maxBytes);
  return { text: text.slice(0, cut > 0 ? cut + 1 : maxBytes), truncated: true };
}
