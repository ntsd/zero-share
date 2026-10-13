<script lang="ts">
  type Props = {
    options: string[];
    customTextEnabled: boolean;
    value: string;
    onchange?: () => void;
  };

  let { options, customTextEnabled, value = $bindable(), onchange }: Props = $props();

  let selectedValue: string = $state(value);
  let customText: string = $state('');
  let editingCustomText = $state(false);
  let lastEmitted = $state(value);

  function toggleCustomText() {
    editingCustomText = !editingCustomText;
    if (editingCustomText) {
      customText = selectedValue;
    } else {
      selectedValue = customText;
    }
  }

  $effect(() => {
    const next = editingCustomText ? customText : selectedValue;
    value = next;
    if (next !== lastEmitted && onchange) {
      lastEmitted = next;
      onchange();
    }
  });
</script>

<div class="flex w-full">
  <div class="flex-grow">
    {#if !editingCustomText}
      <select class="select w-full" bind:value={selectedValue}>
        {#each options as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    {:else}
      <input type="text" class="input w-full" placeholder="Custom text" bind:value={customText} />
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
