<script lang="ts">
  export let title: string;
  export let isOpen: boolean = false;
</script>

<div
  tabindex="-1"
  class="collapse border border-base-200 {isOpen ? 'collapse-open bg-base-100' : 'collapse-close'}"
>
  <div class="collapse-title text-xl {isOpen ? 'font-bold' : 'font-light bg-base-300'}">
    {title}
  </div>
  <div class="collapse-content">
    {#if isOpen}
      <slot />
    {/if}
  </div>
</div>
