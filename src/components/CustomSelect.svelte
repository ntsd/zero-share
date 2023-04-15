<script lang="ts">
  export let options: string[] = [];
  export let customTextEnabled: boolean = false;
  export let value = '';

  let selectedValue: string = value;
  let customText: string = '';
  let editingCustomText = false;

  function toggleCustomText() {
    editingCustomText = !editingCustomText;
    if (editingCustomText) {
      customText = selectedValue;
    } else {
      selectedValue = customText;
    }
  }

  $: value = editingCustomText ? customText : selectedValue;
</script>

<div class="flex w-full">
  <div class="flex-grow">
    {#if !editingCustomText}
      <select class="select select-bordered w-full" bind:value={selectedValue}>
        {#each options as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    {:else}
      <input
        type="text"
        class="input input-bordered w-full"
        placeholder="Custom text"
        bind:value={customText}
      />
    {/if}
  </div>

  {#if customTextEnabled}
    <div>
      <button class="btn btn-secondary" on:click={toggleCustomText}>
        {editingCustomText ? 'Select' : 'Custom'}
      </button>
    </div>
  {/if}
</div>
