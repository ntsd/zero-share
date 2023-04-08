<script lang="ts">
  import { onMount } from 'svelte';

  let dropArea: HTMLElement;
  let fileInput: HTMLInputElement;

  export let handleFilesPick: (files: FileList) => void;

  function setupDropAreaListeners() {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
      dropArea.addEventListener(
        eventName,
        (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
        },
        false
      );
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropArea.addEventListener(eventName, highlight, false);
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropArea.addEventListener(eventName, unhighlight, false);
    });

    dropArea.addEventListener('drop', handleDrop, false);
  }

  onMount(() => {
    setupDropAreaListeners();
  });

  function highlight() {
    dropArea.classList.add('bg-blue-200');
  }

  function unhighlight() {
    dropArea.classList.remove('bg-blue-200');
  }

  function handleDrop(e: DragEvent) {
    unhighlight();
    const files = e.dataTransfer?.files;
    if (files) {
      handleFilesPick(files);
    }
  }

  function handleFileInputChange() {
    if (fileInput.files) {
      handleFilesPick(fileInput.files);
    }
  }
</script>

<div
  class="relative flex flex-col text-gray-400 border border-gray-200 border-dashed rounded cursor-pointer"
  bind:this={dropArea}
>
  <input
    accept="*"
    type="file"
    multiple
    class="absolute inset-0 z-50 w-full h-full p-0 m-0 outline-none opacity-0 cursor-pointer"
    title=""
    bind:this={fileInput}
    on:change={handleFileInputChange}
  />

  <div class="flex flex-col items-center justify-center py-10 text-center">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class="w-6 h-6"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>

    <p class="m-0">Drag your files here or click in this area.</p>
  </div>
</div>
