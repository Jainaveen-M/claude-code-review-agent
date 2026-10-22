import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_ENTRIES = 1000;
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git']);
const SCAN_DEPTH = 3;
const SCAN_LIMIT = 200;
const SCAN_BUDGET_MS = 4000;

export class FolderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));

/** The repository root containing `dir`, found by walking up to a `.git` entry. */
function findRepoRoot(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (isRepo(current)) return current;
    if (path.dirname(current) === current) return null;
  }
}

function toFolderError(error, dir) {
  if (error.code === 'ENOENT') return new FolderError(404, `Folder not found: ${dir}`);
  if (error.code === 'ENOTDIR') return new FolderError(400, `Not a folder: ${dir}`);
  if (error.code === 'EACCES' || error.code === 'EPERM') return new FolderError(403, `No permission to open ${dir}`);
  return error;
}

function resolveDir(dir) {
  if (!dir) return os.homedir();
  const expanded = dir === '~' || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir;
  if (!path.isAbsolute(expanded)) throw new FolderError(400, 'Folder path must be absolute');
  return path.resolve(expanded);
}

async function subfolders(dir, { showHidden }) {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const folders = [];
  for (const dirent of dirents) {
    if (SKIP_DIRS.has(dirent.name) || (!showHidden && dirent.name.startsWith('.'))) continue;
    const full = path.join(dir, dirent.name);
    let isDir = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) folders.push({ name: dirent.name, path: full });
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** Subfolders of `dir` (default: home), each marked if it is a git repository. */
export async function listFolder(dir, { showHidden = false } = {}) {
  const target = resolveDir(dir);
  let folders;
  try {
    folders = await subfolders(target, { showHidden });
  } catch (error) {
    throw toFolderError(error, target);
  }
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home: os.homedir(),
    isRepo: isRepo(target),
    repoRoot: findRepoRoot(target),
    entries: folders.slice(0, MAX_ENTRIES).map((f) => ({ ...f, isRepo: isRepo(f.path) })),
    truncated: folders.length > MAX_ENTRIES,
  };
}

/**
 * Git repositories under `dir`, breadth-first to a few levels. Does not look
 * inside repositories or hidden/dependency folders, and stops after a time budget.
 */
export async function findRepos(dir, { maxDepth = SCAN_DEPTH, limit = SCAN_LIMIT } = {}) {
  const root = resolveDir(dir);
  if (!fs.existsSync(root)) throw new FolderError(404, `Folder not found: ${root}`);
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const repos = isRepo(root) ? [{ name: path.basename(root), path: root, isRepo: true }] : [];
  let queue = [root];
  let complete = true;
  for (let depth = 0; depth <= maxDepth && queue.length; depth += 1) {
    const next = [];
    for (const current of queue) {
      if (repos.length >= limit || Date.now() > deadline) {
        complete = false;
        break;
      }
      if (current !== root && isRepo(current)) {
        repos.push({ name: path.relative(root, current), path: current, isRepo: true });
        continue;
      }
      try {
        for (const f of await subfolders(current, { showHidden: false })) next.push(f.path);
      } catch {
        // unreadable folder: skip it
      }
    }
    if (!complete) break;
    queue = next;
  }
  return { path: root, repos: repos.sort((a, b) => a.name.localeCompare(b.name)), complete };
}

export const nativePickerAvailable = () => process.platform === 'darwin';

let pickerOpen = false;

/** Open the macOS folder chooser. Resolves to { path } or { cancelled: true }. */
export function pickFolderNative() {
  if (!nativePickerAvailable()) return Promise.reject(new FolderError(501, 'The system folder picker is only available on macOS'));
  if (pickerOpen) return Promise.reject(new FolderError(409, 'A folder picker is already open'));
  pickerOpen = true;
  const script = 'POSIX path of (choose folder with prompt "Choose a project folder")';
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 5 * 60_000 }, (error, stdout, stderr) => {
      pickerOpen = false;
      if (error) {
        if (/-128|User canceled/i.test(stderr) || error.killed) resolve({ cancelled: true });
        else reject(new FolderError(500, `The folder picker failed: ${(stderr || error.message).trim()}`));
        return;
      }
      const picked = stdout.trim().replace(/\/+$/, '') || '/';
      resolve({ path: picked });
    });
  });
}
