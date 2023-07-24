<script lang="ts">
  import { githubLink } from '../../configs';
  import darkModeStore, { getDarkMode, setDarkMode } from '../../stores/darkModeStore';
  import Github from '../icons/Github.svelte';
  import SunMoon from '../icons/SunMoon.svelte';

  let darkMode = getDarkMode();
	darkModeStore.subscribe((darkMode) => {
		darkMode = darkMode;
	});
</script>

<div class="navbar w-full">
  <div class="navbar-start">
    <SunMoon onChange={setDarkMode} {darkMode} />
  </div>
  <div class="navbar-center text-xl font-bold">Zero Share</div>
  <div class="navbar-end">
    <a
      aria-label="Github"
      href={githubLink}
      target="_blank"
      rel="noopener noreferrer"
      class="btn btn-ghost drawer-button btn-square normal-case"
    >
      <Github/>
    </a>
  </div>
</div>
