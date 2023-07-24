import { get, writable } from 'svelte/store';

const localStorageKey = 'darkMode';

function setTheme(darkMode: boolean) {
  document?.querySelector('html')?.setAttribute('data-theme', darkMode ? 'dark' : 'light');
}

const darkModeStore = writable<boolean>(
  window?.matchMedia?.('(prefers-color-scheme:dark)')?.matches || false
);

// get dark mode from local storage
const localDarkMode = localStorage.getItem(localStorageKey);
switch (localDarkMode) {
  case 'true':
    setDarkMode(true);
    break;
  case 'false':
    setDarkMode(false);
}

export function getDarkMode(): boolean {
  return get(darkModeStore);
}

export function setDarkMode(darkMode: boolean): void {
  localStorage.setItem(localStorageKey, darkMode ? 'true' : 'false');
  setTheme(darkMode);
  darkModeStore.update(() => {
    return darkMode;
  });
}

export default darkModeStore;

setTheme(getDarkMode());
