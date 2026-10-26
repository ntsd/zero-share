// Regression guard for P0 "offer link silently corrupted when location.href
// carries a URL fragment — fragment lands before /receive so `s` never
// reaches the peer" (#120) AND its follow-up "origin-only base regresses
// sub-path deployments — offer link drops the app's base path (404)".
//
// Pre-#120, OfferPage.createSDPLink() built the offer link from
// location.href with ONLY the query string stripped:
//
//     buildURL(location.href.split('?')[0], 'receive', { s, i, c, p })
//
// The app's own pages deep-link with fragments (both OfferPage and
// ReceivePage render `GITHUB_LINK + '#how-does-it-work'`), so any offer-page
// load whose URL carries a fragment — a restored tab at `/#...`, an
// embedded/bookmarked URL with an anchor, or a pasted URL with a hash —
// persisted that fragment in location.href for the whole session. buildURL
// then joined the base with a single `/`, producing e.g.
//
//     https://zero-share.github.io/#how-does-it-work/receive?s=...&p=...
//
// Per URL parsing rules, everything after `#` is a fragment, NOT part of the
// URL: the peer's browser navigates to the origin root with an empty query,
// ReceivePage hits its "no sdp found" guard and bounces back to the offer
// page. The sender sees a well-formed link (and QR code) and the handshake
// silently dead-ends.
//
// #120 "fixed" it by using the bare ORIGIN as the base
// (`new URL(location.href).origin`), which dropped the fragment but also
// dropped the DEPLOYMENT LOCATION: the app's pages are indeed only `/` and
// `/receive/`, but the static build is routinely served under a sub-path
// (an org GitHub Pages site like `https://<org>.github.io/zero-share/`, or
// a self-hosted build on a sub-path — both documented in the README's
// "Deployment" section). Origin-only made the offer link on such hosts
// point at `<origin>/receive` — a 404, or the outer site's root — and made
// ReceivePage's no-`s` bounce land at the deployment root instead of the
// app's offer page.
//
// The fix (this task) derives the base from the offer page's CONTAINING
// DIRECTORY: `appBaseFrom(location.href)` = origin + the pathname up to and
// including its last '/', with the query string, the fragment, and any
// incidental leaf component (e.g. `index.html`) dropped. The offer page is
// always the deployment's base-root page, so the offer page is never
// reachable deeper than the base and the derivation cannot over-trim.
// ReceivePage's no-`s` bounce uses the same shared derivation via
// `receiveBounceTarget(href)` (the receive route leaf stripped from the
// current URL, then the containing directory).
//
// This test pins BOTH contracts against the REAL helpers:
//   1. fragment-stripping (#120): fragment-bearing bases never leak a
//      fragment into the generated link (no `#`, path ending `/receive`,
//      params intact), and documents the pre-fix mechanism (a
//      fragment-bearing base mangles the link exactly as reported).
//   2. sub-path preservation (this task): sub-path bases survive into the
//      generated link (path = `<subpath>/receive`) instead of 404ing at the
//      deployment root, and the canonical root deployment stays
//      byte-identical to #120's origin-only output.
//   3. receive bounce: a no-`s` receive URL bounces to the app's offer
//      page on root AND sub-path hosts, with no query/fragment leakage.
//   4. by source inspection that both call sites use the shared helpers
//      (OfferPage: `buildURL(appBaseFrom(location.href), 'receive', ...)`;
//      ReceivePage: `receiveBounceTarget(window.location.href)`) and that
//      the two legacy defects are gone: the query-only `split('?')[0]`
//      (leaks the fragment) and the bare `.origin` / bare
//      `window.location.origin` (drops the sub-path).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Exercise the REAL helpers instead of copies that could drift: `appBaseFrom`
// (the base OfferPage passes to buildURL), `receiveBounceTarget` (the bounce
// ReceivePage navigates to), and `buildURL` (the link assembly both share).
const { appBaseFrom, receiveBounceTarget, buildURL } = await import(
  join(here, '..', 'src', 'utils', 'path.ts')
);

// Simulate exactly what the fixed OfferPage.createSDPLink does: build the
// link from the offer page's containing directory (origin + pathname up to
// and including its last '/'), dropping query, fragment, and any incidental
// leaf component while PRESERVING the deployment location.
function buildOfferLink(locationHref, params) {
  return buildURL(appBaseFrom(locationHref), 'receive', params);
}

