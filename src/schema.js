import { z } from 'zod';

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const VERDICTS = ['APPROVE', 'REQUEST_CHANGES', 'NEEDS_DISCUSSION'];
export const CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];
export const CHANGE_TYPES = ['bugfix', 'feature', 'refactor', 'other'];
export const REQUIREMENT_STATUSES = ['implemented', 'partial', 'missing', 'not_verifiable'];
export const CATEGORIES = [
  'correctness', 'security', 'performance', 'data-integrity', 'testing',
  'clarity', 'consistency', 'maintainability', 'simplification', 'requirements',
];

const Finding = z.object({
  priority: z.enum(PRIORITIES),
  title: z.string().min(1).describe('One-line statement of the problem'),
  file: z.string().min(1).describe('Repo-relative path'),
  line: z.number().int().positive().optional().describe('Line in the source branch version of the file'),
  category: z.enum(CATEGORIES),
  description: z.string().min(1).describe('What is wrong and why it matters'),
  suggestion: z.string().optional().describe('Suggested fix, usually a code snippet'),
});

const IntentCheck = z.object({
  matchesDescription: z.enum(['yes', 'partial', 'no', 'unclear'])
    .describe('Does the diff actually do what the author said they changed?'),
  rootCauseAddressed: z.enum(['yes', 'no', 'unclear', 'not_applicable'])
    .describe('Bug fixes: is the root cause fixed, or only the symptom?'),
  testsAdded: z.boolean().describe('Does the change add or update tests covering it?'),
  notes: z.string().describe('Evidence for the assessment, citing file:line'),
});

const Requirement = z.object({
  id: z.string().min(1).describe('REQ-1, REQ-2, ... or the BRD\'s own numbering'),
  text: z.string().min(1).describe('The requirement, condensed to one or two sentences'),
  status: z.enum(REQUIREMENT_STATUSES),
  evidence: z.array(z.string()).describe('file:line references that implement it'),
  notes: z.string().optional(),
});

const BrdCheck = z.object({
  title: z.string().describe('BRD title or file name'),
  requirements: z.array(Requirement),
  outOfScopeChanges: z.array(z.string()).describe('Changes in the diff that trace back to no requirement'),
});

/** What the agent returns: its judgment only. Git facts are computed by code. */
export const AgentReview = z.object({
  verdict: z.enum(VERDICTS).describe('APPROVE only when there are no P0/P1 findings'),
  confidence: z.enum(CONFIDENCE),
  summary: z.string().min(1).describe('2-4 sentences: what the change does and the overall assessment'),
  intentCheck: IntentCheck,
  brd: BrdCheck.optional().describe('Only when a BRD was provided'),
  findings: z.array(Finding),
  recommendation: z.string().min(1).describe('Concise, actionable next steps for the author'),
});

/** Inputs a review was run with. In chat mode the skill writes these itself. */
export const ReviewInputs = z.object({
  repoPath: z.string().min(1),
  source: z.string().min(1),
  dest: z.string().min(1),
  changeType: z.enum(CHANGE_TYPES),
  description: z.string().min(1),
  brdSource: z.string().optional().describe('Original BRD file name, or "pasted text"'),
});

/** What the chat-mode skill writes and hands to `code-review-agent pdf`. */
export const ReviewDraft = z.object({
  inputs: ReviewInputs,
  review: AgentReview,
});

const Commit = z.object({ sha: z.string(), subject: z.string() });
const FileChange = z.object({
  path: z.string(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean().optional(),
});

const Meta = ReviewInputs.extend({
  repo: z.string(),
  sourceSha: z.string(),
  destSha: z.string(),
  mergeBase: z.string(),
  commits: z.array(Commit),
  commitCount: z.number().int().nonnegative(),
  stats: z.object({
    files: z.number().int().nonnegative(),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
  createdAt: z.string(),
  origin: z.enum(['ui', 'chat']),
  model: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  historyId: z.string().optional(),
});

/** A complete report: what gets saved as JSON and rendered to PDF. */
export const Report = AgentReview.extend({
  meta: Meta,
  filesChanged: z.array(FileChange),
});

export const agentReviewJsonSchema = () => z.toJSONSchema(AgentReview, { target: 'draft-7' });
export const reviewDraftJsonSchema = () => z.toJSONSchema(ReviewDraft, { target: 'draft-7' });

/** Turn a ZodError into lines like `review.findings[0].priority: Invalid option ...`. */
export function formatZodError(error, prefix = '') {
  return error.issues
    .map((issue) => {
      const where = issue.path.reduce(
        (acc, key) => (typeof key === 'number' ? `${acc}[${key}]` : acc ? `${acc}.${key}` : String(key)),
        prefix,
      );
      return `  - ${where || '(root)'}: ${issue.message}`;
    })
    .join('\n');
}

export function countByPriority(findings) {
  const counts = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
  for (const f of findings) counts[f.priority] += 1;
  return counts;
}

/**
 * The verdict rule from the checklist, enforced in code: a review with P0/P1
 * findings can never be APPROVE.
 */
export function enforceVerdict(review) {
  const counts = countByPriority(review.findings);
  if (review.verdict === 'APPROVE' && counts.P0 + counts.P1 > 0) {
    return { ...review, verdict: 'REQUEST_CHANGES' };
  }
  return review;
}
