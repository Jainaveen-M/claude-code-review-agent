import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { saveReport } from '../src/report.js';
import { Report } from '../src/schema.js';
import { startServer } from '../src/server/index.js';
import { loadFixture, makeRepo, useFakeClaude, useTempHome } from './helpers.js';

let server;
let repo;
let base;
let fake;

before(async () => {
  useTempHome();
  fake = useFakeClaude();
  repo = makeRepo();
  server = await startServer({ port: 0, token: 'test-token' });
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
});

const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { 'X-CRA-Token': 'test-token', ...init.headers } });

function rawRequest(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the UI with security headers', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Code Review Agent/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('API calls need the token', async () => {
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: { 'X-CRA-Token': 'wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/api/status?t=test-token`)).status, 200);
});

test('requests for another host name are rejected (DNS rebinding)', async () => {
  assert.equal(await rawRequest('/api/status?t=test-token', { Host: `evil.example:${server.port}` }), 403);
  assert.equal(await rawRequest('/api/status?t=test-token', { Host: `localhost:${server.port}` }), 200);
});

test('status reports the Claude Code session', async () => {
  const status = await (await api('/api/status?fresh=1')).json();
  assert.equal(status.claude.loggedIn, true);
  assert.equal(status.claude.subscriptionType, 'pro');
  assert.equal(status.config.model, 'default');
});

test('lists branches for a repository', async () => {
  const data = await (await api(`/api/branches?repo=${encodeURIComponent(repo)}`)).json();
  assert.equal(data.repoPath, repo);
  assert.equal(data.defaultDest, 'main');
  assert.ok(data.branches.some((b) => b.name === 'feature/coupons'));
  const bad = await api('/api/branches?repo=%2Fnot%2Fa%2Frepo');
  assert.equal(bad.status, 400);
});

const postReview = (body) => api('/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const request = (overrides = {}) => ({ repoPath: repo, source: 'feature/coupons', dest: 'main', changeType: 'feature', description: 'Added coupons', ...overrides });

test('browses folders and finds repositories', async () => {
  const parent = path.dirname(repo);
  const listing = await (await api(`/api/folders?path=${encodeURIComponent(parent)}`)).json();
  assert.equal(listing.path, parent);
  assert.ok(listing.entries.some((e) => e.path === repo && e.isRepo));
  const scan = await (await api(`/api/folders/repos?path=${encodeURIComponent(repo)}`)).json();
  assert.deepEqual(scan.repos.map((r) => r.path), [repo]);
  assert.equal((await api('/api/folders?path=%2Fno%2Fsuch%2Ffolder')).status, 404);
  assert.equal((await fetch(`${base}/api/folders?path=%2F`)).status, 401, 'folder listing needs the token too');
  const status = await (await api('/api/status')).json();
  assert.equal(status.nativeFolderPicker, process.platform === 'darwin');
});

test('starting a review when Claude Code is logged out explains what to do', async () => {
  fake.setLoggedIn(false);
  try {
    const res = await postReview(request());
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not logged in/);
  } finally {
    fake.setLoggedIn(true);
  }
});

test('invalid review requests are rejected before claude runs', async () => {
  const res = await postReview(request({ description: '' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /description/);
  const notJson = await api('/api/reviews', { method: 'POST', body: 'x' });
  assert.equal(notJson.status, 415);
});

/** Collect SSE events for a run until a terminal one arrives. */
async function runEvents(runId) {
  const res = await api(`/api/reviews/${runId}/events`);
  const text = await res.text();
  return text.split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6)));
}

test('preview shows what a review would cover, without running claude', async () => {
  const params = new URLSearchParams({ repo, source: 'feature/coupons', dest: 'main' });
  const preview = await (await api(`/api/preview?${params}`)).json();
  assert.equal(preview.commitCount, 1);
  assert.equal(preview.behind, 0);
  assert.deepEqual(preview.filesChanged.map((f) => f.path).sort(), ['src/checkout.js', 'src/coupons.js']);
  const empty = await api(`/api/preview?${new URLSearchParams({ repo, source: 'noop', dest: 'main' })}`);
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /No changes/);
});

