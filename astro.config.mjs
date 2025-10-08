import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import serviceWorker from 'astrojs-service-worker';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://zero-share.github.io',
  outDir: './build',
  output: 'static',
  compressHTML: true,
  integrations: [svelte(), serviceWorker()],
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      conditions: ['browser']
    }
  }
});
