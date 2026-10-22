#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BrdError, extractText } from '../src/brd.js';
import { claudeStatus } from '../src/agent/claude-cli.js';
import { VERSION, homeDir } from '../src/config.js';
import { GitError } from '../src/git.js';
import { InstallError, installSkill, uninstallSkill } from '../src/install.js';
import { renderReportPdf } from '../src/render-pdf.js';
import { ReportError, reportFromFile, saveReport } from '../src/report.js';
import { reviewDraftJsonSchema } from '../src/schema.js';

const HELP = `code-review-agent ${VERSION}

Review the diff between two git branches with Claude and get a PDF report.

Usage:
  code-review-agent ui [--port 4477] [--no-open]
      Start the local web UI. Reviews run on your logged-in Claude Code session (\`claude\`).

  code-review-agent install [--project] [--link] [--force]
      Install the /branch-review skill for Claude Code (~/.claude/skills, or ./.claude/skills with --project).
      --link symlinks instead of copying (for developing the skill).

  code-review-agent uninstall [--project]
      Remove the installed skill.

  code-review-agent pdf <review.json> [--out <file.pdf>] [--no-history]
      Render a review to PDF. Accepts the { inputs, review } JSON the skill writes, or a saved report.
      New reviews are added to the history shown in the UI.

  code-review-agent extract <brd.docx|.md|.txt>
      Print a BRD as plain text.

  code-review-agent schema
      Print the JSON Schema for the { inputs, review } file.

Reports and history live in ${homeDir()} (override with CODE_REVIEW_AGENT_HOME).`;

const COMMANDS = {
  async ui(args) {
    const { values } = parseArgs({ args, options: { port: { type: 'string', default: '4477' }, 'no-open': { type: 'boolean', default: false } } });
    const { startServer, openBrowser } = await import('../src/server/index.js');
    const { url } = await startServer({ port: Number(values.port) });
    console.log(`Code Review Agent is running at:\n\n  ${url}\n`);
    const claude = await claudeStatus();
    if (claude.loggedIn) {
      console.log(`Reviews run on your Claude Code session (${claude.path}, ${claude.version}${claude.subscriptionType ? `, ${claude.subscriptionType} plan` : ''}).\n`);
    } else {
      console.log(`Warning: ${claude.error}\n`);
    }
    console.log('Press Ctrl+C to stop.');
    if (!values['no-open']) openBrowser(url);
  },

  async install(args) {
    const { values } = parseArgs({ args, options: { project: { type: 'boolean' }, link: { type: 'boolean' }, force: { type: 'boolean' } } });
    const target = installSkill(values);
    console.log(`Installed the branch-review skill at ${target}\nUse it in Claude Code with /branch-review`);
  },

  async uninstall(args) {
    const { values } = parseArgs({ args, options: { project: { type: 'boolean' } } });
    const target = uninstallSkill(values);
    console.log(target ? `Removed ${target}` : 'The skill is not installed.');
  },

  async pdf(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' }, 'no-history': { type: 'boolean' } } });
    if (positionals.length !== 1) throw new ReportError('Usage: code-review-agent pdf <review.json> [--out <file.pdf>] [--no-history]');
    const file = path.resolve(positionals[0]);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new ReportError(`Could not read ${file}: ${error.message}`);
    }
    const { report, isDraft } = await reportFromFile(data);
    const out = values.out ? path.resolve(values.out) : undefined;
    if (!isDraft) {
      const target = out ?? file.replace(/\.json$/i, '') + '.pdf';
      await renderReportPdf(report, target);
      console.log(target);
      return;
    }
    const { pdfPath } = await saveReport(report, { history: !values['no-history'], pdfPath: out });
    console.log(`Verdict: ${report.verdict}\nPDF: ${pdfPath}`);
  },

  async extract(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true });
    if (positionals.length !== 1) throw new BrdError('Usage: code-review-agent extract <brd-file>');
    process.stdout.write(await extractText(path.resolve(positionals[0])));
  },

  async schema() {
    console.log(JSON.stringify(reviewDraftJsonSchema(), null, 2));
  },
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  await run(args);
}

main().catch((error) => {
  const expected = [GitError, BrdError, ReportError, InstallError].some((E) => error instanceof E) || error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
  console.error(expected ? `Error: ${error.message}` : error);
  process.exitCode = 1;
});
