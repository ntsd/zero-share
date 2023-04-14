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
          primary: '#570df8',
          'primary-content': '#ffffff',
          secondary: '#f000b8',
          'secondary-content': '#ffffff',
          accent: '#37cdbe',
          'accent-content': '#163835',
          neutral: '#3d4451',
          'neutral-content': '#ffffff',
          'base-100': '#ffffff',
          'base-200': '#F2F2F2',
          'base-300': '#E5E6E6',
          'base-content': '#1f2937',
          '--rounded-box': '0',
          '--rounded-btn': '0',
          '--rounded-badge': '0',
          '--tab-radius': '0'
        }
      }
    ]
  }
};
