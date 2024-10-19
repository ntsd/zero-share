<script lang="ts">
  type Props = {
    options: string[];
    customTextEnabled: boolean;
    value: string;
  };

  let { options, customTextEnabled, value = $bindable() }: Props = $props();

  let selectedValue: string = $state(value);
  let customText: string = $state('');
  let editingCustomText = $state(false);

  function toggleCustomText() {
    editingCustomText = !editingCustomText;
    if (editingCustomText) {
      customText = selectedValue;
    } else {
      selectedValue = customText;
    }
  }

  $effect(() => {
    value = editingCustomText ? customText : selectedValue;
  });
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
      <button class="btn btn-secondary" onclick={toggleCustomText}>
        {editingCustomText ? 'Select' : 'Custom'}
      </button>
    </div>
  {/if}
</div>
