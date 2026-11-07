// Regression guard for "config(.gitignore): .zerofactory/db.sqlite is
// untracked and not gitignored — a blanket git add . commits per-developer
// binary kanban state into the shared repo."
//
// .zerofactory/db.sqlite is the local Zero Factory kanban DB for this working
// copy (per-developer, per-machine binary state). It was untracked AND not
// gitignored, so a blanket `git add .` / `git add -A` would stage the binary
// into the shared repo: bloating history, causing meaningless binary merge
// conflicts, and leaking one developer's local board state into every clone.
//
// The fix appends precise .gitignore patterns for the DB + its SQLite sidecar
// files (-journal / -wal / -shm, which a hot DB can leave behind mid-write and
// which a `git add .` could otherwise pick up) — but NOT the whole
// .zerofactory/ directory, because .zerofactory/precommit.sh is intentionally
// tracked and shared (the repo's pre-commit hook, linked by install-hook).
//
// This test verifies:
//   1. .gitignore contains the exact .zerofactory/db.sqlite line plus the
//      precise .zerofactory/*.sqlite pattern and all three SQLite sidecar
//      patterns.
//   2. .gitignore contains NO pattern that blanket-ignores the whole
//      .zerofactory/ directory (`.zerofactory`, `.zerofactory/`, or
//      `/.zerofactory`) — that would re-ignore the tracked
//      .zerofactory/precommit.sh hook.
//   3. (semantic, real git verdict) `git check-ignore` reports
//      .zerofactory/db.sqlite and its -journal/-wal/-shm sidecars as IGNORED
//      while .zerofactory/precommit.sh is NOT ignored — the exact contract a
//      blanket `git add .` relies on. Skipped when the git binary is
//      unavailable.
//
// Static form (tests 1 + 2): pure readFileSync + pattern asserts, in the same
// style as the other tests/*.test.mjs static guards — they pin the intended
// precise-form contract, not just "whatever git happens to accept".
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const gitignoreRaw = readFileSync(join(root, '.gitignore'), 'utf8');

// Active (non-blank, non-comment) ignore patterns, whitespace-trimmed.
const patterns = gitignoreRaw
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

// ---- Test 1: the precise DB + sidecar patterns exist ----
{
  for (const required of [
    '.zerofactory/db.sqlite',
    '.zerofactory/*.sqlite',
    '.zerofactory/*.sqlite-journal',
    '.zerofactory/*.sqlite-wal',
    '.zerofactory/*.sqlite-shm'
  ]) {
    assert.ok(
      patterns.includes(required),
      `.gitignore must contain the exact pattern ${JSON.stringify(required)} ` +
        `(it covers the per-developer Zero Factory kanban DB / its SQLite sidecar files)`
    );
  }
  console.log(
    'ok - .gitignore carries the .zerofactory/db.sqlite + .zerofactory/*.sqlite DB + sidecar patterns'
  );
}

// ---- Test 2: no pattern blanket-ignores the whole .zerofactory/ directory ----
{
  // Any of these forms would also ignore .zerofactory/precommit.sh — the
  // tracked, shared pre-commit hook that install-hook links into
  // .git/hooks/pre-commit.
  const blanketRe = /^\/?\.zerofactory\/?$/; // .zerofactory | .zerofactory/ | /.zerofactory
  for (const p of patterns) {
    assert.ok(
      !blanketRe.test(p),
      `.gitignore must not blanket-ignore the whole .zerofactory/ directory ` +
        `(pattern ${JSON.stringify(p)} would re-ignore the tracked precommit.sh hook); ` +
        `keep the precise .zerofactory/*.sqlite* patterns instead`
    );
  }
  console.log('ok - no .gitignore pattern blanket-ignores the .zerofactory/ directory');
}

// ---- Test 3: real git verdict via check-ignore ----
{
  const ignoredPaths = [
    '.zerofactory/db.sqlite',
    '.zerofactory/boards.sqlite',
    '.zerofactory/db.sqlite-journal',
    '.zerofactory/db.sqlite-wal',
    '.zerofactory/db.sqlite-shm'
  ];
  const allPaths = [...ignoredPaths, '.zerofactory/precommit.sh'];
  let ignored;
  try {
    // check-ignore prints exactly the paths it considers ignored (echoing the
    // args verbatim) and exits 0 when at least one arg is ignored, 1 when
    // none are. Asking about all paths at once gives one authoritative
    // verdict for the whole contract.
    ignored = execFileSync('git', ['check-ignore', ...allPaths], {
      cwd: root,
      stdio: 'pipe'
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    const stderr = err?.stderr?.toString() || '';
    if (err?.code === 'ENOENT' || /not a git repository/i.test(stderr)) {
      console.log('skip - git binary/repository unavailable; check-ignore verdict skipped');
      ignored = null;
    } else {
      throw new Error(`git check-ignore failed unexpectedly (exit ${err?.status}): ${stderr}`);
    }
  }
  if (ignored !== null) {
    for (const path of ignoredPaths) {
      assert.ok(
        ignored.includes(path),
        `${JSON.stringify(path)} must be reported ignored by git ` +
          `(per-developer kanban state must never reach a blanket git add .); ` +
          `check-ignore ignored-set: ${JSON.stringify(ignored)}`
      );
    }
    assert.ok(
      !ignored.includes('.zerofactory/precommit.sh'),
      '.zerofactory/precommit.sh must NOT be ignored by git — it is the tracked, ' +
        'shared pre-commit hook (a blanket .zerofactory/ ignore would have un-tracked it)'
    );
    console.log('ok - git check-ignore: DB + sidecars ignored, precommit.sh still committable');
  }
}

console.log(
  'ok - .gitignore excludes the per-developer Zero Factory kanban DB without un-ignoring the shared hook'
);
