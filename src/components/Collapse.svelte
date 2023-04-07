<script lang="ts">
  export let title: string;
  export let isOpen: boolean;
</script>

<div
  tabindex="-1"
  class="collapse collapse-arrow border border-base-300 {isOpen
    ? 'collapse-open'
    : 'collapse-close'}"
>
  <div class="collapse-title text-xl font-medium">{title}</div>
  <div class="collapse-content">
    <slot />
  </div>
</div>
