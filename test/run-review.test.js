import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { claudeStatus } from '../src/agent/claude-cli.js';
import { ReviewRunError, runReview } from '../src/agent/run-review.js';
import { PLUGIN_DIR } from '../src/config.js';
import { collectGitFacts } from '../src/git.js';
import { makeRepo, useFakeClaude } from './helpers.js';

let fake;
let facts;
const inputs = { source: 'feature/coupons', dest: 'main', changeType: 'feature', description: 'Coupons' };
const config = { model: 'default', effort: 'high', maxBudgetUsd: null };

before(async () => {
  fake = useFakeClaude();
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-reach-claude';
  process.env.CLAUDECODE = '1';
  facts = await collectGitFacts(makeRepo(), 'feature/coupons', 'main');
});

const review = (overrides = {}) => {
  const events = [];
  const promise = runReview({ facts, inputs: { ...inputs, repoPath: facts.repoPath }, config, onEvent: (e) => events.push(e), ...overrides });
  return { promise, events };
};

test('claudeStatus reports the logged-in session', async () => {
  const status = await claudeStatus({ fresh: true });
  assert.deepEqual({ found: status.found, loggedIn: status.loggedIn, version: status.version, plan: status.subscriptionType }, { found: true, loggedIn: true, version: '9.9.9', plan: 'pro' });
  fake.setLoggedIn(false);
  assert.match((await claudeStatus({ fresh: true })).error, /not logged in/);
  fake.setLoggedIn(true);
});

test('a successful run returns the structured review and streams progress', async () => {
  fake.setMode('ok');
  const { promise, events } = review();
  const { review: result, run } = await promise;
  assert.equal(result.findings[0].title, 'SQL injection');
  assert.deepEqual(run, { model: 'claude-test-model', costUsd: 0.12, durationMs: 4200 });
  assert.deepEqual(events.map((e) => e.text), [
    'Started review with claude-test-model on your Claude Code session',
    'Reviewing the coupon change.',
    'Reading src/coupons.js',
    'Writing the report',
  ]);
});

test('claude is invoked headless, read-only, on the local session', async () => {
  fake.setMode('ok');
  await review().promise;
  const { args, cwd, stdin, env } = fake.lastRun();
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(cwd, facts.repoPath);
  assert.ok(args.includes('-p'));
  assert.equal(flag('--output-format'), 'stream-json');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--setting-sources'), '');
  assert.equal(flag('--tools'), 'Read,Grep,Glob,Bash,Skill');
  assert.equal(flag('--plugin-dir'), PLUGIN_DIR);
  assert.ok(!args.includes('--model'), 'the default model is left to Claude Code');
  assert.equal(JSON.parse(flag('--json-schema')).$schema, 'http://json-schema.org/draft-07/schema#');
  assert.match(JSON.parse(flag('--settings')).hooks.PreToolUse[0].hooks[0].command, /bash-guard-hook\.js/);
  assert.ok(args.includes('Bash(git diff *)') && !args.includes('Write') && !args.includes('Edit'));
  assert.match(stdin, /^\/code-review-agent:branch-review \{"mode":"headless"/);
  assert.deepEqual(env, { ANTHROPIC_API_KEY: null, CLAUDECODE: null, CLAUDE_CODE_USE_BEDROCK: null });
});

test('a chosen model is passed through', async () => {
  fake.setMode('ok');
  await runReview({ facts, inputs: { ...inputs, repoPath: facts.repoPath }, config: { ...config, model: 'claude-sonnet-5-5' } });
  const { args } = fake.lastRun();
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');
});

test('failures surface as readable errors', async () => {
  fake.setMode('auth-error');
  await assert.rejects(review().promise, (e) => e instanceof ReviewRunError && /Not logged in/.test(e.message));
  fake.setMode('no-skill');
  await assert.rejects(review().promise, /review skill did not load: manifest invalid/);
  fake.setMode('crash');
  await assert.rejects(review().promise, /exited \(code 1\).*something broke/);
});

test('cancelling stops the claude process', async () => {
  fake.setMode('hang');
  const abortController = new AbortController();
  const { promise, events } = review({ abortController });
  while (!events.some((e) => e.text?.startsWith('Running git diff'))) await new Promise((r) => setTimeout(r, 20));
  abortController.abort();
  await assert.rejects(promise, /cancelled/);
});