const params = {
  s: 'abcDEF',
  i: '',
  c: '',
  p: 'PUBLICKEY'
};

// ---- Test 1: fragment-only bases — #120's reported corruption case ----
{
  // The live, documented anchor both Svelte pages deep-link to.
  const fragmentBases = [
    'https://zero-share.github.io/#how-does-it-work', // reproduction case
    'https://zero-share.github.io/index.html#how-does-it-work', // fragment after a path
    'https://zero-share.github.io/?x=1#how-does-it-work', // query AND fragment
    'https://zero-share.github.io/#', // bare empty fragment
    'https://zero-share.github.io/?how-does-it-work=1' // query only (no fragment)
  ];
  for (const base of fragmentBases) {
    const link = buildOfferLink(base, params);
    assert.ok(!link.includes('#'), `generated link must not contain a fragment: ${link}`);
    const parsed = new URL(link);
    assert.equal(
      parsed.pathname,
      '/receive',
      `peer must land on the receive page for base ${JSON.stringify(base)}, got ${parsed.pathname}`
    );
    assert.equal(
      parsed.searchParams.get('s'),
      'abcDEF',
      `s= must survive for base ${JSON.stringify(base)}`
    );
    assert.equal(
      parsed.searchParams.get('p'),
      'PUBLICKEY',
      `p= must survive for base ${JSON.stringify(base)}`
    );
  }
  assert.equal(
    buildOfferLink('https://zero-share.github.io/#how-does-it-work', params),
    'https://zero-share.github.io/receive?s=abcDEF&p=PUBLICKEY',
    'the #120 reproduction case must yield exactly the well-formed link'
  );
  assert.ok(
    !buildOfferLink('https://zero-share.github.io/index.html#how-does-it-work', params).includes(
      'index.html'
    ),
    'an incidental path component (index.html) must not survive into the link'
  );
  console.log(
    `ok - ${fragmentBases.length} fragment/query bases all yield a clean /receive link with s= and p= intact`
  );
}

// ---- Test 2: document the pre-fix mechanism — an unstripped fragment mangles the link ----
{
  // What location.href.split('?')[0] LEFT behind pre-#120, fed straight to buildURL:
  const preFixLink = buildURL('https://zero-share.github.io/#how-does-it-work', 'receive', params);
  assert.ok(
    preFixLink.includes('#'),
    'the pre-fix link must contain a fragment (proves the base fragment leaks)'
  );
  const parsed = new URL(preFixLink);
  assert.equal(parsed.pathname, '/', 'pre-#120: peer lands on the origin root, not /receive');
  assert.equal(parsed.searchParams.get('s'), null, 'pre-#120: s= never reaches the peer');
  assert.equal(parsed.searchParams.get('p'), null, 'pre-#120: p= never reaches the peer');
  assert.equal(
    parsed.hash,
    '#how-does-it-work/receive?s=abcDEF&p=PUBLICKEY',
    'the whole link collapsed into the fragment'
  );
  console.log(
    'ok - unstripped fragment reproduces the #120 corruption (s= lost, peer bounces to root)'
  );
}

// ---- Test 3: params with special characters still encode correctly after stripping ----
{
  // SDP payloads contain spaces, parens and `=` — buildURL must encodeURIComponent
  // them, and stripping must not eat any character of the encoded value.
  const sdp = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0';
  const link = buildOfferLink('https://zero-share.github.io/#how-does-it-work', {
    s: sdp,
    i: 'turn:turn.example.com:3478?transport=udp',
    c: '4194304',
    p: 'PUB'
  });
  const parsed = new URL(link);
  assert.ok(!link.includes('#'), 'no fragment may survive in the generated link');
  assert.equal(parsed.pathname, '/receive');
  assert.equal(
    parsed.searchParams.get('s'),
    sdp,
    'multi-line SDP must round-trip through the link'
  );
  assert.equal(parsed.searchParams.get('i'), 'turn:turn.example.com:3478?transport=udp');
  assert.equal(parsed.searchParams.get('c'), '4194304');
  console.log(
    'ok - special-character params (SDP, turn: URL) round-trip intact after fragment stripping'
  );
}

