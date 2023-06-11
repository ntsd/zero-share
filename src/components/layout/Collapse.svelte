<script lang="ts">
  export let title: string;
  export let isOpen: boolean;
</script>

<div
  tabindex="-1"
  class="collapse border border-base-300 {isOpen ? 'collapse-open' : 'collapse-close'}"
>
  <div class="collapse-title text-xl {isOpen ? 'font-bold' : 'font-light bg-base-200'}">
    {title}
  </div>
  <div class="collapse-content">
    {#if isOpen}
      <slot />
    {/if}
  </div>
</div>
