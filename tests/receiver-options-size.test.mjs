import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for the P0 "Max Size mislabeled 1024x" bug: the dropdown
// options in ReceiverOptions.svelte had values 1024x smaller than their
// labels (10 MB -> 10 * 1024 = 10 KB), so selecting "10 MB" enforced a 10 KB
// limit and rejected nearly every real file. Additionally, bind:value on a
// <select> yields a STRING after user interaction, which broke
// humanFileSize() (Number.isFinite("...") === false -> "0 B" in error toasts).
//
// This test statically verifies:
//   1. Every <option value={...}>label</option> in the Max Size select has a
//      numeric value that matches its label (10 MB -> 10 MiB, etc.).
//   2. The "Unlimit" option still exists and equals 1 TiB (no practical limit).
//   3. onChange() coerces maxSize to a number before emitting it.
const here = dirname(fileURLToPath(import.meta.url));

const source = readFileSync(
  join(here, '..', 'src', 'components', 'receiver', 'ReceiverOptions.svelte'),
  'utf8'
);

// ---- Helper: parse <option value={EXPR}>LABEL</option> pairs ----
function parseOptions(svelteSource) {
  const optionRe = /<option\s+value=\{([^}]+)\}>\s*([^<]+?)\s*<\/option>/g;
  const pairs = [];
  let m;
  while ((m = optionRe.exec(svelteSource)) !== null) {
    pairs.push({ rawExpr: m[1].trim(), label: m[2].trim() });
  }
  return pairs;
}

function evalArithmetic(expr) {
  // The option values are plain integer arithmetic (multiplications of small
  // numbers); evaluate safely with Function (no user input reaches here).
  const v = Function(`"use strict"; return (${expr});`)();
  assert.equal(
    typeof v,
    'number',
    `option value expression must evaluate to a number, got ${typeof v}`
  );
  assert.ok(Number.isFinite(v), `option value expression must be finite, got ${v}`);
  assert.ok(Number.isInteger(v), `option value must be an integer, got ${v}`);
  assert.ok(v > 0, `option value must be positive, got ${v}`);
  return v;
}

// Expected label -> byte count (MiB/GiB/TiB, i.e. powers of 1024)
const EXPECTED = {
  '10 MB': 10 * 1024 * 1024,
  '100 MB': 100 * 1024 * 1024,
  '1 GB': 1024 * 1024 * 1024,
  '10 GB': 10 * 1024 * 1024 * 1024,
  Unlimit: 1024 * 1024 * 1024 * 1024
};

// ---- Test 1: every Max Size option value matches its label ----
{
  const options = parseOptions(source);

  // The Max Size select has exactly these 5 options (in any order).
  const labels = options.map((o) => o.label);
  assert.equal(
    labels.length,
    5,
    `expected 5 options, found ${labels.length}: ${labels.join(', ')}`
  );
  for (const expectedLabel of Object.keys(EXPECTED)) {
    assert.ok(labels.includes(expectedLabel), `missing option label "${expectedLabel}"`);
  }

  for (const opt of options) {
    const expected = EXPECTED[opt.label];
    assert.notEqual(expected, undefined, `unknown option label "${opt.label}"`);
    const actual = evalArithmetic(opt.rawExpr);
    assert.equal(
      actual,
      expected,
      `option "${opt.label}" value ${opt.rawExpr} = ${actual}, expected ${expected}`
    );
  }
  console.log('ok - every Max Size option value matches its label');
}

// ---- Test 2: onChange coerces maxSize to a number (guards against string bind) ----
{
  const onChangeBlock = /function\s+onChange\s*\(\)\s*\{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(onChangeBlock, 'onChange() function must exist');
  const body = onChangeBlock[1];
  assert.ok(
    /Number\(\s*maxSize\s*\)/.test(body),
    'onChange() must call Number(maxSize) to coerce the select binding back to a number'
  );
  assert.ok(
    /Number\.isFinite/.test(body),
    'onChange() must guard with Number.isFinite before emitting'
  );
  console.log('ok - onChange() coerces maxSize to a number with finite guard');
}

// ---- Test 3: the "Unlimit" option is present and equals 1 TiB ----
{
  const unlimit = source.match(/<option\s+value=\{([^}]+)\}>\s*Unlimit\s*<\/option>/);
  assert.ok(unlimit, 'the "Unlimit" option must exist');
  const bytes = evalArithmetic(unlimit[1]);
  assert.equal(bytes, 1024 ** 4, `"Unlimit" must be 1 TiB (${1024 ** 4} bytes), got ${bytes}`);
  console.log('ok - Unlimit option is 1 TiB');
}

console.log('ok - receiver options: max size dropdown values match labels');
