import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#04060a', soft: '#0a0e15', card: '#0c1119' },
        neon: { DEFAULT: '#7ce8f2', dim: '#3fa9b5', deep: '#0e2a33' },
        violet: { DEFAULT: '#b9a6ff', soft: '#d7ccff' },
      },
      maxWidth: { shell: '1200px' },
    },
  },
  plugins: [],
} satisfies Config
