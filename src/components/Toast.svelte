<script lang="ts">
  import { MAX_VISIBLE_TOASTS } from '../configs';
  import { toastAtom, type ToastMessage } from '../stores/toastStore';

  let toasts: ToastMessage[] = $state([]);

  toastAtom.subscribe((toastMessage) => {
    if (toastMessage) {
      const toast = { ...toastMessage };
      // Bounded rendered list: peer-driven toasts (one per rejected or failed
      // incoming file, one per chunk failure, ...) must not grow the DOM
      // unboundedly — keep only the most recent MAX_VISIBLE_TOASTS.
      toasts = [toast, ...toasts].slice(0, MAX_VISIBLE_TOASTS);

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
