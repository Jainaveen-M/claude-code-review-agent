#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Behaviour is set by FAKE_CLAUDE_MODE:
// ok | auth-error | no-skill | crash | hang (FAKE_CLAUDE_DELAY_MS slows down 'ok'). Each run records its argv, cwd, stdin
// and selected env vars to FAKE_CLAUDE_LOG (JSON) for assertions.
import fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';

if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_IN !== '0';
  console.log(JSON.stringify(loggedIn ? { loggedIn, authMethod: 'claude.ai', subscriptionType: 'pro' } : { loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const review = {
  verdict: 'APPROVE',
  confidence: 'HIGH',
  summary: 'Adds coupons with a lookup that concatenates SQL.',
  intentCheck: { matchesDescription: 'yes', rootCauseAddressed: 'not_applicable', testsAdded: false, notes: 'src/coupons.js:1' },
  findings: [{ priority: 'P0', title: 'SQL injection', file: 'src/coupons.js', line: 2, category: 'security', description: 'Concatenated SQL.', suggestion: "db.query('... = $1', [code])" }],
  recommendation: 'Parameterize the query.',
};

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    const env = Object.fromEntries(['ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK'].map((k) => [k, process.env[k] ?? null]));
    fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), stdin, env }));
  }
  if (mode === 'crash') {
    process.stderr.write('Error: something broke\n');
    process.exit(1);
  }
  emit({
    type: 'system',
    subtype: 'init',
    model: 'claude-test-model',
    skills: mode === 'no-skill' ? [] : ['code-review-agent:branch-review'],
    ...(mode === 'no-skill' ? { plugin_errors: [{ message: 'manifest invalid' }] } : {}),
  });
  if (mode === 'no-skill' || mode === 'hang') {
    if (mode === 'hang') emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git diff a b' } }] } });
    setTimeout(() => {}, 60_000);
    return;
  }
  if (mode === 'auth-error') {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', total_cost_usd: 0, duration_ms: 10 });
    return;
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reviewing the coupon change.' }, { type: 'tool_use', name: 'Read', input: { file_path: `${process.cwd()}/src/coupons.js` } }] } });
  setTimeout(() => {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: review }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: review, total_cost_usd: 0.12, duration_ms: 4200 });
  }, Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0));
});
