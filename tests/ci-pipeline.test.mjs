// Regression guard for P1 "CI pipeline is entirely absent — the project's
// primary quality gate (the 45-file / 49-test regression-guard suite plus the
// tsc --noEmit typecheck gate and astro build) is enforced ONLY by a
// locally-installed, per-developer, bypassable git pre-commit hook
// (.zerofactory/precommit.sh, linked into .git/hooks/pre-commit by
// install-hook, and skippable with `git commit --no-verify`)."
//
// The fix adds a minimal .github/workflows/ci.yml that runs on every push to
// main and every pull request and enforces exactly the gates the pre-commit
// hook already enforces:
//   1. npm ci            install dependencies from the lockfile
//   2. npx tsc --noEmit  typecheck gate
//   3. npm run build     astro build gate
//   4. npm test          45-file / 49-test regression-guard suite
//
// This test verifies the pipeline exists, is well-formed YAML, is wired to the
// right triggers, and pins each gate to the project's ACTUAL commands (read
// from package.json) so a future edit that silently drops or re-orders a gate
// — or points CI at a stub instead of the real astro build / node test runner —
// fails the suite.
//
// NOTE: `astro check` is intentionally NOT asserted here. @astrojs/check is not
// a devDependency and its install prompt hangs non-interactive shells; the
// gate set must match what the pre-commit hook enforces, nothing more.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url)); // tests/ directory
const root = join(here, '..');
const require = createRequire(import.meta.url);

// js-yaml is a direct dependency of astro (pinned in the lockfile) — resolve it
// through createRequire rather than hard-coding a nested path so the test keeps
// working across npm layouts.
const loadYaml = () => require('js-yaml').load;

// ---- Load + parse the workflow ----
const workflowPath = join(root, '.github', 'workflows', 'ci.yml');
assert.ok(
  existsSync(workflowPath),
  `.github/workflows/ci.yml must exist (the CI quality gate was entirely absent)`
);

const raw = readFileSync(workflowPath, 'utf8');
let workflow;
try {
  workflow = loadYaml()(raw);
} catch (err) {
  assert.fail(`.github/workflows/ci.yml must be valid YAML: ${err.message}`);
}

assert.ok(
  workflow && typeof workflow === 'object' && !Array.isArray(workflow),
  'ci.yml must parse to a mapping (workflow document)'
);

// YAML 1.1 / js-yaml parse the bare `on:` key as the boolean true. Normalize to
// a string key so trigger checks work regardless of parser quirks.
const on = workflow.on ?? workflow[true];
assert.ok(
  on && typeof on === 'object' && !Array.isArray(on),
  'ci.yml must declare an `on:` trigger block'
);

// ---- Triggers: every push to main AND every pull request ----
// A push trigger scoped to `main` only would miss the default-branch PR path;
// pull_request must be present so forks / cross-branch PRs are gated too.
assert.ok(
  on.push && Array.isArray(on.push.branches) && on.push.branches.includes('main'),
  'ci.yml must run on every push to `main`'
);
assert.ok('pull_request' in on, 'ci.yml must run on every pull request');

// ---- Find the job that carries the quality-gate steps ----
const jobs = workflow.jobs;
assert.ok(
  jobs && typeof jobs === 'object' && !Array.isArray(jobs),
  'ci.yml must declare at least one job under `jobs:`'
);

// Collect the first job whose steps contain the install step (`npm ci`); that
// is the quality-gate job. Failing here means no job actually performs the
// install, i.e. the gates are not wired to a real runner.
const gateJob = Object.entries(jobs).find(([, job]) => {
  const runs = (job?.steps ?? []).map((s) => s?.run ?? '').join('\n');
  return /(^|\n)\s*npm ci\b/.test(runs);
});
assert.ok(gateJob, 'a job must run `npm ci` before the gates (dependency install)');
const [gateJobName, gateJobDef] = gateJob;
assert.ok(
  Array.isArray(gateJobDef.steps) && gateJobDef.steps.length > 0,
  `job ${JSON.stringify(gateJobName)} must define steps`
);
const steps = gateJobDef.steps;

// The four gates, in the order the pre-commit hook enforces them.
const GATES = [
  { label: 'install (npm ci)', cmd: 'npm ci', re: /(^|\n)\s*npm ci\b/ },
  { label: 'typecheck (tsc --noEmit)', cmd: 'npx tsc --noEmit', re: /(^|\n)\s*npx tsc --noEmit\b/ },
  {
    label: 'build (astro build via npm run build)',
    cmd: 'npm run build',
    re: /(^|\n)\s*npm run build\b/
  },
  { label: 'regression-guard tests (npm test)', cmd: 'npm test', re: /(^|\n)\s*npm test\b/ }
];

