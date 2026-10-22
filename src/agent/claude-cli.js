import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATUS_TTL_MS = 30_000;
// Variables a parent Claude Code session sets for its child processes. Inheriting them
// would make the review a child of that session instead of a normal headless run.
const INHERITED_SESSION_VAR = /^(CLAUDECODE$|CLAUDE_CODE_(?!USE_|SKIP_)|CLAUDE_PID$|CLAUDE_AGENT_SDK_|CLAUDE_EFFORT$)/;
// Reviews run on the local Claude Code login, never on an API key from the shell.
const API_KEY_VARS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

let cachedStatus = null;

/** Environment for `claude`: the user's environment minus session state and API keys. */
export function claudeEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !INHERITED_SESSION_VAR.test(key) && !API_KEY_VARS.has(key)));
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Path of the Claude Code CLI: $CODE_REVIEW_AGENT_CLAUDE, then PATH, then the default install folders. */
export function findClaude(env = process.env) {
  if (env.CODE_REVIEW_AGENT_CLAUDE) return isExecutable(env.CODE_REVIEW_AGENT_CLAUDE) ? env.CODE_REVIEW_AGENT_CLAUDE : null;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [
    ...String(env.PATH ?? '').split(path.delimiter).filter(Boolean),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.claude', 'local'),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutable(file)) return file;
    }
  }
  return null;
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { env: claudeEnv(), timeout: 15_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

/**
 * Whether Claude Code is installed and logged in, from `claude --version` and
 * `claude auth status` (neither uses any model tokens). Cached briefly.
 */
export async function claudeStatus({ fresh = false } = {}) {
  if (!fresh && cachedStatus && Date.now() - cachedStatus.checkedAt < STATUS_TTL_MS) return cachedStatus.value;
  const file = findClaude();
  let value;
  if (!file) {
    value = { found: false, loggedIn: false, error: 'Claude Code is not installed (no `claude` command found).' };
  } else {
    const [version, auth] = await Promise.all([run(file, ['--version']), run(file, ['auth', 'status'])]);
    let info = {};
    try {
      info = JSON.parse(auth.stdout);
    } catch {
      // older CLI or unexpected output
    }
    value = {
      found: true,
      path: file,
      version: version.stdout.trim().split(/\s/)[0] || null,
      loggedIn: info.loggedIn === true,
      authMethod: info.authMethod ?? null,
      subscriptionType: info.subscriptionType ?? null,
      error: info.loggedIn === true ? null : 'Claude Code is not logged in. Run `claude` in a terminal and sign in, then try again.',
    };
  }
  cachedStatus = { checkedAt: Date.now(), value };
  return value;
}
