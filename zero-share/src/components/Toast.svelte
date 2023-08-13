<script lang="ts">
  import { fade } from 'svelte/transition';
  import { onDestroy } from 'svelte';
  import toastStore from '../stores/toastStore';

  interface Toast {
    text: string;
    visible: boolean;
    status: 'info' | 'success' | 'error';
  }

  const duration = 3000;
  let toasts: Toast[] = [];

  function addToast(text: string, status: 'info' | 'success' | 'error'): void {
    const toast = { text, visible: true, status };
    toasts = [toast, ...toasts];

    setTimeout(() => {
      toast.visible = false;
      toasts = toasts.filter((t) => t !== toast);
    }, duration);
  }

  const unsubscribe = toastStore.subscribe((t) => {
    if (t) addToast(t.message, t.status);
  });

  onDestroy(() => {
    unsubscribe();
  });
</script>

<div class="fixed bottom-4 right-4 space-y-2">
  {#each toasts as toast}
    <div
      class="alert alert-{toast.status}"
      in:fade|global={{ duration: 300 }}
      out:fade|global={{ duration: 300 }}
      style={toast.visible ? '' : 'display: none;'}
    >
      <div>
        <span>{toast.text}</span>
      </div>
    </div>
  {/each}
</div>
