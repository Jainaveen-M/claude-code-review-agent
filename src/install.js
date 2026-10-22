import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILL_DIR } from './config.js';

const SKILL_NAME = 'branch-review';

export class InstallError extends Error {}

function targetDir({ project }) {
  const base = project ? path.join(process.cwd(), '.claude', 'skills') : path.join(os.homedir(), '.claude', 'skills');
  return path.join(base, SKILL_NAME);
}

/** True when `dir` holds a copy (or link) of this package's skill. */
function isOurSkill(dir) {
  try {
    return /^name:\s*branch-review\s*$/m.test(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  } catch {
    return false;
  }
}

/** Copy (or symlink, for development) the skill into Claude Code's skills folder. */
export function installSkill({ project = false, link = false, force = false } = {}) {
  const target = targetDir({ project });
  const exists = fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false });
  if (exists) {
    if (!force && !isOurSkill(target)) {
      throw new InstallError(`${target} already exists and is not this package's skill. Re-run with --force to replace it.`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (link) fs.symlinkSync(SKILL_DIR, target, 'dir');
  else fs.cpSync(SKILL_DIR, target, { recursive: true });
  return target;
}

export function uninstallSkill({ project = false } = {}) {
  const target = targetDir({ project });
  if (!fs.lstatSync(target, { throwIfNoEntry: false })) return null;
  if (!isOurSkill(target)) throw new InstallError(`${target} is not this package's skill; leaving it alone.`);
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}
