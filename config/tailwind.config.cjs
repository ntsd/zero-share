/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  safelist: ['alert-info', 'alert-success', 'alert-error'],
  theme: {
    extend: {}
  },
  plugins: [require('daisyui')],
  darkMode: ['media'],
  daisyui: {
    styled: true,
    base: true,
    utils: true,
    logs: false,
    rtl: false,
    prefix: '',
    themes: [
      {
        light: {
          'color-scheme': 'light',
          fontFamily:
            'SFMono-Regular, Consolas, Menlo, Monaco, Liberation Mono, Courier New, monospace',
          primary: '#3b5bfb',
          'primary-content': '#fff',
          secondary: '#5b7292',
          'secondary-content': '#fff',
          accent: '#67cba0',
          'accent-content': '#fff',
          neutral: '#181a2a',
          'neutral-content': '#fff',
          'base-100': '#fff',
          'base-200': '#eee',
          'base-300': '#ddd',
          'base-content': '#181a2a',
          '--rounded-box': '0',
          '--rounded-btn': '0',
          '--rounded-badge': '0',
          '--tab-radius': '0'
        }
      },
      {
        dark: {
          'color-scheme': 'dark',
          fontFamily:
            'SFMono-Regular, Consolas, Menlo, Monaco, Liberation Mono, Courier New, monospace',
          primary: '#3b5bfb',
          'primary-content': '#fff',
          secondary: '#5b7292',
          'secondary-content': '#fff',
          accent: '#67cba0',
          'accent-content': '#fff',
          neutral: '#181a2a',
          'neutral-content': '#fff',
          'base-100': '#0d1117',
          'base-200': '#1d2127',
          'base-300': '#2d3137',
          'base-content': '#fff',
          '--rounded-box': '0',
          '--rounded-btn': '0',
          '--rounded-badge': '0',
          '--tab-radius': '0'
        }
      }
    ]
  }
};