// ---- Test 4: sub-path deployments keep their base path in the offer link ----
{
  // The regression this task fixes: #120's origin-only base dropped the
  // deployment location, so an offer generated at
  // `https://ntsd.github.io/zero-share/` pointed the peer at
  // `https://ntsd.github.io/receive` — a 404 / the outer site's root —
  // instead of the app's real receive page under the sub-path.
  const subPathCases = [
    // [offer page URL, expected generated link]
    [
      'https://ntsd.github.io/zero-share/',
      'https://ntsd.github.io/zero-share/receive?s=abcDEF&p=PUBLICKEY'
    ],
    [
      'https://ntsd.github.io/zero-share/index.html',
      'https://ntsd.github.io/zero-share/receive?s=abcDEF&p=PUBLICKEY'
    ],
    [
      // sub-path + fragment: both defects at once — the fragment must be
      // dropped AND the sub-path must survive
      'https://ntsd.github.io/zero-share/#how-does-it-work',
      'https://ntsd.github.io/zero-share/receive?s=abcDEF&p=PUBLICKEY'
    ],
    [
      // deeper sub-path with a fragment
      'https://ntsd.github.io/a/zero-share/index.html#f',
      'https://ntsd.github.io/a/zero-share/receive?s=abcDEF&p=PUBLICKEY'
    ],
    [
      // self-hosted reproduction from the bug report (built files served
      // under /zero-share/ by a static server)
      'http://localhost:4173/zero-share/',
      'http://localhost:4173/zero-share/receive?s=abcDEF&p=PUBLICKEY'
    ]
  ];
  for (const [href, expected] of subPathCases) {
    const link = buildOfferLink(href, params);
    assert.ok(!link.includes('#'), `no fragment for ${JSON.stringify(href)}: ${link}`);
    assert.equal(
      link,
      expected,
      `sub-path base ${JSON.stringify(href)} must be preserved in the offer link`
    );
    const parsed = new URL(link);
    // every query param must survive, not just s= and p=
    assert.equal(parsed.searchParams.get('s'), 'abcDEF');
    assert.equal(parsed.searchParams.get('p'), 'PUBLICKEY');
  }
  console.log(
    `ok - ${subPathCases.length} sub-path offer-page URLs all keep their base path in the offer link`
  );
}

// ---- Test 5: canonical root deployment is byte-identical to #120's output ----
{
  // For a domain-root deployment the containing directory IS the origin
  // root, so appBaseFrom must produce exactly what #120's origin-only base
  // produced: no behavior change for the canonical host.
  const canonicalBases = [
    'https://zero-share.github.io/',
    'https://zero-share.github.io/#how-does-it-work',
    'https://zero-share.github.io/index.html',
    'https://zero-share.github.io/?x=1#how-does-it-work'
  ];
  for (const base of canonicalBases) {
    assert.equal(
      buildOfferLink(base, params),
      buildURL(new URL(base).origin, 'receive', params),
      `canonical root deployment must be byte-identical to the origin-only output for ${JSON.stringify(
        base
      )}`
    );
  }
  // ...and the special-character round-trip must survive on a sub-path base too
  const sdp = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0';
  const link = buildOfferLink('https://ntsd.github.io/zero-share/#how-does-it-work', {
    s: sdp,
    i: 'turn:turn.example.com:3478?transport=udp',
    c: '4194304',
    p: 'PUB'
  });
  const parsed = new URL(link);
  assert.ok(!link.includes('#'), 'no fragment may survive on a sub-path base');
  assert.equal(parsed.pathname, '/zero-share/receive');
  assert.equal(parsed.searchParams.get('s'), sdp, 'multi-line SDP must round-trip');
  assert.equal(parsed.searchParams.get('i'), 'turn:turn.example.com:3478?transport=udp');
  assert.equal(parsed.searchParams.get('c'), '4194304');
  console.log(
    'ok - canonical root output is byte-identical to #120; sub-path params round-trip intact'
  );
}

