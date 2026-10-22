import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = path.join(PACKAGE_ROOT, 'plugin');
export const SKILL_DIR = path.join(PLUGIN_DIR, 'skills', 'branch-review');
export const WEB_DIR = path.join(PACKAGE_ROOT, 'web');
export const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

// 'default' leaves the choice to Claude Code (whatever your plan defaults to).
export const MODELS = ['default', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULT_CONFIG = { model: 'default', effort: 'high', maxBudgetUsd: null };

/** Root folder for reports, the history index and settings. */
export function homeDir() {
  return process.env.CODE_REVIEW_AGENT_HOME || path.join(os.homedir(), 'code-reviews');
}

export function configPath() {
  return path.join(homeDir(), 'config.json');
}

export function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig() };
  if (patch.model !== undefined) {
    if (!MODELS.includes(patch.model)) throw new Error(`Unknown model "${patch.model}"`);
    next.model = patch.model;
  }
  if (patch.effort !== undefined) {
    if (!EFFORTS.includes(patch.effort)) throw new Error(`Unknown effort "${patch.effort}"`);
    next.effort = patch.effort;
  }
  if (patch.maxBudgetUsd !== undefined) {
    const value = patch.maxBudgetUsd === null || patch.maxBudgetUsd === '' ? null : Number(patch.maxBudgetUsd);
    if (value !== null && !(value > 0)) throw new Error('maxBudgetUsd must be a positive number or empty');
    next.maxBudgetUsd = value;
  }
  writeFileAtomic(configPath(), JSON.stringify(next, null, 2));
  return next;
}

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
