import crypto from 'node:crypto';
import { writeFileAtomic } from './config.js';
import { collectGitFacts } from './git.js';
import { addEntry, entryFromReport, reportBasePath } from './history.js';
import { renderReportPdf } from './render-pdf.js';
import { AgentReview, Report, ReviewDraft, enforceVerdict, formatZodError } from './schema.js';

export class ReportError extends Error {}

/** Combine git facts (computed by code) with the agent's review into a full report. */
export function buildReport({ facts, inputs, review, origin, run = {} }) {
  const parsed = AgentReview.safeParse(review);
  if (!parsed.success) throw new ReportError(`The review is missing or has invalid fields:\n${formatZodError(parsed.error, 'review')}`);
  const { filesChanged, ...factMeta } = facts;
  const report = {
    ...enforceVerdict(parsed.data),
    meta: {
      ...factMeta,
      changeType: inputs.changeType,
      description: inputs.description,
      ...(inputs.brdSource ? { brdSource: inputs.brdSource } : {}),
      createdAt: new Date().toISOString(),
      origin,
      ...(run.model ? { model: run.model } : {}),
      ...(run.costUsd != null ? { costUsd: run.costUsd } : {}),
      ...(run.durationMs != null ? { durationMs: run.durationMs } : {}),
    },
    filesChanged,
  };
  return Report.parse(report);
}

/** Write the report JSON and PDF into the history folder and add an index entry. */
export async function saveReport(report, { history = true, pdfPath } = {}) {
  const id = crypto.randomUUID();
  const base = reportBasePath(report.meta);
  const jsonPath = `${base}.json`;
  const outPdf = pdfPath ?? `${base}.pdf`;
  const stored = { ...report, meta: { ...report.meta, historyId: id } };
  await renderReportPdf(stored, outPdf);
  if (!history) return { entry: null, pdfPath: outPdf, jsonPath: null };
  writeFileAtomic(jsonPath, JSON.stringify(stored, null, 2));
  const entry = addEntry(entryFromReport(stored, { id, pdfPath: outPdf, jsonPath }));
  return { entry, pdfPath: outPdf, jsonPath };
}

/**
 * Parse what the CLI `pdf` command was given: a chat-mode draft
 * ({ inputs, review }) or an already complete report (re-render).
 */
export async function reportFromFile(data) {
  if (data && typeof data === 'object' && data.meta) {
    const parsed = Report.safeParse(data);
    if (!parsed.success) throw new ReportError(`Invalid report:\n${formatZodError(parsed.error)}`);
    return { report: parsed.data, isDraft: false };
  }
  const parsed = ReviewDraft.safeParse(data);
  if (!parsed.success) throw new ReportError(`Invalid review JSON:\n${formatZodError(parsed.error)}`);
  const { inputs, review } = parsed.data;
  const facts = await collectGitFacts(inputs.repoPath, inputs.source, inputs.dest);
  return { report: buildReport({ facts, inputs, review, origin: 'chat' }), isDraft: true };
}
