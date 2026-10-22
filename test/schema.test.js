import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SKILL_DIR } from '../src/config.js';
import { AgentReview, ReviewDraft, agentReviewJsonSchema, enforceVerdict, formatZodError, reviewDraftJsonSchema } from '../src/schema.js';

test('the example in the skill\'s report-schema.md is valid', () => {
  const doc = fs.readFileSync(path.join(SKILL_DIR, 'references', 'report-schema.md'), 'utf8');
  const example = doc.match(/```json\n([\s\S]*?)```/)[1];
  const parsed = ReviewDraft.safeParse(JSON.parse(example));
  assert.ok(parsed.success, parsed.success ? '' : formatZodError(parsed.error));
});

test('JSON Schemas target draft-07, as the Agent SDK requires', () => {
  for (const schema of [agentReviewJsonSchema(), reviewDraftJsonSchema()]) {
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  }
  assert.deepEqual(agentReviewJsonSchema().required, ['verdict', 'confidence', 'summary', 'intentCheck', 'findings', 'recommendation']);
});

test('formatZodError names the failing field', () => {
  const result = AgentReview.safeParse({ verdict: 'LGTM' });
  assert.match(formatZodError(result.error, 'review'), /review\.verdict:/);
});

test('APPROVE with P0/P1 findings becomes REQUEST_CHANGES', () => {
  const finding = (priority) => ({ priority, title: 't', file: 'f', category: 'correctness', description: 'd' });
  assert.equal(enforceVerdict({ verdict: 'APPROVE', findings: [finding('P1')] }).verdict, 'REQUEST_CHANGES');
  assert.equal(enforceVerdict({ verdict: 'APPROVE', findings: [finding('P2')] }).verdict, 'APPROVE');
  assert.equal(enforceVerdict({ verdict: 'NEEDS_DISCUSSION', findings: [finding('P0')] }).verdict, 'NEEDS_DISCUSSION');
});
