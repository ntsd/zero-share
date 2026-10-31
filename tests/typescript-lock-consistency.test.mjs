// Regression guard for "lockfile pins typescript 5.6.3 while package.json
// declares ^5.9.3 — clean installs typecheck fail with TS2315 'Uint8Array is
// not generic' (generic TypedArray lib needs TS 5.7+)".
//
// The codebase intentionally types as `Uint8Array<ArrayBuffer>` (and friends)
// to pin the underlying ArrayBuffer identity. That lib support only exists in
// TypeScript 5.7+, so any lockfile resolution BELOW 5.7.0 silently downgrades
// the compiler on a clean `npm install`/`npm ci` and `tsc --noEmit` fails with
// a wall of TS2315s. This is the same failure class as the sharp phantom-dep
// fix: the lock must never drift below what the declared range + the code
// require.
//
// This test verifies (no install required — pure lockfile/manifest parsing):
//   1. package.json still declares a `typescript` devDependency with a
//      ^-range whose floor is at least 5.7.0 (the generic-TypedArray lib
//      floor; dropping below it means somebody "fixed" TS2315 by removing
//      the generic type args instead of keeping the intended typing).
//   2. EVERY `typescript` entry resolved in package-lock.json (root and any
//      nested copy) satisfies the declared range — a lock pinned at 5.6.x
//      while the manifest says ^5.9.x fails here before anyone's clean
//      install does.
//   3. The lockfile's resolved typescript is >= 5.7.0 — the real invariant
//      that keeps the TS2315 wall from coming back, even if the declared
//      range is ever loosened.
//   4. package.json exposes a documented `typecheck` script running
//      `tsc --noEmit`, so CI gates and contributors use the same entry
//      point instead of ad-hoc `npx tsc` invocations.
//   5. (When node_modules is present) the ACTUALLY INSTALLED typescript
//      matches the declared range — catches stale node_modules that a
//      manifest/lock edit did not reinstall over.
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Minimal ^-range satisfaction check (floor + same major) — no semver dep.
function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  assert.ok(m, `unparseable version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmpVer(a, b) {
  const [x1, y1, z1] = parseVer(a);
  const [x2, y2, z2] = parseVer(b);
  return x1 - x2 || y1 - y2 || z1 - z2;
}
// `^A.B.C`  =>  >=A.B.C and <(A+1).0.0
function satisfiesCaret(ver, range) {
  const m = /^\^(\d+\.\d+\.\d+)$/.exec(range);
  assert.ok(m, `only ^X.Y.Z ranges are handled: ${range}`);
  const floor = m[1];
  const [major] = parseVer(floor);
  return cmpVer(ver, floor) >= 0 && parseVer(ver)[0] === major;
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

test('declared typescript devDependency has a >=5.7.0 floor', () => {
  const declared = (pkg.devDependencies ?? {}).typescript;
  assert.ok(declared, 'package.json must declare a typescript devDependency');
  assert.match(declared, /^\^\d+\.\d+\.\d+$/, `typescript must use a ^-range, got ${declared}`);
  const floor = declared.slice(1);
  assert.ok(
    cmpVer(floor, '5.7.0') >= 0,
    `declared typescript floor ${declared} is below 5.7.0 — generic TypedArray ` +
      `lib (Uint8Array<ArrayBuffer>) needs TS 5.7+; restore the lock/declared range instead of removing the generic type args`
  );
});

test('every lockfile typescript entry satisfies the declared range and the 5.7.0 lib floor', () => {
  const declared = pkg.devDependencies.typescript;
  const entries = Object.entries(lock.packages).filter(
    ([key]) => key === 'node_modules/typescript' || key.endsWith('/node_modules/typescript')
  );
  assert.ok(entries.length >= 1, 'package-lock.json must contain a resolved typescript entry');
  for (const [key, entry] of entries) {
    assert.ok(entry.version, `lockfile entry ${key} has no resolved version`);
    assert.ok(
      satisfiesCaret(entry.version, declared),
      `lockfile ${key} resolved typescript@${entry.version} does not satisfy declared ${declared} ` +
        `(lockfile/manifest skew — clean installs would install ${entry.version})`
    );
    assert.ok(
      cmpVer(entry.version, '5.7.0') >= 0,
      `lockfile ${key} resolved typescript@${entry.version} is below the 5.7.0 ` +
        `generic-TypedArray lib floor — tsc --noEmit would fail with TS2315`
    );
  }
});

test('package.json defines a documented typecheck script running tsc --noEmit', () => {
  const tc = pkg.scripts?.typecheck;
  assert.ok(tc, 'package.json must define a "typecheck" script (stable CI entry point)');
  assert.match(tc, /(^|\s)tsc(\s|$)/, `"typecheck" script must invoke tsc, got: ${tc}`);
  assert.match(tc, /--noEmit/, `"typecheck" script must run tsc --noEmit, got: ${tc}`);
});

test(
  'installed node_modules/typescript satisfies the declared range',
  {
    skip: !existsSync(join(root, 'node_modules', 'typescript', 'package.json'))
      ? 'node_modules/typescript not installed'
      : false
  },
  () => {
    const installed = JSON.parse(
      readFileSync(join(root, 'node_modules', 'typescript', 'package.json'), 'utf8')
    );
    const declared = pkg.devDependencies.typescript;
    assert.ok(
      satisfiesCaret(installed.version, declared),
      `installed typescript@${installed.version} does not satisfy declared ${declared} — run npm install`
    );
  }
);
