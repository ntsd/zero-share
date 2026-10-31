// Regression guard for the PWA/SEO sub-path deployment contract: the static
// origin/site-root-absolute references that broke on exactly the sub-path
// hosts the app is designed to support (org GitHub Pages like
// `https://<org>.github.io/zero-share/`, self-hosted builds on a base).
//
// Two defects:
//
// 1. `public/manifest.webmanifest` shipped `start_url: "/"` and icons
//    `/pwa-192x192.png`, `/pwa-512x512.png` — site-root-absolute. On a
//    sub-path host `start_url` resolved to the OUTER site root (a PWA install
//    launched away from the app) and both icons 404'd. Astro copies
//    `public/` into the build dir verbatim, so the only sub-path-agnostic
//    fix is manifest-relative paths (`"."`, `./…`), which resolve against
//    the manifest's own location (the app root) on any host.
//
// 2. `src/layouts/main.astro` hardcoded
//    `og:image` = `https://zero-share.github.io/cover.png` — the canonical
//    root domain — so on a sub-path/org host the share card pointed at a
//    different origin's asset. The fix derives the cover URL from the
//    configured site origin + `import.meta.env.BASE_URL` (Vite's build base,
//    '/' at the root, '/<base>' under a sub-path), falling back to the
//    base-prefixed relative path when no `site` is configured.
//
// These tests pin BOTH the source contract and the EMITTED build output:
//   1. the manifest (source AND emitted build/manifest.webmanifest) carries
//      only relative start_url/icons — never a site-root-absolute value.
//   2. `main.astro` no longer hardcodes the canonical-domain og:image and
//      derives it from site origin + BASE_URL; the manifest/icon links are
//      base-prefixed too (a root-absolute manifest link was the same class
//      of 404 on sub-path hosts).
//   3. a REAL sub-path build (`base: '/zero-share'`, org Pages host) emits
//      an og:image on the build target's OWN host + base, a base-prefixed
//      manifest link, and the relative manifest verbatim.
//   4. the canonical root build stays byte-identical on og:image
//      (`https://zero-share.github.io/cover.png`) and root-absolute links —
//      the documented deployment is unchanged.
//
// The build assertions run a real `astro build` (repo's installed bin); if
// the bin is missing they are skipped (the source/manifest guards still run).
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const manifest = JSON.parse(readFileSync(join(repo, 'public', 'manifest.webmanifest'), 'utf8'));
const layout = readFileSync(join(repo, 'src', 'layouts', 'main.astro'), 'utf8');

// ---- Test 1: manifest start_url + icons are relative, never root-absolute ----
{
  // "." or any "./…"-prefixed value resolves against the manifest's own
  // location (the app root) on BOTH root and sub-path hosts.
  assert.ok(
    manifest.start_url === '.' || manifest.start_url.startsWith('./'),
    `manifest start_url must be manifest-relative ("." / "./…"), got ${JSON.stringify(manifest.start_url)}`
  );
  assert.ok(
    manifest.start_url !== '/' && !/^\/[^.]/.test(manifest.start_url),
    `manifest start_url must not be site-root-absolute, got ${JSON.stringify(manifest.start_url)}`
  );
  assert.ok(
    Array.isArray(manifest.icons) && manifest.icons.length >= 2,
    'the manifest must keep both icons'
  );
  const expectedIcons = ['./pwa-192x192.png', './pwa-512x512.png'];
  for (const icon of manifest.icons) {
    assert.ok(
      icon.src === '.' || icon.src.startsWith('./'),
      `manifest icon src must be manifest-relative, got ${JSON.stringify(icon.src)}`
    );
    assert.ok(
      !icon.src.startsWith('/'),
      `manifest icon src must not be site-root-absolute: ${JSON.stringify(icon.src)}`
    );
  }
  assert.equal(
    manifest.icons.map((i) => i.src).join(','),
    expectedIcons.join(','),
    'both icon entries must point at the app-root pwa-*.png files via ./… paths'
  );
  console.log(
    'ok - manifest start_url and both icon srcs are manifest-relative, not site-root-absolute'
  );
}

