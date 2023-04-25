<script lang="ts">
  import '../app.css';
  import Footer from '../components/Footer.svelte';
  import Navbar from '../components/Navbar.svelte';

  import Toast from '../components/Toast.svelte';
  import { githubLink, pageDescription } from '../configs';

  if ('serviceWorker' in navigator) {
    addEventListener('load', function () {
      navigator.serviceWorker.register('./service-worker.js');
    });
  }
</script>

<svelte:head>
  <title>Zero Share</title>
  <meta name="description" content={pageDescription} />
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="theme-color" content="#fff" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="Zero Share" />
  <meta property="og:description" content={pageDescription} />
  <meta property="og:image" content="%sveltekit.assets%/cover.png" />
</svelte:head>

<div class="flex flex-col h-screen">
  <Navbar />
  <div class="flex-grow container mx-auto justify-items-center">
    <div class="text-center mb-4 xl:mb-8">
      <p>
        {pageDescription} See
        <a
          class="link"
          href={githubLink + '#how-does-it-works'}
          target="_blank"
          rel="noopener noreferrer">How does it works?</a
        >
      </p>
    </div>
    <slot />
  </div>
  <Footer />
</div>
<Toast />
