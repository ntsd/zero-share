<script lang="ts">
  import { fade } from 'svelte/transition';
  import { toastAtom, type ToastMessage } from '../stores/toastStore';

  let toasts: ToastMessage[] = $state([]);

  toastAtom.subscribe((toastMessage) => {
    if (toastMessage) {
      const toast = { ...toastMessage };
      toasts = [toast, ...toasts];

      setTimeout(() => {
        toasts = toasts.filter((t) => t.id !== toast.id);
      }, toastMessage.duration);
    }
  });
</script>

<div class="fixed bottom-4 right-4 space-y-2">
  {#each toasts as toast}
    <div
      class="alert alert-{toast.status}"
      in:fade|global={{ duration: 300 }}
      out:fade|global={{ duration: 300 }}
    >
      <div>
        <span>{toast.message}</span>
      </div>
    </div>
  {/each}
</div>
