import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runReview } from '../agent/run-review.js';
import { saveBrd } from '../brd.js';
import { homeDir } from '../config.js';
import { collectGitFacts, fetchRemotes } from '../git.js';
import { buildReport, saveReport } from '../report.js';

const KEEP_FINISHED_RUNS = 20;
const TERMINAL = new Set(['done', 'error', 'cancelled']);
const runs = new Map();

export class BusyError extends Error {}

class Run {
  constructor(request) {
    this.id = crypto.randomUUID();
    this.status = 'running';
    this.request = { repoPath: request.repoPath, source: request.source, dest: request.dest, changeType: request.changeType, hasBrd: Boolean(request.brd) };
    this.startedAt = new Date().toISOString();
    this.events = [];
    this.listeners = new Set();
    this.abortController = new AbortController();
  }

  emit(event) {
    const stamped = { ...event, at: new Date().toISOString() };
    this.events.push(stamped);
    for (const listener of this.listeners) listener(stamped);
  }

  /** Replay past events, then stream new ones. Returns an unsubscribe function. */
  subscribe(listener) {
    for (const event of this.events) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary() {
    return { id: this.id, status: this.status, startedAt: this.startedAt, ...this.request };
  }
}

export const isTerminal = (event) => TERMINAL.has(event.type);

export function getRun(id) {
  return runs.get(id) ?? null;
}

export function activeRun() {
  return [...runs.values()].find((r) => r.status === 'running') ?? null;
}

function prune() {
  const finished = [...runs.values()].filter((r) => r.status !== 'running');
  for (const run of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_RUNS))) runs.delete(run.id);
}

async function execute(run, request, config) {
  const runDir = path.join(homeDir(), '.runs', run.id);
  try {
    run.emit({ type: 'phase', phase: 'compare' });
    if (request.fetch) {
      run.emit({ type: 'progress', text: 'Fetching remotes' });
      const { warning } = await fetchRemotes(request.repoPath);
      if (warning) run.emit({ type: 'warning', text: warning });
    }
    run.emit({ type: 'progress', text: `Comparing ${request.source} with ${request.dest}` });
    const facts = await collectGitFacts(request.repoPath, request.source, request.dest);
    run.emit({
      type: 'progress',
      text: `${facts.commitCount} commits, ${facts.stats.files} files changed (+${facts.stats.insertions} / -${facts.stats.deletions})`,
    });
    run.emit({
      type: 'facts',
      facts: { repo: facts.repo, commitCount: facts.commitCount, commits: facts.commits.slice(0, 20), stats: facts.stats, filesChanged: facts.filesChanged },
    });

    let brd = null;
    if (request.brd) {
      run.emit({ type: 'phase', phase: 'brd' });
      brd = await saveBrd(runDir, request.brd);
      run.emit({ type: 'progress', text: `Loaded BRD: ${brd.source}` });
    }
    const inputs = {
      repoPath: facts.repoPath,
      source: request.source,
      dest: request.dest,
      changeType: request.changeType,
      description: request.description,
      ...(brd ? { brdSource: brd.source } : {}),
    };

    run.emit({ type: 'phase', phase: 'review' });
    const { review, run: runInfo } = await runReview({
      facts, inputs, brd, config, abortController: run.abortController, onEvent: (event) => run.emit(event),
    });
    run.emit({ type: 'phase', phase: 'report' });
    run.emit({ type: 'progress', text: 'Rendering the PDF' });
    const { entry } = await saveReport(buildReport({ facts, inputs, review, origin: 'ui', run: runInfo }));
    run.status = 'done';
    run.emit({ type: 'done', entry });
  } catch (error) {
    if (run.abortController.signal.aborted) {
      run.status = 'cancelled';
      run.emit({ type: 'cancelled', text: 'Review cancelled' });
    } else {
      run.status = 'error';
      run.emit({ type: 'error', text: error.message });
    }
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    prune();
  }
}

/** Start a review in the background. Only one review runs at a time. */
export function startRun(request, config) {
  if (activeRun()) throw new BusyError('A review is already running. Wait for it to finish or cancel it.');
  const run = new Run(request);
  runs.set(run.id, run);
  run.emit({ type: 'progress', text: 'Review queued' });
  execute(run, request, config);
  return run;
}