// ---- Test 2: main.astro derives og:image from site + base; no hardcoded canonical domain ----
{
  assert.ok(
    !/content="https:\/\/zero-share\.github\.io\/cover\.png"/.test(layout),
    'main.astro must not hardcode the canonical root-domain og:image'
  );
  assert.ok(
    !/zero-share\.github\.io/.test(layout),
    'main.astro must not reference the canonical domain anywhere'
  );
  // The og:image must be built from the configured site origin so a sub-path
  // build targets the right host, and from Vite's build base so the cover
  // stays under the deployment location.
  assert.ok(
    /import\.meta\.env\.BASE_URL/.test(layout),
    'main.astro must derive the asset path from import.meta.env.BASE_URL (the build base)'
  );
  assert.ok(
    /Astro\.site\s*\?/.test(layout) &&
      /new URL\(\s*`\$\{base\}cover\.png`\s*,\s*Astro\.site\)/.test(layout),
    'main.astro must absolutize the cover against Astro.site when a site is configured'
  );
  assert.ok(
    /<meta property="og:image" content=\{ogImage\} \/>/.test(layout),
    'the og:image meta must use the derived value, not a static URL'
  );
  // Same class of 404 on sub-path hosts: the manifest + icon links must be
  // base-prefixed instead of hardcoded to the site root. (Source form: an
  // Astro expression wrapper `{`${base}…`}` around the href attribute.)
  assert.ok(
    /<link rel="manifest" href=\{`\$\{base\}manifest\.webmanifest`\} \/>/.test(layout),
    'the manifest link must be base-prefixed (root-absolute 404s under a sub-path host)'
  );
  assert.ok(
    /<link rel="icon" href=\{`\$\{base\}favicon\.ico`\} \/>/.test(layout),
    'the favicon link must be base-prefixed (root-absolute 404s under a sub-path host)'
  );
  console.log(
    'ok - main.astro derives og:image/manifest/icon from site + BASE_URL; no hardcoded canonical domain'
  );
}

