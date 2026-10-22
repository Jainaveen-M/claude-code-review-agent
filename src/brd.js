import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';

export const MAX_BRD_BYTES = 20 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', ...TEXT_EXTENSIONS]);

export class BrdError extends Error {}

async function docxToText(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  if (!value.trim()) throw new BrdError('The Word document contains no readable text');
  return value;
}

/**
 * Store a BRD for the agent to read and return the path it should open.
 * PDFs stay PDFs (Claude reads them natively); .docx is converted to text.
 * `brd` is { name, base64 } for an upload or { text } for pasted text.
 */
export async function saveBrd(runDir, brd) {
  fs.mkdirSync(runDir, { recursive: true });

  if (typeof brd.text === 'string') {
    if (!brd.text.trim()) throw new BrdError('Pasted BRD text is empty');
    const file = path.join(runDir, 'brd.md');
    fs.writeFileSync(file, brd.text);
    return { path: file, source: 'pasted text' };
  }

  const name = path.basename(String(brd.name ?? ''));
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new BrdError(`Unsupported BRD type "${ext || name}". Use PDF, Word (.docx), Markdown or text.`);
  const buffer = Buffer.from(String(brd.base64 ?? ''), 'base64');
  if (buffer.length === 0) throw new BrdError('The uploaded BRD is empty');
  if (buffer.length > MAX_BRD_BYTES) throw new BrdError('The BRD is larger than 20 MB');

  const original = path.join(runDir, `brd-original${ext}`);
  fs.writeFileSync(original, buffer);
  if (ext === '.docx') {
    const file = path.join(runDir, 'brd.md');
    fs.writeFileSync(file, await docxToText(buffer));
    return { path: file, source: name };
  }
  return { path: original, source: name };
}

/** Text of a BRD file for the CLI `extract` command. PDFs are left to Claude's Read tool. */
export async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return docxToText(fs.readFileSync(file));
  if (TEXT_EXTENSIONS.has(ext)) return fs.readFileSync(file, 'utf8');
  if (ext === '.pdf') throw new BrdError('PDFs need no conversion: open the file with the Read tool directly.');
  throw new BrdError(`Unsupported BRD type "${ext}". Use PDF, Word (.docx), Markdown or text.`);
}
