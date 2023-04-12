import { writable } from 'svelte/store';

interface ToastMessage {
  id: number;
  message: string;
  status: 'info' | 'success' | 'error';
}

const toastStore = writable<ToastMessage>();

export function addToastMessage(
  message: string,
  status: 'info' | 'success' | 'error' = 'info'
): void {
  toastStore.update(() => {
    return { id: Date.now(), message, status };
  });
}

export default toastStore;
