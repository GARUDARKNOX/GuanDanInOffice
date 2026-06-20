/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/client/**/*.{js,jsx,ts,tsx}",
    "./src/client/index.html",
  ],
  theme: {
    extend: {
      animation: {
        'bounce-in': 'bounceIn 0.4s ease-out',
        'fade-out': 'fadeOut 0.5s ease-in forwards',
        'fade-in': 'fadeIn 0.3s ease-out both',
        'bomb-shake': 'bombShake 0.5s ease-in-out',
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
      },
    },
  },
  plugins: [],
}
