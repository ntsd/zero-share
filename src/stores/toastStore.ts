import { atom } from 'nanostores';

interface ToastMessage {
  id: number;
  message: string;
  status: 'info' | 'success' | 'error';
}

export const toastAtom = atom<ToastMessage | null>(null);

export function addToastMessage(
  message: string,
  status: 'info' | 'success' | 'error' = 'info'
): void {
  toastAtom.set({ id: Date.now(), message, status });
}
