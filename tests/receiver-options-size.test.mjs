import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for two related Max Size defects:
//
// 1. "Max Size mislabeled 1024x" (original guard): the dropdown options in
//    ReceiverOptions.svelte had values 1024x smaller than their labels
//    (10 MB -> 10 * 1024 = 10 KB), so selecting "10 MB" enforced a 10 KB
//    limit and rejected nearly every real file. Additionally, bind:value on
//    a <select> yields a STRING after user interaction, which broke
//    humanFileSize() (Number.isFinite("...") === false -> "0 B" in error toasts).
//
// 2. "Unlimit" (1 TiB) / 10 GB exceeded the classic-ZIP ceiling: the bulk
//    "Download all files (zip)" path builds a classic ZIP with no zip64 extra
//    fields (createZipStoreOnly, src/utils/zip.ts) and throws when any entry
//    is >= 0xffffffff bytes (~4 GiB) or the archive's central directory
//    starts past 4 GiB. Offering 10 GB / "Unlimit" (1 TiB) advertised transfer
//    sizes the bulk download can structurally never honor — the button only
//    failed at click time with a generic error toast.
//
// This test statically verifies:
//   1. Every <option value={...}>label</option> in the Max Size select has a
//      numeric value that matches its label (10 MB -> 10 MiB, etc.).
//   2. Every offered Max Size value is strictly below the classic-ZIP
//      per-entry sentinel 0xffffffff, so no offered size makes the bulk zip
//      download impossible; no option may claim an unbounded value ("Unlimit").
//   3. DEFAULT_RECEIVE_OPTIONS.maxSize is one of the offered options and also
//      stays below the sentinel.
//   4. onChange() coerces maxSize to a number before emitting it.
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

// Expected label -> byte count (MiB/GiB, i.e. powers of 1024)
const EXPECTED = {
  '10 MB': 10 * 1024 * 1024,
  '100 MB': 100 * 1024 * 1024,
  '1 GB': 1024 * 1024 * 1024,
  '2 GB': 2 * 1024 * 1024 * 1024
};

// createZipStoreOnly's per-entry guard threshold (src/utils/zip.ts): any
// entry with data.length >= 0xffffffff is rejected because classic ZIP 32-bit
// fields would wrap at the "size is in zip64 extra" sentinel.
const ZIP_CLASSIC_ENTRY_SENTINEL = 0xffffffff;

// ---- Test 1: every Max Size option value matches its label ----
{
  const options = parseOptions(source);

  // The Max Size select has exactly these 4 options (in any order).
  const labels = options.map((o) => o.label);
  assert.equal(
    labels.length,
    4,
    `expected 4 options, found ${labels.length}: ${labels.join(', ')}`
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

// ---- Test 2: no offered value reaches the classic-ZIP per-entry sentinel ----
{
  const options = parseOptions(source);
  for (const opt of options) {
    const v = evalArithmetic(opt.rawExpr);
    assert.ok(
      v < ZIP_CLASSIC_ENTRY_SENTINEL,
      `option "${opt.label}" (${v} bytes) must stay strictly below the classic-ZIP ` +
        `per-entry sentinel 0xffffffff (${ZIP_CLASSIC_ENTRY_SENTINEL}) — at or above it, ` +
        `createZipStoreOnly throws and the bulk "Download all files (zip)" can never honor it`
    );
  }
  // "Unlimit" implied an unbounded value the archive path can never deliver.
  // Scope to option LABELS (not the whole source) so an explanatory comment
  // mentioning the removed option doesn't trip the guard.
  const labels = parseOptions(source).map((o) => o.label);
  assert.ok(
    labels.every((l) => !/^unlimit$/i.test(l)),
    'no Max Size option may be labeled "Unlimit" — it advertised an unbounded value the classic-ZIP writer cannot honor'
  );
  console.log('ok - every Max Size option stays below the 4 GiB classic-ZIP per-entry sentinel');
}

// ---- Test 3: the default maxSize is an offered option under the sentinel ----
{
  const configsSource = readFileSync(join(here, '..', 'src', 'configs.ts'), 'utf8');
  const defaultExpr = /maxSize:\s*([\d\s*]+)/.exec(configsSource);
  assert.ok(defaultExpr, 'DEFAULT_RECEIVE_OPTIONS.maxSize must be a plain numeric expression');
  const defaultValue = evalArithmetic(defaultExpr[1]);
  assert.ok(
    defaultValue < ZIP_CLASSIC_ENTRY_SENTINEL,
    `DEFAULT_RECEIVE_OPTIONS.maxSize (${defaultValue}) must stay below the classic-ZIP sentinel`
  );
  const offeredValues = parseOptions(source).map((o) => evalArithmetic(o.rawExpr));
  assert.ok(
    offeredValues.includes(defaultValue),
    `DEFAULT_RECEIVE_OPTIONS.maxSize (${defaultValue}) must be one of the offered options ` +
      `so the default select has a matching <option>: [${offeredValues.join(', ')}]`
  );
  console.log('ok - default maxSize is an offered option below the classic-ZIP sentinel');
}

// ---- Test 4: onChange coerces maxSize to a number (guards against string bind) ----
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

console.log(
  'ok - receiver options: max size values match labels, stay under the 4 GiB zip ceiling, default is offered'
);
