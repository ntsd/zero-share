/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {}
  },
  plugins: [require('daisyui')],
  daisyui: {
    styled: true,
    themes: true,
    base: true,
    utils: true,
    logs: false,
    rtl: false,
    prefix: '',
    themes: [
      {
        ZeroShare: {
          'color-scheme': 'light',
          fontFamily:
            'SFMono-Regular, Consolas, Menlo, Monaco, Liberation Mono, Courier New, monospace',
          primary: '#3b5bfb',
          'primary-content': '#ffffff',
          secondary: '#7b92b2',
          'secondary-content': '#181a2a',
          accent: '#67cba0',
          neutral: '#181a2a',
          'neutral-content': '#edf2f7',
          'base-100': '#ffffff',
          'base-content': '#181a2a',
          '--rounded-box': '0',
          '--rounded-btn': '0',
          '--rounded-badge': '0',
          '--tab-radius': '0'
        }
      }
    ]
  }
};
