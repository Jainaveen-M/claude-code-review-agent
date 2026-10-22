# Review JSON (interactive mode)

Write this file, then run `code-review-agent pdf <file>`. The command computes the git facts (commits, file stats, SHAs) itself, so don't include them. `code-review-agent schema` prints the exact JSON Schema.

## Fields

`inputs`
- `repoPath`: absolute path of the repository root
- `source`, `dest`: branch names as the user gave them
- `changeType`: `bugfix` | `feature` | `refactor` | `other`
- `description`: the user's own words for what they fixed or changed
- `brdSource` (optional): BRD file name, or `"pasted text"`

`review`
- `verdict`: `APPROVE` | `REQUEST_CHANGES` | `NEEDS_DISCUSSION`
- `confidence`: `HIGH` | `MEDIUM` | `LOW`
- `summary`: 2–4 sentences
- `intentCheck`: `matchesDescription` (`yes` | `partial` | `no` | `unclear`), `rootCauseAddressed` (`yes` | `no` | `unclear` | `not_applicable`), `testsAdded` (boolean), `notes`
- `brd` (only with a BRD): `title`, `requirements[]` (`id`, `text`, `status`: `implemented` | `partial` | `missing` | `not_verifiable`, `evidence[]` of `file:line`, optional `notes`), `outOfScopeChanges[]`
- `findings[]`: `priority` (`P0`–`P3`), `title`, `file`, optional `line`, `category` (`correctness` | `security` | `performance` | `data-integrity` | `testing` | `clarity` | `consistency` | `maintainability` | `simplification` | `requirements`), `description`, optional `suggestion`
- `recommendation`: concrete next steps

## Example

```json
{
  "inputs": {
    "repoPath": "/Users/me/projects/shop-api",
    "source": "fix/expired-coupons",
    "dest": "main",
    "changeType": "bugfix",
    "description": "Expired coupons were still accepted at checkout. Fixed the expiry check and added a test."
  },
  "review": {
    "verdict": "REQUEST_CHANGES",
    "confidence": "HIGH",
    "summary": "Fixes the inverted expiry comparison so expired coupons are rejected. The fix is correct, but the new test uses the real clock and will fail intermittently around midnight UTC.",
    "intentCheck": {
      "matchesDescription": "yes",
      "rootCauseAddressed": "yes",
      "testsAdded": true,
      "notes": "src/coupons/validate.js:18 now rejects when expiresAt <= now, which was the root cause. test/coupons/validate.test.js:12 covers it."
    },
    "findings": [
      {
        "priority": "P1",
        "title": "Test depends on the real clock",
        "file": "test/coupons/validate.test.js",
        "line": 12,
        "category": "testing",
        "description": "The test builds an 'expired' coupon from new Date() minus one day, but validate() truncates to UTC dates, so the test passes or fails depending on the time of day.",
        "suggestion": "const now = new Date('2026-01-15T12:00:00Z');\nconst coupon = { expiresAt: new Date('2026-01-14T00:00:00Z') };\nexpect(() => validate(coupon, { now })).toThrow('expired');"
      },
      {
        "priority": "P3",
        "title": "Error message could name the expiry date",
        "file": "src/coupons/validate.js",
        "line": 19,
        "category": "clarity",
        "description": "'This coupon has expired' doesn't tell support staff when; include the date."
      }
    ],
    "recommendation": "Inject the clock into validate() and pin it in the test before merging."
  }
}
```
