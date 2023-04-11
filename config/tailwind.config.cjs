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
            'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace',
          primary: '#4b6bfb',
          'primary-content': '#ffffff',
          secondary: '#7b92b2',
          'secondary-content': '#ffffff',
          accent: '#67cba0',
          'accent-content': '#163835',
          neutral: '#181a2a',
          'neutral-content': '#ffffff',
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
