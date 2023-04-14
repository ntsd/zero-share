<script lang="ts">
  export let title: string;
  export let isOpen: boolean;
</script>

<div
  tabindex="-1"
  class="collapse border border-base-300 {isOpen ? 'collapse-open' : 'collapse-close'}"
>
  <div class="collapse-title text-xl {isOpen ? 'font-semibold' : 'text-neutral-400 bg-neutral-50'}">
    {title}
  </div>
  <div class="collapse-content">
    <slot />
  </div>
</div>
