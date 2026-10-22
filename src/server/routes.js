import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BrdError } from '../brd.js';
import { claudeStatus } from '../agent/claude-cli.js';
import { VERSION, readConfig, writeConfig } from '../config.js';
import { FolderError, findRepos, listFolder, nativePickerAvailable, pickFolderNative } from '../folders.js';
import { GitError, fetchRemotes, listBranches, repoRoot } from '../git.js';
import { deleteEntry, getEntry, listEntries, readReport, recentRepos } from '../history.js';
import { ReportError } from '../report.js';
import { CHANGE_TYPES, formatZodError } from '../schema.js';
import { BusyError, activeRun, getRun, isTerminal, startRun } from './runs.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Errors whose message is safe and useful to show the user as a 400. */
export const isUserError = (error) =>
  error instanceof GitError || error instanceof BrdError || error instanceof ReportError || error instanceof BusyError;

const ReviewRequest = z.object({
  repoPath: z.string().min(1),
  source: z.string().min(1),
  dest: z.string().min(1),
  changeType: z.enum(CHANGE_TYPES),
  description: z.string().trim().min(1, 'Describe what you fixed or changed').max(10_000),
  fetch: z.boolean().default(false),
  brd: z.union([
    z.object({ name: z.string().min(1), base64: z.string().min(1) }),
    z.object({ text: z.string().min(1) }),
  ]).optional(),
});

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function status(ctx, req, res, url) {
  const active = activeRun();
  sendJson(res, 200, {
    version: VERSION,
    claude: await claudeStatus({ fresh: url.searchParams.get('fresh') === '1' }),
    config: readConfig(),
    launchRepo: ctx.launchRepo,
    nativeFolderPicker: nativePickerAvailable(),
    activeRun: active ? active.summary() : null,
  });
}

async function recent(ctx, req, res) {
  sendJson(res, 200, { repos: recentRepos() });
}

async function branches(ctx, req, res, url) {
  const repo = await repoRoot(url.searchParams.get('repo') ?? '');
  const fetched = url.searchParams.get('fetch') === '1' ? await fetchRemotes(repo) : null;
  sendJson(res, 200, { repoPath: repo, repo: path.basename(repo), ...(await listBranches(repo)), warning: fetched?.warning ?? null });
}

/** Run a folders.js call, turning its errors into HTTP errors. */
async function folderCall(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof FolderError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

async function folders(ctx, req, res, url) {
  const dir = url.searchParams.get('path') || ctx.launchRepo || '';
  sendJson(res, 200, await folderCall(() => listFolder(dir, { showHidden: url.searchParams.get('hidden') === '1' })));
}

async function folderRepos(ctx, req, res, url) {
  sendJson(res, 200, await folderCall(() => findRepos(url.searchParams.get('path') || '')));
}

async function pickFolder(ctx, req, res) {
  sendJson(res, 200, await folderCall(() => pickFolderNative()));
}

async function getConfig(ctx, req, res) {
  sendJson(res, 200, readConfig());
}

async function putConfig(ctx, req, res) {
  try {
    sendJson(res, 200, writeConfig(await ctx.readJson(req)));
  } catch (error) {
    throw new HttpError(400, error.message);
  }
}

async function createReview(ctx, req, res) {
  const claude = await claudeStatus({ fresh: true });
  if (!claude.loggedIn) throw new HttpError(400, claude.error);
  const parsed = ReviewRequest.safeParse(await ctx.readJson(req));
  if (!parsed.success) throw new HttpError(400, `Invalid request:\n${formatZodError(parsed.error)}`);
  const request = parsed.data;
  if (request.changeType !== 'feature') delete request.brd;
  request.repoPath = await repoRoot(request.repoPath);
  const run = startRun(request, readConfig());
  sendJson(res, 202, { runId: run.id });
}

async function reviewEvents(ctx, req, res, url, [id]) {
  const run = getRun(id);
  if (!run) throw new HttpError(404, 'Unknown review run');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  let unsubscribe = null;
  let ended = false;
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe?.();
    res.end();
  };
  unsubscribe = run.subscribe((event) => {
    if (ended) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (isTerminal(event)) {
      ended = true;
      setImmediate(close);
    }
  });
  req.on('close', close);
}

async function cancelReview(ctx, req, res, url, [id]) {
  const run = getRun(id);
  if (!run) throw new HttpError(404, 'Unknown review run');
  if (run.status === 'running') run.abortController.abort();
  sendJson(res, 200, { status: run.status });
}

async function history(ctx, req, res, url) {
  const p = url.searchParams;
  sendJson(res, 200, { entries: listEntries({ repo: p.get('repo') || undefined, verdict: p.get('verdict') || undefined, q: p.get('q') || undefined }) });
}

function requireEntry(id) {
  const entry = getEntry(id);
  if (!entry) throw new HttpError(404, 'No such report');
  return entry;
}

async function historyItem(ctx, req, res, url, [id]) {
  const entry = requireEntry(id);
  sendJson(res, 200, { entry, report: readReport(entry) });
}

async function historyPdf(ctx, req, res, url, [id]) {
  const entry = requireEntry(id);
  if (!fs.existsSync(entry.pdfPath)) throw new HttpError(404, 'The PDF file was moved or deleted');
  const name = path.basename(entry.pdfPath).replace(/[^\w.-]/g, '_');
  const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${disposition}; filename="${name}"`,
    'Content-Length': fs.statSync(entry.pdfPath).size,
  });
  fs.createReadStream(entry.pdfPath).pipe(res);
}

async function deleteHistory(ctx, req, res, url, [id]) {
  requireEntry(id);
  deleteEntry(id);
  sendJson(res, 200, { deleted: id });
}

export const routes = [
  ['GET', /^\/api\/status$/, status],
  ['GET', /^\/api\/repos\/recent$/, recent],
  ['GET', /^\/api\/branches$/, branches],
  ['GET', /^\/api\/folders$/, folders],
  ['GET', /^\/api\/folders\/repos$/, folderRepos],
  ['POST', /^\/api\/folders\/pick$/, pickFolder],
  ['GET', /^\/api\/config$/, getConfig],
  ['PUT', /^\/api\/config$/, putConfig],
  ['POST', /^\/api\/reviews$/, createReview],
  ['GET', /^\/api\/reviews\/([\w-]+)\/events$/, reviewEvents],
  ['POST', /^\/api\/reviews\/([\w-]+)\/cancel$/, cancelReview],
  ['GET', /^\/api\/history$/, history],
  ['GET', /^\/api\/history\/([\w-]+)$/, historyItem],
  ['GET', /^\/api\/history\/([\w-]+)\/pdf$/, historyPdf],
  ['DELETE', /^\/api\/history\/([\w-]+)$/, deleteHistory],
];

export { sendJson };
