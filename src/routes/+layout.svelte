<script lang="ts">
  import '../app.css';
  import Footer from '../components/Footer.svelte';
  import Navbar from '../components/Navbar.svelte';

  import Toast from '../components/Toast.svelte';
  import { pageDescription } from '../configs';
</script>

<svelte:head>
  <title>Zero Share</title>
  <meta name="description" content={pageDescription} />
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