// ---- Test 6: ReceivePage's no-`s` bounce lands on the app's offer page ----
{
  // Pre-fix, ReceivePage bounced to window.location.origin — the deployment
  // ROOT — which on a sub-path host drops the peer off the app entirely.
  // receiveBounceTarget strips the `receive` route leaf and takes the
  // containing directory: the offer page's URL, on any host.
  const bounceCases = [
    // [receive page URL, expected bounce target]
    ['https://zero-share.github.io/receive/', 'https://zero-share.github.io/'],
    ['https://zero-share.github.io/receive', 'https://zero-share.github.io/'],
    ['https://ntsd.github.io/zero-share/receive/', 'https://ntsd.github.io/zero-share/'],
    ['https://ntsd.github.io/zero-share/receive', 'https://ntsd.github.io/zero-share/'],
    // query/fragment on the receive URL must not leak into the bounce
    [
      'https://ntsd.github.io/zero-share/receive/?x=1#how-does-it-work',
      'https://ntsd.github.io/zero-share/'
    ],
    // the self-hosted reproduction host from the bug report
    ['http://localhost:4173/zero-share/receive/', 'http://localhost:4173/zero-share/'],
    ['http://localhost:4173/zero-share/receive', 'http://localhost:4173/zero-share/']
  ];
  for (const [href, expected] of bounceCases) {
    const target = receiveBounceTarget(href);
    assert.equal(
      target,
      expected,
      `no-s bounce for ${JSON.stringify(href)} must land on the app's offer page`
    );
    assert.ok(!target.includes('#'), `bounce target must never carry a fragment: ${target}`);
    assert.ok(!target.includes('?'), `bounce target must never carry a query: ${target}`);
  }
  // Document the pre-fix mechanism: the bare origin drops the sub-path
  const preFixBounce = new URL('https://ntsd.github.io/zero-share/receive/').origin;
  assert.equal(
    preFixBounce,
    'https://ntsd.github.io',
    'pre-fix: window.location.origin is the deployment root, not the app'
  );
  assert.notEqual(
    preFixBounce,
    receiveBounceTarget('https://ntsd.github.io/zero-share/receive/'),
    'pre-fix origin bounce and the fixed bounce must differ on a sub-path host'
  );
  console.log(
    `ok - ${bounceCases.length} no-s receive URLs all bounce to the app's offer page (sub-path preserved, no query/fragment)`
  );
}

// ---- Test 7: both call sites use the shared helpers; both legacy defects are gone ----
{
  const offerSource = readFileSync(
    join(here, '..', 'src', 'components', 'OfferPage.svelte'),
    'utf8'
  );
  const receiveSource = readFileSync(
    join(here, '..', 'src', 'components', 'ReceivePage.svelte'),
    'utf8'
  );

  // OfferPage: the base must come from appBaseFrom(location.href), passed
  // DIRECTLY to buildURL for the receive path.
  assert.ok(
    /import\s*\{\s*appBaseFrom\s*,\s*buildURL\s*\}\s*from\s*['"]\.\.\/utils\/path['"]/.test(
      offerSource
    ),
    'OfferPage must import appBaseFrom and buildURL from ../utils/path'
  );
  assert.ok(
    /offerLink\s*=\s*buildURL\(\s*appBaseFrom\(location\.href\),\s*'receive'/.test(offerSource),
    'OfferPage must build the offer link as buildURL(appBaseFrom(location.href), "receive", ...)'
  );
  // #120's defect: a bare .origin drops the deployment location.
  assert.ok(
    !/buildURL\(\s*new\s+URL\(location\.href\)\.origin/.test(offerSource),
    'OfferPage must not build the link from a bare origin (drops the sub-path deployment location)'
  );
  // Pre-#120's defect: a query-only split leaks the fragment.
  assert.ok(
    !/location\.href\.split\(\s*'?\?'?\s*\)\[0\]/.test(offerSource),
    'OfferPage must not strip only the query string from location.href (query-only split leaks the fragment)'
  );
  assert.ok(
    !/buildURL\(\s*location\.href/.test(offerSource),
    'OfferPage must not pass the raw location.href to buildURL'
  );

  // ReceivePage: the no-s bounce must go through receiveBounceTarget, and
  // both legacy targets must be gone.
  assert.ok(
    /import\s*\{\s*receiveBounceTarget\s*\}\s*from\s*['"]\.\.\/utils\/path['"]/.test(receiveSource),
    'ReceivePage must import receiveBounceTarget from ../utils/path'
  );
  assert.ok(
    /window\.location\.assign\(\s*receiveBounceTarget\(window\.location\.href\)\s*\)/.test(
      receiveSource
    ),
    'ReceivePage must bounce via receiveBounceTarget(window.location.href)'
  );
  assert.ok(
    !/window\.location\.assign\(\s*window\.location\.origin\s*\)/.test(receiveSource),
    'ReceivePage must not bounce to a bare origin (drops the sub-path deployment location)'
  );
  console.log(
    'ok - both call sites use the shared helpers; the query-only split and the bare-origin bases are gone'
  );
}

console.log(
  'ok - offer link base keeps the deployment location AND never leaks a fragment; no-s bounce lands on the app offer page'
);
