/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/client/**/*.{js,jsx,ts,tsx}",
    "./src/client/index.html",
  ],
  theme: {
    extend: {
      fontFamily: {
        // 现代无衬线栈（含中文回退），不依赖外网字体，局域网可用
        sans: [
          'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue',
          'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', 'sans-serif'
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },
      colors: {
        // 深色玻璃质感所需的中性色阶
        ink: {
          900: '#080b14',
          800: '#0d1220',
          700: '#141a2b',
          600: '#1c2438',
        },
        brand: {
          400: '#7dd3fc',
          500: '#38bdf8',
          600: '#0ea5e9',
          700: '#0369a1',
        },
        violet2: {
          400: '#c4b5fd',
          500: '#a78bfa',
          600: '#8b5cf6',
        },
      },
      borderRadius: {
        '4xl': '2rem',
      },
      boxShadow: {
        glass: '0 8px 32px rgba(2, 6, 23, 0.45)',
        glow: '0 0 0 1px rgba(255,255,255,0.06), 0 10px 40px -10px rgba(56, 189, 248, 0.35)',
        card: '0 2px 6px rgba(2, 6, 23, 0.35)',
      },
      animation: {
        'bounce-in': 'bounceIn 0.4s ease-out',
        'fade-out': 'fadeOut 0.5s ease-in forwards',
        'fade-in': 'fadeIn 0.3s ease-out both',
        'bomb-shake': 'bombShake 0.5s ease-in-out',
        'aurora': 'aurora 18s ease-in-out infinite alternate',
      },
      keyframes: {
        bounceIn: {
          '0%': { opacity: '0', transform: 'translateX(-50%) scale(0.3)' },
          '50%': { opacity: '1', transform: 'translateX(-50%) scale(1.05)' },
          '100%': { transform: 'translateX(-50%) scale(1)' },
        },
        fadeOut: {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        bombShake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-8px) rotate(-2deg)' },
          '40%': { transform: 'translateX(8px) rotate(2deg)' },
          '60%': { transform: 'translateX(-5px)' },
          '80%': { transform: 'translateX(5px)' },
        },
        aurora: {
          '0%': { transform: 'translate3d(-8%, -4%, 0) scale(1)' },
          '100%': { transform: 'translate3d(8%, 6%, 0) scale(1.15)' },
        },
      },
    },
  },
  plugins: [],
}
