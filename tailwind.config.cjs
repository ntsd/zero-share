/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js,svelte,ts,astro}'],
  safelist: ['alert-info', 'alert-success', 'alert-error'],
  theme: {
    extend: {}
  },
  plugins: [require('daisyui')],
  darkMode: ['class'], // media for system dark mode
  daisyui: {
    styled: true,
    base: true,
    utils: true,
    logs: false,
    rtl: false,
    prefix: '',
    themes: [...require("daisyui-ntsd")]
  }
};