test('branches include the last commit subject and author', async () => {
  const { branches } = await (await api(`/api/branches?repo=${encodeURIComponent(repo)}`)).json();
  const coupons = branches.find((b) => b.name === 'feature/coupons');
  assert.equal(coupons.subject, 'Add coupons');
  assert.equal(coupons.author, 'Test');
});

test('static files are served from web/ only', async () => {
  assert.equal((await fetch(`${base}/js/main.js`)).status, 200);
  assert.match((await fetch(`${base}/js/main.js`)).headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/js/missing.js`)).status, 404);
  assert.equal(await rawRequest('/%2e%2e/package.json', { Host: `127.0.0.1:${server.port}` }), 404);
  assert.equal(await rawRequest('/../src/config.js', { Host: `127.0.0.1:${server.port}` }), 404);
});

test('a full review: claude runs, the PDF is saved and appears in history', async () => {
  fake.setMode('ok');
  const res = await postReview(request({ brd: { text: 'REQ-1 Customers can enter a coupon code.' } }));
  assert.equal(res.status, 202);
  const { runId } = await res.json();
  const events = await runEvents(runId);
  const done = events.at(-1);
  assert.equal(done.type, 'done', JSON.stringify(events));
  assert.ok(events.some((e) => e.text === 'Loaded BRD: pasted text'));
  assert.equal(done.entry.verdict, 'REQUEST_CHANGES', 'APPROVE with a P0 is corrected');
  assert.equal(done.entry.origin, 'ui');
  assert.equal(done.entry.costUsd, 0.12);
  const pdf = await api(`/api/history/${done.entry.id}/pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(fake.lastRun().stdin, /"brdSource":"pasted text"/);
  assert.deepEqual(events.filter((e) => e.type === 'phase').map((e) => e.phase), ['compare', 'brd', 'review', 'report']);
  assert.deepEqual(events.find((e) => e.type === 'facts').facts.filesChanged.map((f) => f.path).sort(), ['src/checkout.js', 'src/coupons.js']);
  assert.ok(events.some((e) => e.type === 'progress' && e.tool === 'Read' && e.file === 'src/coupons.js'), 'file activity is reported');
  const info = await (await api(`/api/reviews/${runId}`)).json();
  assert.deepEqual({ source: info.source, dest: info.dest, hasBrd: info.hasBrd, status: info.status }, { source: 'feature/coupons', dest: 'main', hasBrd: true, status: 'done' });
  const diff = await api(`/api/history/${done.entry.id}/diff`);
  assert.equal(diff.status, 200);
  assert.match(await diff.text(), /^diff --git a\/src\/checkout\.js/m);
  assert.equal((await api(`/api/history/${done.entry.id}`, { method: 'DELETE' })).status, 200);
});

test('a failed review reports the error', async () => {
  fake.setMode('auth-error');
  const { runId } = await (await postReview(request())).json();
  const done = (await runEvents(runId)).at(-1);
  assert.equal(done.type, 'error');
  assert.match(done.text, /Not logged in/);
  fake.setMode('ok');
});

test('history: list, detail, PDF download, delete', async () => {
  const { entry } = await saveReport(Report.parse(loadFixture('sample-report.json')));
  const { entries } = await (await api('/api/history')).json();
  assert.deepEqual(entries.map((e) => e.id), [entry.id]);

  const detail = await (await api(`/api/history/${entry.id}`)).json();
  assert.equal(detail.report.verdict, 'REQUEST_CHANGES');

  const pdf = await api(`/api/history/${entry.id}/pdf?download=1`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="review-/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  assert.equal((await api(`/api/history/${entry.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/history/${entry.id}`)).status, 404);
});
