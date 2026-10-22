import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, writeFileAtomic } from './config.js';
import { countByPriority } from './schema.js';

const INDEX_VERSION = 1;

function indexPath() {
  return path.join(homeDir(), 'history.json');
}

/** Lowercase, filesystem-safe slug: "feature/Cart v2" -> "feature-cart-v2". */
export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';
}

/** Pick `<home>/<repo>/review-<source>-into-<dest>-<date>[-n]` with no existing .pdf/.json. */
export function reportBasePath(meta) {
  const dir = path.join(homeDir(), slug(meta.repo));
  const date = meta.createdAt.slice(0, 10);
  const stem = `review-${slug(meta.source)}-into-${slug(meta.dest)}-${date}`;
  for (let n = 1; ; n += 1) {
    const base = path.join(dir, n === 1 ? stem : `${stem}-${n}`);
    if (!fs.existsSync(`${base}.pdf`) && !fs.existsSync(`${base}.json`)) return base;
  }
}

export function entryFromReport(report, { id = crypto.randomUUID(), pdfPath, jsonPath }) {
  const { meta } = report;
  return {
    id,
    createdAt: meta.createdAt,
    repo: meta.repo,
    repoPath: meta.repoPath,
    source: meta.source,
    dest: meta.dest,
    changeType: meta.changeType,
    hasBrd: Boolean(report.brd),
    verdict: report.verdict,
    counts: countByPriority(report.findings),
    origin: meta.origin,
    model: meta.model ?? null,
    costUsd: meta.costUsd ?? null,
    durationMs: meta.durationMs ?? null,
    pdfPath,
    jsonPath,
  };
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    if (parsed?.version === INDEX_VERSION && Array.isArray(parsed.entries)) return parsed.entries;
  } catch {
    // missing or corrupt: fall through to rebuild
  }
  return rebuildIndex();
}

function writeIndex(entries) {
  writeFileAtomic(indexPath(), JSON.stringify({ version: INDEX_VERSION, entries }, null, 2));
}

/** Recreate the index by scanning saved report JSON files. */
export function rebuildIndex() {
  const home = homeDir();
  const entries = [];
  if (fs.existsSync(home)) {
    for (const dirent of fs.readdirSync(home, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const dir = path.join(home, dirent.name);
      for (const file of fs.readdirSync(dir)) {
        if (!file.startsWith('review-') || !file.endsWith('.json')) continue;
        const jsonPath = path.join(dir, file);
        try {
          const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          if (!report?.meta?.createdAt) continue;
          entries.push(entryFromReport(report, {
            id: report.meta.historyId ?? crypto.randomUUID(),
            jsonPath,
            pdfPath: jsonPath.replace(/\.json$/, '.pdf'),
          }));
        } catch {
          // not one of ours
        }
      }
    }
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  writeIndex(entries);
  return entries;
}

export function addEntry(entry) {
  const entries = readIndex().filter((e) => e.id !== entry.id);
  entries.unshift(entry);
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  writeIndex(entries);
  return entry;
}

/** Entries newest first. Drops entries whose report JSON no longer exists. */
export function listEntries({ repo, verdict, q } = {}) {
  const all = readIndex();
  const present = all.filter((e) => fs.existsSync(e.jsonPath));
  if (present.length !== all.length) writeIndex(present);
  const needle = q?.trim().toLowerCase();
  return present
    .filter((e) => !repo || e.repo === repo)
    .filter((e) => !verdict || e.verdict === verdict)
    .filter((e) => !needle || `${e.repo} ${e.source} ${e.dest}`.toLowerCase().includes(needle))
    .map((e) => ({ ...e, pdfMissing: !fs.existsSync(e.pdfPath) }));
}

export function getEntry(id) {
  return readIndex().find((e) => e.id === id) ?? null;
}

export function readReport(entry) {
  return JSON.parse(fs.readFileSync(entry.jsonPath, 'utf8'));
}

export function deleteEntry(id) {
  const entries = readIndex();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;
  for (const file of [entry.pdfPath, entry.jsonPath]) fs.rmSync(file, { force: true });
  writeIndex(entries.filter((e) => e.id !== id));
  return true;
}

export function recentRepos(limit = 10) {
  const seen = new Map();
  for (const e of readIndex()) if (!seen.has(e.repoPath)) seen.set(e.repoPath, { repo: e.repo, repoPath: e.repoPath, lastReviewed: e.createdAt });
  return [...seen.values()].slice(0, limit);
}
