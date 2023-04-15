<script lang="ts">
  import '../app.css';
  import Footer from '../components/Footer.svelte';
  import Navbar from '../components/Navbar.svelte';

  import Toast from '../components/Toast.svelte';
  import { pageDescription } from '../configs';

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
  <div class="flex-grow">
    <div class="container mx-auto justify-items-center">
      <slot />
    </div>
  </div>
  <Footer />
</div>
<Toast />
