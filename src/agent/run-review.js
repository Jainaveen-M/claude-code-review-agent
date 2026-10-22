import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_DIR } from '../config.js';
import { AgentReview, agentReviewJsonSchema, formatZodError } from '../schema.js';
import { claudeEnv, findClaude } from './claude-cli.js';
import { GIT_READ_SUBCOMMANDS } from './guard.js';

export const SKILL_NAME = 'code-review-agent:branch-review';
const HOOK_SCRIPT = fileURLToPath(new URL('./bash-guard-hook.js', import.meta.url));
const MAX_TURNS = 200;
const MAX_FILES_IN_PROMPT = 400;
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Skill', ...GIT_READ_SUBCOMMANDS.map((sub) => `Bash(git ${sub} *)`)];

export class ReviewRunError extends Error {}

const shellQuote = (s) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`);

/**
 * Arguments for a headless, read-only `claude -p` run of the bundled skill.
 * No user or project settings are loaded (they could widen permissions or add
 * hooks); the skill reads CLAUDE.md itself for project conventions.
 */
export function buildClaudeArgs({ config, brd }) {
  const settings = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(HOOK_SCRIPT)}` }] }] },
  };
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--plugin-dir', PLUGIN_DIR,
    '--tools', 'Read,Grep,Glob,Bash,Skill',
    '--allowedTools', ...ALLOWED_TOOLS,
    '--permission-mode', 'dontAsk',
    '--settings', JSON.stringify(settings),
    '--json-schema', JSON.stringify(agentReviewJsonSchema()),
    '--max-turns', String(MAX_TURNS),
    ...(config.model && config.model !== 'default' ? ['--model', config.model] : []),
    ...(config.effort ? ['--effort', config.effort] : []),
    ...(config.maxBudgetUsd ? ['--max-budget-usd', String(config.maxBudgetUsd)] : []),
    ...(brd ? ['--add-dir', path.dirname(brd.path)] : []),
  ];
}

export function buildPrompt({ facts, inputs, brd }) {
  const files = facts.filesChanged.slice(0, MAX_FILES_IN_PROMPT).map((f) => (f.binary ? `${f.path} (binary)` : `${f.path} (+${f.insertions} -${f.deletions})`));
  const args = {
    mode: 'headless',
    repoPath: facts.repoPath,
    source: inputs.source,
    dest: inputs.dest,
    sourceSha: facts.sourceSha,
    mergeBase: facts.mergeBase,
    diffCommand: `git diff ${facts.mergeBase} ${facts.sourceSha}`,
    changeType: inputs.changeType,
    description: inputs.description,
    ...(brd ? { brdPath: brd.path, brdSource: brd.source } : {}),
    commitCount: facts.commitCount,
    filesChanged: files,
    ...(facts.filesChanged.length > files.length ? { moreFiles: facts.filesChanged.length - files.length } : {}),
  };
  return `/${SKILL_NAME} ${JSON.stringify(args)}`;
}

function relative(repoPath, file) {
  if (!file) return '';
  const rel = path.relative(repoPath, file);
  return rel && !rel.startsWith('..') ? rel : path.basename(file);
}

/** Short, human-readable progress line for a tool call. */
export function describeToolUse(name, input, repoPath) {
  switch (name) {
    case 'Read':
      return `Reading ${relative(repoPath, input?.file_path)}`;
    case 'Grep':
      return `Searching for "${String(input?.pattern ?? '').slice(0, 60)}"`;
    case 'Glob':
      return `Listing ${input?.pattern ?? 'files'}`;
    case 'Bash':
      return `Running ${String(input?.command ?? '').slice(0, 100)}`;
    case 'Skill':
      return 'Loading the review checklist';
    case 'StructuredOutput':
      return 'Writing the report';
    default:
      return `Using ${name}`;
  }
}

function reviewFromResult(result, { config, stderr, exitCode }) {
  if (!result) {
    const detail = stderr.trim().split('\n').slice(-3).join(' ').trim();
    throw new ReviewRunError(`Claude Code exited (code ${exitCode}) without finishing the review${detail ? `: ${detail}` : ''}`);
  }
  if (result.subtype !== 'success') {
    const reasons = {
      error_max_turns: 'the agent hit its turn limit',
      error_max_budget_usd: `the review exceeded the $${config.maxBudgetUsd} limit`,
      error_max_structured_output_retries: 'the agent could not produce a valid report',
      error_during_execution: 'Claude Code hit an error',
    };
    const detail = result.errors?.length ? `: ${result.errors.join('; ')}` : '';
    throw new ReviewRunError(`Review failed, ${reasons[result.subtype] ?? result.subtype}${detail}`);
  }
  if (result.is_error) throw new ReviewRunError(`Claude Code reported an error: ${result.result}`);
  if (!result.structured_output) throw new ReviewRunError('The agent finished without producing a report');
  const parsed = AgentReview.safeParse(result.structured_output);
  if (!parsed.success) throw new ReviewRunError(`The agent's report is invalid:\n${formatZodError(parsed.error)}`);
  return parsed.data;
}

/**
 * Run the branch-review skill with the local Claude Code CLI (`claude -p`) on the
 * user's logged-in session, and return the validated review.
 * `onEvent` receives { type: 'progress' | 'note', text } as the agent works.
 */
export function runReview({ facts, inputs, brd, config, abortController, onEvent = () => {} }) {
  const claude = findClaude();
  if (!claude) return Promise.reject(new ReviewRunError('Claude Code is not installed: no `claude` command found.'));

  return new Promise((resolve, reject) => {
    const child = spawn(claude, buildClaudeArgs({ config, brd }), { cwd: facts.repoPath, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let model = config.model;
    let result = null;
    let failure = null;
    let stdoutBuffer = '';
    let stderr = '';

    const stop = (error) => {
      failure ??= error;
      child.kill('SIGTERM');
    };
    const onAbort = () => stop(new ReviewRunError('Review cancelled'));
    abortController?.signal.addEventListener('abort', onAbort, { once: true });

    const handle = (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        model = message.model ?? model;
        if (!message.skills?.includes(SKILL_NAME)) {
          const pluginErrors = (message.plugin_errors ?? []).map((e) => e.message).join('; ');
          stop(new ReviewRunError(`The review skill did not load${pluginErrors ? `: ${pluginErrors}` : ''}`));
          return;
        }
        onEvent({ type: 'progress', text: `Started review with ${model} on your Claude Code session` });
      } else if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'tool_use') {
            onEvent({ type: 'progress', text: describeToolUse(block.name, block.input, facts.repoPath) });
          } else if (block.type === 'text' && block.text.trim()) {
            onEvent({ type: 'note', text: block.text.trim().slice(0, 400) });
          }
        }
      } else if (message.type === 'result') {
        result = message;
      }
    };

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) handle(line);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (error) => stop(new ReviewRunError(`Could not start Claude Code: ${error.message}`)));
    child.on('close', (exitCode) => {
      abortController?.signal.removeEventListener('abort', onAbort);
      if (stdoutBuffer.trim()) handle(stdoutBuffer.trim());
      if (failure) {
        reject(failure);
        return;
      }
      try {
        const review = reviewFromResult(result, { config, stderr, exitCode });
        resolve({ review, run: { model, costUsd: result.total_cost_usd, durationMs: result.duration_ms } });
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.on('error', () => {}); // the CLI may exit before reading the prompt
    child.stdin.end(buildPrompt({ facts, inputs, brd }));
  });
}
