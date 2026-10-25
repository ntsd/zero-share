// Regression guard for P0 "offer link silently corrupted when location.href
// carries a URL fragment — fragment lands before /receive so `s` never
// reaches the peer".
//
// OfferPage.createSDPLink() built the offer link from location.href with
// ONLY the query string stripped:
//
//     buildURL(location.href.split('?')[0], 'receive', { s, i, c, p })
//
// The app's own pages deep-link with fragments (both OfferPage and
// ReceivePage render `GITHUB_LINK + '#how-does-it-work'`, and README.md has
// the `## How does it work?` heading), so any offer-page load whose URL
// carries a fragment — a restored tab at `/#...`, an embedded/bookmarked
// URL with an anchor, or a pasted URL with a hash — persists that fragment
// in location.href for the whole session. buildURL then joins the base with
// a single `/`, producing e.g.
//
//     https://zero-share.github.io/#how-does-it-work/receive?s=...&p=...
//
// Per URL parsing rules, everything after `#` is a fragment, NOT part of
// the URL: the peer's browser navigates to the origin root with an empty
// query, ReceivePage hits its "no sdp found" guard and bounces back to the
// offer page. The sender sees a well-formed link (and QR code) and the
// handshake silently dead-ends.
//
// The fix builds the link from location.href's ORIGIN instead of the raw
// string with only the query stripped:
//
//     buildURL(new URL(location.href).origin, 'receive', ...)
//
// (The app is a static site — astro.config.mjs lists only `/` and
// `/receive/` as routes — so the origin alone is the always-correct base:
// it drops the query string, the fragment, and any incidental path
// component such as `index.html` in one step.) This test pins:
//   1. the fragment-stripping contract against the REAL buildURL: bases
//      carrying fragments must not leak the fragment into the generated URL
//      (no `#`, parses to path `/receive`, all query params intact), and
//      documents the pre-fix mechanism (a fragment-bearing base mangles the
//      link exactly as reported).
//   2. by source inspection that OfferPage's link-build call site strips
//      both query AND fragment from location.href before passing the base
//      to buildURL (static check, mirroring the style of
//      tests/ice-server-consistency.test.mjs and
//      tests/offer-link-key-regeneration.test.mjs).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Exercise the REAL URL builder instead of a copy that could drift.
const { buildURL } = await import(join(here, '..', 'src', 'utils', 'path.ts'));

// Simulate exactly what the fixed OfferPage.createSDPLink does: build the
// link from the ORIGIN of location.href, dropping query, fragment, and any
// path component.
function buildOfferLink(locationHref, params) {
  return buildURL(new URL(locationHref).origin, 'receive', params);
}

const params = {
  s: 'abcDEF',
  i: '',
  c: '',
  p: 'PUBLICKEY'
};

// ---- Test 1: fragment-only bases — the reported corruption case ----
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
    'the reproduction case must yield exactly the well-formed link'
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
  // What location.href.split('?')[0] LEFT behind pre-fix, fed straight to buildURL:
  const preFixLink = buildURL('https://zero-share.github.io/#how-does-it-work', 'receive', params);
  assert.ok(
    preFixLink.includes('#'),
    'the pre-fix link must contain a fragment (proves the base fragment leaks)'
  );
  const parsed = new URL(preFixLink);
  assert.equal(parsed.pathname, '/', 'pre-fix: peer lands on the origin root, not /receive');
  assert.equal(parsed.searchParams.get('s'), null, 'pre-fix: s= never reaches the peer');
  assert.equal(parsed.searchParams.get('p'), null, 'pre-fix: p= never reaches the peer');
  assert.equal(
    parsed.hash,
    '#how-does-it-work/receive?s=abcDEF&p=PUBLICKEY',
    'the whole link collapsed into the fragment'
  );
  console.log(
    'ok - unstripped fragment reproduces the reported corruption (s= lost, peer bounces to root)'
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

// ---- Test 4: OfferPage's link-build call site uses the origin, not the raw location.href ----
{
  const offerSource = readFileSync(
    join(here, '..', 'src', 'components', 'OfferPage.svelte'),
    'utf8'
  );

  // The call site must derive the base from location.href's ORIGIN, which
  // drops the query string, the fragment, and any path component — so
  // neither a query nor a fragment (nor an incidental index.html) can ride
  // into the buildURL base.
  assert.ok(
    /new\s+URL\(location\.href\)\.origin/.test(offerSource),
    'OfferPage must build the offer link from new URL(location.href).origin (query, fragment, and path all dropped)'
  );
  assert.ok(
    /offerLink\s*=\s*buildURL\(\s*new\s+URL\(location\.href\)\.origin,\s*'receive'/.test(
      offerSource
    ),
    'the origin must be passed DIRECTLY to buildURL for the receive path'
  );
  // The old query-only split must be gone: with it, a fragment in
  // location.href would corrupt the generated link.
  assert.ok(
    !/location\.href\.split\(\s*'?\?'?\s*\)\[0\]/.test(offerSource),
    'OfferPage must not strip only the query string from location.href (query-only split leaks the fragment)'
  );
  assert.ok(
    !/buildURL\(\s*location\.href/.test(offerSource),
    'OfferPage must not pass the raw location.href to buildURL'
  );
  console.log(
    'ok - OfferPage link-build call site derives its base from the origin (query + fragment stripped)'
  );
}

console.log('ok - offer link is never corrupted by a fragment in location.href');
