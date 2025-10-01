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

<div class="toast">
  {#each toasts as toast}
    <div class="alert alert-{toast.status}">
      <div>
        <span>{toast.message}</span>
      </div>
    </div>
  {/each}
</div>
