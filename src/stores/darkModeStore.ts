import { atom } from 'nanostores';

const localStorageKey = 'darkMode';

// get dark mode from local storage or system media
let defaultDarkMode = false;
const localDarkMode = localStorage.getItem(localStorageKey);
switch (localDarkMode) {
  case 'true':
    defaultDarkMode = true;
    break;
  case 'false':
    defaultDarkMode = false;
    break;
  case null:
    defaultDarkMode = window?.matchMedia?.('(prefers-color-scheme:dark)')?.matches || false;
}

export const darkModeAtom = atom<boolean>(defaultDarkMode);

function setTheme(darkMode: boolean) {
  document?.querySelector('html')?.setAttribute('data-theme', darkMode ? 'dark' : 'light');
}

export function getDarkMode(): boolean {
  return darkModeAtom.get();
}

export function setDarkMode(darkMode: boolean): void {
  localStorage.setItem(localStorageKey, darkMode ? 'true' : 'false');
  setTheme(darkMode);
  darkModeAtom.set(darkMode);
}

setTheme(getDarkMode());
