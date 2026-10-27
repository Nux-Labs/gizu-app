import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Kurage palette: ink backgrounds, cyan accent, violet second accent.
        ink: { DEFAULT: '#04060a', soft: '#0a0e15' },
        neon: { DEFAULT: '#7ce8f2', dim: '#3fa9b5', deep: '#0e2a33' },
        violet: { DEFAULT: '#b9a6ff', soft: '#d7ccff' },
      },
      boxShadow: {
        glass: '0 18px 40px -30px rgba(0,0,0,0.9)',
        neon: 'none',
      },
    },
  },
  plugins: [],
} satisfies Config
