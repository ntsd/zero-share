<script lang="ts">
  import '../app.css';
  import Footer from '../components/layout/Footer.svelte';
  import Navbar from '../components/layout/Navbar.svelte';

  import Toast from '../components/Toast.svelte';
  import { pageDescription } from '../configs';

  if ('serviceWorker' in navigator) {
    addEventListener('load', function () {
      navigator.serviceWorker.register('./service-worker.js');
    });
  }
</script>

<div class="flex flex-col h-screen">
  <Navbar />
  <div class="flex-grow container mx-auto justify-items-center">
    <p class="text-center mb-4 xl:mb-8 p-1">
      {pageDescription}
    </p>
    <slot />
  </div>
  <Footer />
</div>
<Toast />
