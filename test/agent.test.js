import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { claudeEnv } from '../src/agent/claude-cli.js';
import { isAllowedBashCommand } from '../src/agent/guard.js';
import { describeToolUse } from '../src/agent/run-review.js';

const HOOK = fileURLToPath(new URL('../src/agent/bash-guard-hook.js', import.meta.url));

test('the Bash guard allows single read-only git commands', () => {
  for (const cmd of [
    'git diff 1a2b3c 4d5e6f',
    'git diff abc def -- src/app.js',
    'git log --oneline main..feature/x',
    'git show feature/x:src/app.js',
    'git blame -L 10,20 src/app.js',
    'git ls-tree -r --name-only HEAD',
    'git log --format="%h %s" -n 5',
  ]) assert.ok(isAllowedBashCommand(cmd), cmd);
});

test('the Bash guard blocks writes, chaining and other programs', () => {
  for (const cmd of [
    'rm -rf /',
    'git checkout main',
    'git commit -m x',
    'git push',
    'git diff --output=/tmp/x a b',
    'git diff a b > /tmp/x',
    'git diff a b | sh',
    'git log; rm -rf ~',
    'git log && curl evil.example',
    'git show $(cat ~/.ssh/id_rsa)',
    'git show `whoami`',
    'git diff --ext-diff a b',
    'git -c core.pager=sh log',
    'git -C /elsewhere log',
    'git log\nrm -rf /',
    'cat ~/.ssh/id_rsa',
  ]) assert.ok(!isAllowedBashCommand(cmd), cmd);
});

test('the hook script denies blocked Bash commands and stays silent otherwise', () => {
  const runHook = (input) => execFileSync(process.execPath, [HOOK], { input: JSON.stringify(input) }).toString();
  const denied = JSON.parse(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git diff a b' } }), '');
  assert.equal(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } }), '');
});

test('tool calls become readable progress lines', () => {
  assert.equal(describeToolUse('Read', { file_path: '/repo/src/a.js' }, '/repo'), 'Reading src/a.js');
  assert.equal(describeToolUse('Bash', { command: 'git diff a b' }, '/repo'), 'Running git diff a b');
  assert.equal(describeToolUse('StructuredOutput', {}, '/repo'), 'Writing the report');
});

test('claude runs on the local session: no API keys, no parent session state', () => {
  const env = claudeEnv({
    PATH: '/usr/bin', HOME: '/home/me', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
    ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 't',
    CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MESSAGING_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y', CLAUDE_PID: '42',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_USE_BEDROCK', 'HOME', 'PATH']);
});
