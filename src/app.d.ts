declare global {
  namespace App {
    // See https://kit.svelte.dev/docs/types#app
    // for information about these interfaces
  }

  interface Window {
    clipboardData: DataTransfer;
  }
}

export {};
