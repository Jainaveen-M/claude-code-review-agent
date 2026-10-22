# claude-code-review-agent

Review everything a branch adds before you merge it, and get the result as a PDF.

You pick a **source** and **destination** branch and say **what you fixed or changed**. For features, you can attach the **BRD**. Claude then reviews the diff (what a pull request would show) and checks three things:

- **Does the code do what you said?** For bug fixes: is the root cause fixed or only the symptom, and is there a regression test?
- **Does it meet the BRD?** Each requirement is marked implemented, partial, missing or not verifiable, with `file:line` evidence. It also lists changes that trace back to no requirement.
- **Is it correct and safe?** Security, correctness, performance, data integrity and code quality, ranked P0 (critical) to P3 (suggestion), with suggested fixes.

Every review is saved as a PDF and listed in a local web UI, where you can view, download or delete past reports.

## Requirements

- Node.js 18 or newer, and git
- [Claude Code](https://code.claude.com) installed and logged in. Check with `claude auth status`.

Reviews run on your local Claude Code session: the UI starts `claude` in headless mode (`claude -p`). No API key is needed. If `ANTHROPIC_API_KEY` is set in your shell, it's removed for the review, so the review always uses your login. Each review counts toward your Claude plan's usage limits. The UI shows Claude Code's API-equivalent cost estimate for each review; on a subscription that's an estimate, not a charge.

## Install

```bash
npm install -g claude-code-review-agent
```

## Use the web UI

```bash
cd ~/projects/my-repo        # optional: preselects this repo
code-review-agent ui
```

This opens `http://127.0.0.1:4477`:

- **New review** walks you through five steps:
  1. **Project:** the repo you launched from, a recent project, or **Browse folders…** (git repos are marked; **Find git repos here** lists every repo a few levels down).
  2. **Branches:** pick your branch and the one it merges into from searchable lists. A live preview shows the commits and files that will be reviewed before anything runs.
  3. **What changed:** bug fix, feature, refactor or other, plus your description (with tips, and a button to start from your commit messages).
  4. **BRD** (features only): drag in a PDF, Word, Markdown or text file, paste the text, or skip.
  5. **Review:** check your choices and start.
- **Live review:** progress through the phases, a file tree that lights up as Claude reads each changed file, and an activity feed. You can cancel at any time.
- **Report:** an overview (verdict, summary, recommendation, intent check, top findings); **Code & findings**, the diff with every finding pinned to its line (filter by priority, step through findings, copy suggested fixes); and a **BRD checklist** with coverage, status filters and evidence links that jump to the code.
- **History:** a dashboard with totals, reviews over time by verdict, findings by priority and reviews by repository. Click any bar or legend entry to filter the whole page. Every chart has a data table, and the table below lists every report.

The reviewed diff is saved with each report, so the code view keeps working after branches are rebased or deleted.

Under **Settings** you can pick the model (by default, whatever Claude Code uses on your plan) and the effort level. You can also stop reviews above an estimated cost.

## Use it inside Claude Code

```bash
code-review-agent install            # adds /branch-review to ~/.claude/skills
code-review-agent install --project  # or only for the current repo
```

Then run `/branch-review` in Claude Code, or `/branch-review feature/x main`. Claude asks the same questions in the chat, writes the review, and runs `code-review-agent pdf` to save it. Chat reviews appear in the UI's History too, marked `chat`.

## Where reports are saved

```
~/code-reviews/
├── history.json                          # index shown in the UI
├── config.json                           # UI settings
└── <repo>/
    ├── review-<source>-into-<dest>-<date>.pdf
    └── review-<source>-into-<dest>-<date>.json
```

Set `CODE_REVIEW_AGENT_HOME` to use another folder, and `CODE_REVIEW_AGENT_CLAUDE` to point at a `claude` binary that isn't on your `PATH`. If `history.json` is lost, it's rebuilt from the `.json` files.

## Commands

| Command | What it does |
|---|---|
| `code-review-agent ui [--port 4477] [--no-open]` | Start the web UI |
| `code-review-agent install [--project] [--link] [--force]` | Install the `/branch-review` skill (`--link` symlinks it, for developing the skill) |
| `code-review-agent uninstall [--project]` | Remove the skill |
| `code-review-agent pdf <review.json> [--out file.pdf] [--no-history]` | Render a review to PDF. Takes the skill's `{ inputs, review }` file or re-renders a saved report |
| `code-review-agent extract <brd.docx>` | Print a Word/Markdown/text BRD as plain text |
| `code-review-agent schema` | Print the JSON Schema of the review file |

## Security and privacy

- The diff, the files Claude reads and the BRD are sent to Claude through your Claude Code session, as in any Claude Code chat.
- The UI server listens on `127.0.0.1` only. Every API call needs the random token in the URL the command prints, and requests for other host names are rejected.
- The reviewing agent is read-only:
  - it can use only Read, Grep, Glob and single read-only git commands (`diff`, `log`, `show`, `blame`, …)
  - a hook blocks pipes, redirection and file-writing git flags
  - it runs with no user or project settings, hooks or MCP servers, and isn't saved to your session history
- Review text is shown as plain text in the UI, never as HTML.

## Limitations

- The PDF uses the standard PDF fonts, which cover Latin scripts only. Common symbols such as → and ≥ are converted to ASCII, and other characters (e.g. emoji, CJK) appear as `?`.
- One review runs at a time per UI server.
- The folder browser shows macOS/Linux-style paths. On Windows, type or paste the repository path instead.

## Development

```bash
npm install
npm test
npm link && code-review-agent install --link   # try the CLI and the skill from this checkout
```

## License

MIT
