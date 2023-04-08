<script lang="ts">
  import { fade } from 'svelte/transition';
  import { onDestroy } from 'svelte';
  import toastStore from '../stores/toastStore';

  export let duration: number = 3000;
  let toasts: { text: string; visible: boolean }[] = [];

  function addToast(text: string): void {
    const toast = { text, visible: true };
    toasts = [toast, ...toasts];

    setTimeout(() => {
      toast.visible = false;
      toasts = toasts.filter((t) => t !== toast);
    }, duration);
  }

  const unsubscribe = toastStore.subscribe((t) => {
    if (t) addToast(t.message);
  });

  onDestroy(() => {
    unsubscribe();
  });
</script>

<div class="fixed bottom-4 right-4 space-y-2">
  {#each toasts as toast}
    <div
      class="alert alert-info"
      in:fade={{ duration: 300 }}
      out:fade={{ duration: 300 }}
      style={toast.visible ? '' : 'display: none;'}
    >
      <div>
        <span>{toast.text}</span>
      </div>
    </div>
  {/each}
</div>
