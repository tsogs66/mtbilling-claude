/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#f97316',
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c',
          800: '#9a3412',
          900: '#7c2d12',
        },
        ink: '#0f172a',
        surface: {
          DEFAULT: '#ffffff',
          muted: '#f8fafc',
          dark: '#0f172a',
          darker: '#020617',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 24px -4px rgba(249, 115, 22, 0.35)',
        'glow-sm': '0 0 16px -4px rgba(249, 115, 22, 0.25)',
        card: '0 1px 3px rgba(15, 23, 42, 0.04), 0 8px 24px -8px rgba(15, 23, 42, 0.08)',
        'card-hover': '0 4px 12px rgba(15, 23, 42, 0.06), 0 16px 40px -12px rgba(15, 23, 42, 0.12)',
        sidebar: '4px 0 24px -4px rgba(0, 0, 0, 0.15)',
      },
      backgroundImage: {
        'mesh-light':
          'radial-gradient(at 0% 0%, rgba(249,115,22,0.08) 0px, transparent 50%), radial-gradient(at 100% 0%, rgba(14,165,233,0.06) 0px, transparent 50%), radial-gradient(at 50% 100%, rgba(99,102,241,0.05) 0px, transparent 50%)',
        'mesh-dark':
          'radial-gradient(at 20% 20%, rgba(249,115,22,0.15) 0px, transparent 45%), radial-gradient(at 80% 80%, rgba(14,165,233,0.1) 0px, transparent 45%)',
        'login-grid':
          'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
      },
      backgroundSize: {
        grid: '48px 48px',
      },
      animation: {
        'fade-in': 'fade-in 0.4s ease-out forwards',
        'fade-in-up': 'fade-in-up 0.45s ease-out forwards',
        'slide-in-left': 'slide-in-left 0.35s ease-out forwards',
        'scale-in': 'scale-in 0.3s ease-out forwards',
        'pulse-soft': 'pulse-soft 2.5s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'float': 'float 6s ease-in-out infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'spin-slow': 'spin 8s linear infinite',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-left': {
          '0%': { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 20px -4px rgba(249, 115, 22, 0.3)' },
          '50%': { boxShadow: '0 0 28px -2px rgba(249, 115, 22, 0.5)' },
        },
      },
    },
  },
  plugins: [],
};
