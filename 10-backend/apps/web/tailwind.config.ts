import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Verde de marca (ventas / growth). Lo usa también el panel: NO tocar la escala.
        brand: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          900: '#14532d',
        },
        // Menta: frescura y acentos de gradiente para "ganancia".
        mint: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
        },
        // Azul profundo: confianza + zonas oscuras selectivas (hero/CTA/showcase).
        ink: {
          50: '#f4f7fb',
          100: '#e6edf6',
          200: '#c8d6e8',
          300: '#9bb1d1',
          400: '#6483b0',
          500: '#3f5e8f',
          600: '#2b4570',
          700: '#1f3357',
          800: '#152340',
          900: '#0d172c',
          950: '#070e1d',
        },
        // Coral: alertas / energía / detalles cálidos para romper la monocromía.
        coral: {
          50: '#fff1f2',
          100: '#ffe1e3',
          200: '#ffc8cc',
          300: '#ffa1a9',
          400: '#fb7185',
          500: '#f43f5e',
          600: '#e11d48',
          700: '#be123c',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(13, 23, 44, 0.04), 0 4px 16px rgba(13, 23, 44, 0.06)',
        card: '0 1px 3px rgba(13, 23, 44, 0.06), 0 10px 30px -12px rgba(13, 23, 44, 0.18)',
        float: '0 24px 60px -20px rgba(13, 23, 44, 0.35)',
        glow: '0 0 0 1px rgba(16, 185, 129, 0.18), 0 18px 50px -18px rgba(16, 185, 129, 0.45)',
      },
      backgroundImage: {
        'mint-brand': 'linear-gradient(120deg, #10b981 0%, #22c55e 100%)',
        'ink-deep': 'linear-gradient(165deg, #0d172c 0%, #152340 55%, #1f3357 100%)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'float-slow': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-16px)' },
        },
        draw: {
          '0%': { strokeDashoffset: '1' },
          '100%': { strokeDashoffset: '0' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.7s cubic-bezier(0.16, 1, 0.3, 1) both',
        float: 'float 6s ease-in-out infinite',
        'float-slow': 'float-slow 9s ease-in-out infinite',
        'pulse-soft': 'pulse-soft 2.4s ease-in-out infinite',
        shimmer: 'shimmer 2.5s linear infinite',
        // Registrada como animación con nombre para que Tailwind emita @keyframes draw.
        draw: 'draw 1.8s cubic-bezier(0.16, 1, 0.3, 1) forwards',
      },
    },
  },
  plugins: [],
};

export default config;
