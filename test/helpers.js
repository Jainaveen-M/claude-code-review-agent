import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cra-${prefix}-`)));
}

/** Point reports/history at a fresh temp folder for this test file. */
export function useTempHome() {
  const home = tempDir('home');
  process.env.CODE_REVIEW_AGENT_HOME = home;
  return home;
}

export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/**
 * A repo with `main` and `feature/coupons` (one commit adding a coupon module),
 * plus `noop` whose commits cancel out (different SHA, empty diff).
 */
export function makeRepo() {
  const dir = tempDir('repo');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, stdio: 'pipe' });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };

  git('init', '-q', '-b', 'main');
  write('src/checkout.js', 'export function total(items) {\n  return items.reduce((sum, i) => sum + i.price, 0);\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Initial checkout');

  git('checkout', '-q', '-b', 'feature/coupons');
  write('src/coupons.js', "export function findCoupon(db, code) {\n  return db.query(\"SELECT * FROM coupons WHERE code = '\" + code + \"'\");\n}\n");
  write('src/checkout.js', 'export function total(items, discount = 0) {\n  return items.reduce((sum, i) => sum + i.price, 0) - discount;\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Add coupons');

  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'noop');
  write('README.md', 'temp\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Add readme');
  git('rm', '-q', 'README.md');
  git('commit', '-q', '-m', 'Remove readme');
  git('checkout', '-q', 'main');
  return dir;
}

/** Use test/fixtures/fake-claude.js as the `claude` CLI. Returns a reader for its last invocation. */
export function useFakeClaude({ mode = 'ok', loggedIn = true } = {}) {
  const bin = path.join(FIXTURES, 'fake-claude.js');
  fs.chmodSync(bin, 0o755);
  const log = path.join(tempDir('fake-claude'), 'last-run.json');
  process.env.CODE_REVIEW_AGENT_CLAUDE = bin;
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_MODE = mode;
  process.env.FAKE_CLAUDE_LOGGED_IN = loggedIn ? '1' : '0';
  return {
    setMode: (next) => { process.env.FAKE_CLAUDE_MODE = next; },
    setLoggedIn: (next) => { process.env.FAKE_CLAUDE_LOGGED_IN = next ? '1' : '0'; },
    lastRun: () => JSON.parse(fs.readFileSync(log, 'utf8')),
  };
}
