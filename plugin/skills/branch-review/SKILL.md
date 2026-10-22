---
name: branch-review
description: "Review the changes between a source and a destination git branch, check them against what the author says they fixed or a BRD (business requirements document), and produce a PDF code review report. Use when the user asks to review a branch, review changes before merging or opening a PR, compare two branches, check a feature against its BRD or requirements, or wants a code review report as a PDF."
---

# Branch Review

Review what the source branch adds relative to the destination branch (pull request semantics: diff from the merge base), judge it against the author's own description of the change and, for features, against the BRD, and produce a structured review.

Arguments: $ARGUMENTS

## Choose the mode

- **Headless**: the arguments are a JSON object with `"mode": "headless"`. All inputs are already in it: `repoPath`, `source`, `dest`, `sourceSha`, `mergeBase`, `diffCommand`, `changeType`, `description`, `filesChanged`, and `brdPath`/`brdSource` when a BRD was given. Never ask questions and never write files. Do the review (steps 2–4 below) and return it through the structured output only.
- **Interactive**: anything else. Follow all steps below.

## 1. Gather inputs (interactive only)

Skip any question the arguments already answer (e.g. `/branch-review feature/x main`). Use AskUserQuestion when available, otherwise ask in plain text, one round at a time:

1. Confirm the repository: the current directory's repo (`git rev-parse --show-toplevel`). If not in a repo, ask for the path.
2. Run `git fetch --quiet --prune` if the repo has a remote, then list branches with `git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads refs/remotes`.
   - **Source branch** (the branch with the changes): offer the current branch and the most recently committed ones.
   - **Destination branch** (where it will be merged): offer whichever of `main`, `master`, `develop` exist.
3. **Change type**: Bug fix / Feature / Refactor / Other.
4. **What did you fix or change?** Free text. Required: the review checks the code against it.
5. **Only for Feature**: "Is a BRD available?" If yes, get a file path (PDF, .docx, .md, .txt) or pasted text. If no, continue with a standard review.

Then compute: `git merge-base <dest> <source>` and use `git diff <merge-base> <source>` as the diff. If it is empty, tell the user there is nothing to review and stop.

## 2. Read the change

- Read `CLAUDE.md`, `AGENTS.md` or `CONTRIBUTING.md` at the repo root if present: they define the project's conventions.
- Get the diff with the diff command (headless: `diffCommand`). For many files, diff file by file: `git diff <merge-base> <source> -- <path>`.
- Read each changed file in full at the source version (`git show <source>:<path>`), not only the hunks, to understand context.
- Skip lockfiles, generated or build output (`dist/`, `build/`), minified files and snapshots; mention that they were skipped only if relevant.
- Run git from the repository root (no `-C`). In headless mode Bash is limited to single read-only git commands (no pipes or redirection); use Read, Grep and Glob for everything else.

## 3. Read the BRD (if given)

- PDF: open it with the Read tool (use the `pages` parameter for documents over 10 pages).
- `.docx` (interactive): `code-review-agent extract <file>`. Headless already converted it to text.
- Markdown / text: Read it.

Extract the requirements as a numbered list (`REQ-1…n`, or the BRD's own IDs) with their acceptance criteria. Ignore background and narrative sections.

## 4. Review

Apply [references/review-checklist.md](references/review-checklist.md). Only flag issues introduced by this change.

- **Intent check** (always): does the diff do what the author described? For bug fixes, is the root cause fixed or only the symptom, and is there a regression test? Cite `file:line` evidence in `notes`.
- **BRD check** (when given): mark each requirement `implemented`, `partial`, `missing` or `not_verifiable` (e.g. lives in another service), with `file:line` evidence. List changes that trace back to no requirement under `outOfScopeChanges`. Unmet requirements also become findings (category `requirements`).
- **Findings**: priority, title, file, line (in the source version), category, description, and a `suggestion` with code for every P0 and P1.
- **Verdict**: `APPROVE` only with no P0/P1 findings; `REQUEST_CHANGES` when there are; `NEEDS_DISCUSSION` when the right call depends on context the author must supply.

## 5. Produce the report

**Headless**: return the review through the structured output. Done.

**Interactive**: write this JSON to a temporary file (e.g. `/tmp/branch-review-<timestamp>.json`). The exact schema is in [references/report-schema.md](references/report-schema.md), or run `code-review-agent schema`.

```json
{ "inputs": { "repoPath": "...", "source": "...", "dest": "...", "changeType": "feature", "description": "...", "brdSource": "file name or \"pasted text\"" },
  "review": { "verdict": "...", "confidence": "...", "summary": "...", "intentCheck": {...}, "brd": {...}, "findings": [...], "recommendation": "..." } }
```

Then render it (this also adds it to the history shown in `code-review-agent ui`):

```bash
code-review-agent pdf /tmp/branch-review-<timestamp>.json
# if code-review-agent is not installed:
npx -y claude-code-review-agent pdf /tmp/branch-review-<timestamp>.json
```

If the command reports invalid fields, fix the JSON and run it again. Finally, reply with the verdict, the finding counts per priority, the top issues in one line each, and the PDF path. Do not paste the whole report.
