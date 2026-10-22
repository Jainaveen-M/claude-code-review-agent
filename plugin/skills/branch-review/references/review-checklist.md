# Review checklist

## Priority levels

| Level | Meaning | Action |
|-------|---------|--------|
| P0 | Critical: security vulnerability, data loss risk, crash | Must fix |
| P1 | Major: significant bug, performance regression, broken feature, unmet must-have requirement | Must fix |
| P2 | Minor: code smell, clarity issue, inconsistency, missing tests | Nice to fix |
| P3 | Suggestion: improvement idea, optional refactor | Optional |

## Critical issues (P0–P1)

**Correctness** (`correctness`)
- Logic errors and off-by-one mistakes
- Unhandled edge cases (null, empty, boundary values)
- Broken control flow (early returns, missing breaks, swallowed errors)
- Incorrect type conversions or comparisons
- State mutation side effects

**Security** (`security`)
- Injection (SQL, command, XSS, path traversal)
- Exposed secrets, tokens or credentials
- Unsafe deserialization
- Missing input validation at system boundaries
- Missing or wrong authorization checks

**Performance** (`performance`)
- Quadratic work where linear is possible
- N+1 queries or unbounded database calls
- Memory leaks or unbounded growth
- Missing pagination on large datasets
- Blocking operations in async contexts

**Data integrity** (`data-integrity`)
- Race conditions in concurrent code
- Missing transactions for multi-step writes
- Data loss on error paths
- Inconsistent state after partial failures
- Migrations that can't be rolled back or that lock large tables

## Code quality (P2–P3)

- **Testing** (`testing`): new behaviour or a bug fix without tests; tests that don't assert the behaviour.
- **Clarity** (`clarity`): needless complexity, deep nesting, vague names, nested ternaries, magic numbers.
- **Consistency** (`consistency`): breaks the project's conventions (CLAUDE.md / CONTRIBUTING.md), mixed patterns for one concern.
- **Maintainability** (`maintainability`): duplicated logic, tight coupling, over-engineering, dead code.
- **Simplification** (`simplification`): redundant checks, verbose constructs, reimplemented standard library.
- **Requirements** (`requirements`): BRD requirement missing or only partly done (P1 if it is a must-have, else P2).

## Principles

- Flag only issues the change introduced, not pre-existing ones.
- Be specific: every finding names a file and, where possible, a line in the source branch version.
- Suggest changes to *how*, never silently to *what*: if the behaviour itself looks wrong, say so and why.
- Prefer explicit code over clever one-liners in suggestions.
- No praise or filler. An empty findings list is a valid result.
- Confidence: HIGH when you read all relevant code, MEDIUM when parts were skipped or context is missing, LOW when the diff could not be fully understood.
