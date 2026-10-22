#!/usr/bin/env node
// PreToolUse hook passed to `claude -p` via --settings: denies any Bash command
// that is not a single read-only git command. Reads the hook input on stdin.
import { DENY_REASON, isAllowedBashCommand } from './guard.js';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // unparseable input: deny below
  }
  if (input.tool_name !== 'Bash' || isAllowedBashCommand(input.tool_input?.command)) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON },
  }));
});
