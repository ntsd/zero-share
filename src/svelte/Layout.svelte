<script lang="ts">
  import Footer from '../components/layout/Footer.svelte';
  import Navbar from '../components/layout/Navbar.svelte';

  import Toast from '../components/Toast.svelte';
  import { pageDescription } from '../configs';
</script>

<div class="flex flex-col min-h-screen">
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
