import { writable } from 'svelte/store';

interface ToastMessage {
	id: number;
	message: string;
}

const toastStore = writable<ToastMessage>();

export function addToastMessage(message: string): void {
	toastStore.update(() => { return { id: Date.now(), message } });
}

export default toastStore;