// ---- Test 3 + 4: real builds — sub-path and canonical root ----
const astroBin = join(repo, 'node_modules', 'astro', 'astro.js');
if (existsSync(astroBin)) {
  const SUBPATH_SITE = 'https://ntsd.github.io/zero-share';

  function buildWith(outDir, extra) {
    // Throwaway config in the repo root so Astro's import resolution
    // (integrations, tailwind) sees the same node_modules as the real build.
    const configPath = join(repo, `.astro-test-config-${outDir}.mjs`);
    const outDirPath = join(repo, outDir);
    writeFileSync(
      configPath,
      [
        "import { defineConfig } from 'astro/config';",
        "import svelte from '@astrojs/svelte';",
        "import serviceWorker from 'astrojs-service-worker';",
        "import tailwindcss from '@tailwindcss/vite';",
        `export default defineConfig({${extra}`,
        `  outDir: './${outDir}',`,
        "  output: 'static',",
        '  compressHTML: true,',
        '  integrations: [svelte(), serviceWorker()],',
        '  vite: {',
        '    plugins: [tailwindcss()],',
        "    resolve: { conditions: ['browser'] }",
        '  }',
        '});',
        ''
      ].join('\n'),
      'utf8'
    );
    try {
      execFileSync(
        process.execPath,
        [astroBin, 'build', '--config', `.astro-test-config-${outDir}.mjs`],
        {
          cwd: repo,
          stdio: 'pipe'
        }
      );
    } finally {
      rmSync(configPath, { force: true });
    }
    assert.ok(
      existsSync(join(outDirPath, 'index.html')),
      `the ${outDir} build must emit index.html`
    );
  }

  // Sub-path: an org GitHub Pages host serving the app under /zero-share/.
  {
    const outDir = 'build-subpath-test';
    buildWith(outDir, "  site: 'https://ntsd.github.io/zero-share',\n  base: '/zero-share',\n");
    const out = join(repo, outDir);
    const indexHtml = readFileSync(join(out, 'index.html'), 'utf8');
    const receiveHtml = readFileSync(join(out, 'receive', 'index.html'), 'utf8');
    for (const [name, html] of [
      ['index', indexHtml],
      ['receive', receiveHtml]
    ]) {
      assert.ok(
        !/zero-share\.github\.io/.test(html),
        `${name}: a sub-path build must not carry the canonical root-domain URL`
      );
      const og = html.match(/<meta property="og:image" content=(["'])([^"']*)\1/);
      assert.ok(og, `${name}: the og:image meta must be present`);
      assert.equal(
        og[2],
        `${SUBPATH_SITE}/cover.png`,
        `${name}: og:image must point at the build target's own host + base`
      );
      // compressHTML may emit single-quoted attributes and drop the
      // self-closing slash on void elements — allow either.
      assert.ok(
        /<link rel="manifest" href=["']\/zero-share\/manifest\.webmanifest["'] ?\/?>/.test(html),
        `${name}: the manifest link must be base-prefixed`
      );
      assert.ok(
        /<link rel="icon" href=["']\/zero-share\/favicon\.ico["'] ?\/?>/.test(html),
        `${name}: the favicon link must be base-prefixed`
      );
    }
    // The emitted manifest is what the browser receives under the sub-path:
    // Astro copies public/ verbatim, so it must stay byte-identical AND the
    // relative references must resolve (against the app root) to files that
    // actually exist in the build output.
    assert.equal(
      readFileSync(join(out, 'manifest.webmanifest'), 'utf8'),
      readFileSync(join(repo, 'public', 'manifest.webmanifest'), 'utf8'),
      'the emitted manifest must be byte-identical to public/manifest.webmanifest'
    );
    const emitted = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8'));
    const baseDir = `${SUBPATH_SITE}/zero-share`;
    const resolved = (ref) => new URL(ref, `${baseDir}/manifest.webmanifest`).toString();
    assert.equal(
      resolved(emitted.start_url),
      `${baseDir}/`,
      'start_url must resolve to the app root under the sub-path'
    );
    for (const icon of emitted.icons) {
      assert.ok(
        existsSync(join(out, icon.src.slice(2))),
        `icon ${icon.src} must resolve to a file that exists in the build output`
      );
    }
    assert.ok(
      existsSync(join(out, 'cover.png')),
      'the cover asset the sub-path og:image points at must be in the build'
    );
    rmSync(out, { recursive: true, force: true });
    console.log(
      `ok - sub-path build: og:image on the target host + base, base-prefixed links, relative manifest resolves`
    );
  }

  // Canonical root: the documented deployment must stay byte-identical. The
  // repo's real astro.config.mjs always sets `site`, so the root build here
  // must too (the no-`site` relative fallback is a separate, deliberate
  // behavior pinned by the source guard in test 2).
  {
    const outDir = 'build-root-test';
    buildWith(outDir, "  site: 'https://zero-share.github.io',\n");
    const out = join(repo, outDir);
    const indexHtml = readFileSync(join(out, 'index.html'), 'utf8');
    assert.equal(
      indexHtml.match(/<meta property="og:image" content=(["'])([^"']*)\1/)[2],
      'https://zero-share.github.io/cover.png',
      'root build: og:image must stay the canonical root-domain URL'
    );
    assert.ok(
      /<link rel="manifest" href=["']\/manifest\.webmanifest["'] ?\/?>/.test(indexHtml),
      'root build: the manifest link must stay root-absolute'
    );
    assert.ok(
      /<link rel="icon" href=["']\/favicon\.ico["'] ?\/?>/.test(indexHtml),
      'root build: the favicon link must stay root-absolute'
    );
    assert.equal(
      readFileSync(join(out, 'manifest.webmanifest'), 'utf8'),
      readFileSync(join(repo, 'public', 'manifest.webmanifest'), 'utf8'),
      'root build: the emitted manifest must be byte-identical to public/manifest.webmanifest'
    );
    // start_url "." on the root host resolves to the app root, not off-app.
    const emitted = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8'));
    assert.equal(
      new URL(emitted.start_url, 'https://zero-share.github.io/manifest.webmanifest').toString(),
      'https://zero-share.github.io/',
      'root build: start_url must resolve to the app root'
    );
    for (const icon of emitted.icons) {
      assert.ok(
        existsSync(join(out, icon.src.slice(2))),
        `root build: icon ${icon.src} must exist in the output`
      );
    }
    rmSync(out, { recursive: true, force: true });
    console.log(
      'ok - root build: og:image/links byte-identical to the canonical deployment, manifest resolves'
    );
  }

  // No-`site` build: self-hosted builds may omit `site`; og:image must then
  // be the base-prefixed relative path (no origin to absolutize against).
  {
    const outDir = 'build-nosite-test';
    buildWith(outDir, "  base: '/zero-share',\n");
    const indexHtml = readFileSync(join(repo, outDir, 'index.html'), 'utf8');
    assert.equal(
      indexHtml.match(/<meta property="og:image" content=(["'])([^"']*)\1/)[2],
      '/zero-share/cover.png',
      'no-site build: og:image must be the base-prefixed relative path'
    );
    assert.ok(
      !/https?:\/\//.test(indexHtml.match(/<meta property="og:image" content=(["'])([^"']*)\1/)[2]),
      'no-site build: og:image must carry no hardcoded origin'
    );
    rmSync(join(repo, outDir), { recursive: true, force: true });
    console.log('ok - no-site build: og:image falls back to the base-prefixed relative path');
  }
} else {
  console.log(
    'skip - astro bin not installed; build-output assertions skipped (source guards above still ran)'
  );
}

console.log('ok - PWA manifest + og:image honor the sub-path deployment model');
