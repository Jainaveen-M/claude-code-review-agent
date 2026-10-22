// The review agent may run only these read-only git subcommands.
export const GIT_READ_SUBCOMMANDS = ['diff', 'log', 'show', 'merge-base', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'cat-file', 'rev-list'];

export const DENY_REASON = 'This review is read-only: run one read-only git command at a time (diff, log, show, blame, ...) without pipes or redirection. Use the Read, Grep and Glob tools for files.';

/**
 * Allow a single read-only git command and nothing else, whatever permission
 * rules the environment may add. Blocks chaining, redirection, substitution,
 * and git flags that write files or run programs.
 */
export function isAllowedBashCommand(command) {
  const cmd = String(command ?? '').trim();
  if (!/^git\s/.test(cmd)) return false;
  if (/[;&|`$<>(){}\\\n\r]/.test(cmd)) return false;
  if (/(^|\s)(--output|--ext-diff|--textconv|--exec|--upload-pack|--open-files-in-pager|-O)(=|\s|$)/.test(cmd)) return false;
  const subcommand = cmd.split(/\s+/)[1];
  return GIT_READ_SUBCOMMANDS.includes(subcommand);
}