const stepRuns = steps.map((s) => s?.run ?? '');
const gateIndex = GATES.map((g) => stepRuns.findIndex((run) => g.re.test(run)));

for (let i = 0; i < GATES.length; i += 1) {
  assert.ok(
    gateIndex[i] !== -1,
    `CI must enforce the ${GATES[i].label} gate (a step running \`${GATES[i].cmd}\`)`
  );
}

// Ordering: install < typecheck < build < test, mirroring .zerofactory/precommit.sh.
// Typecheck before build mirrors the pre-commit build phase (tsc first, then
// astro build); test runs last so a broken suite is only reported once the
// app already built.
for (let i = 1; i < gateIndex.length; i += 1) {
  assert.ok(
    gateIndex[i] > gateIndex[i - 1],
    `the ${GATES[i].label} gate must run after ${GATES[i - 1].label} ` +
      `(order: install -> typecheck -> build -> test)`
  );
}

// ---- Node version satisfies the project floor ----
// The regression tests rely on Node's built-in TypeScript type-stripping,
// enabled by default since 22.18.0. The workflow pins a Node major that must be
// >= the major in package.json `engines.node`, otherwise the gates could run
// on a Node that lacks the behavior the tests depend on.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const enginesFloor = pkg?.engines?.node;
assert.ok(typeof enginesFloor === 'string', 'package.json must declare an `engines.node` floor');
const floorMatch = /(\d+)\.(\d+)/.exec(enginesFloor);
assert.ok(floorMatch, `engines.node ${JSON.stringify(enginesFloor)} must parse a major.minor`);
const floorMajor = Number(floorMatch[1]);

const setupNodeStep = steps.find((s) => s?.uses && /actions\/setup-node/.test(String(s.uses)));
assert.ok(setupNodeStep, 'the gate job must use actions/setup-node to pin a Node version');
const nodeVersion = String(setupNodeStep.with?.['node-version'] ?? '').trim();
const nodeMajorMatch = /(\d+)/.exec(nodeVersion);
assert.ok(
  nodeMajorMatch,
  `setup-node must pin a numeric node-version (got ${JSON.stringify(nodeVersion)})`
);
const nodeMajor = Number(nodeMajorMatch[1]);
assert.ok(
  nodeMajor >= floorMajor,
  `setup-node major ${nodeMajor} must satisfy engines.node floor ${enginesFloor}`
);

// ---- Cross-reference the gate commands to the project's ACTUAL commands ----
// `npm run build` and `npm test` only count as the real gates if the underlying
// package.json scripts invoke the intended tools. This catches a future edit
// that swaps the scripts for a no-op / stub while leaving the CI `run` lines
// untouched (which would make CI green without doing the work).
const scripts = pkg?.scripts ?? {};

// Build gate: `npm run build` must actually run the Astro build.
assert.ok(
  typeof scripts.build === 'string' && /astro\s+build\b/.test(scripts.build),
  `package.json scripts.build must invoke the Astro build (got ${JSON.stringify(scripts.build)})`
);

// Test gate: `npm test` must actually run Node's built-in test runner against
// the tests/ directory (the regression-guard suite).
assert.ok(
  typeof scripts.test === 'string' &&
    /node\s+.*--test\b/.test(scripts.test) &&
    /tests\/\*\.test\.mjs/.test(scripts.test),
  `package.json scripts.test must run node's --test against tests/*.test.mjs ` +
    `(got ${JSON.stringify(scripts.test)})`
);

// Typecheck gate: the pre-commit hook and CI both gate on `tsc --noEmit`.
// Ensure a tsconfig exists so the typecheck step is not a no-op that types
// nothing.
assert.ok(
  existsSync(join(root, 'tsconfig.json')),
  'tsconfig.json must exist so `tsc --noEmit` typechecks the project (not zero files)'
);

// ---- Sanity: the regression suite is the one the gates protect ----
// Count the .test.mjs files (re-derived at HEAD per the repo's OpenWiki
// doc-sync convention — do not hard-code a stale count).
const testFiles = readdirSync(here).filter((f) => f.endsWith('.test.mjs'));
assert.ok(
  testFiles.length >= 40,
  `the regression-guard suite must still cover the P0/P1 fixes ` +
    `(found ${testFiles.length} tests/*.test.mjs files)`
);

console.log(
  `ok - CI pipeline enforces ${GATES.length} gates on push(main)+PR: ` +
    `install -> typecheck -> build -> test; Node major ${nodeMajor} >= floor ${enginesFloor}; ` +
    `protects ${testFiles.length} regression-guard test files`
);
